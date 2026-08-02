"""Bounded, access-checked context for one GPT-Live voice session.

The snapshot is sent once as Frameless V3 ``initial_items``. It deliberately
contains only recent session text, selected-resource labels, and small retrieval
results based on the last existing question. New retrieval and all exam work
must be delegated to ChatOrchestrator.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from deeptutor.services.session.context_builder import count_tokens
from deeptutor.services.session.protocol import SessionStoreProtocol
from deeptutor.services.voice.capability_context import project_voice_capability_context

MAX_CONTEXT_ITEMS = 24
MAX_CONTEXT_TOKENS = 6_144
MAX_CONTEXT_ITEM_TOKENS = 1_536
MAX_KNOWLEDGE_BASES = 8
MAX_RECENT_MESSAGES = 8

# Codex-model prompt contract (issue #33): delegation is a prompt bias, not
# an enforceable protocol — OpenAI's own stack has no force-delegation knob.
# So the instructions steer toward delegation while making a direct answer
# harmless: brief acknowledgments are fine, judging/teaching is not. The
# backend commits every finalized transcript deterministically, so nothing
# depends on the model obeying this prompt.
_DELEGATE_INSTRUCTIONS = (
    "You are DeepTutor's voice surface: the conversational front-end of one unified "
    "tutor whose reasoning, memory, knowledge bases, and exam state live in the "
    "DeepTutor backend. For any request that needs knowledge, reasoning, grading, "
    "or state — including short exam answers such as A, B, C, D, yes, or no, plus "
    "corrections, hint, skip, repeat, and next-question requests — create a client "
    "delegation for that utterance and then wait. The backend's reply arrives as "
    "appended speakable text: vocalize it verbatim in its original language without "
    "adding, omitting, paraphrasing, or translating content. If a request is clearly "
    "self-contained, you may respond directly, but keep it to a brief acknowledgment: "
    "never judge answers, never reveal solutions, never advance an exam or quiz on "
    "your own. Do not initiate a greeting before a finalized user turn. When the user "
    "speaks while you are vocalizing appended text, immediately stop speaking and "
    "treat the interruption as a new completed user turn."
)


class RealtimeContextError(RuntimeError):
    """Credential-free context failure safe for the Realtime client boundary."""


class _PaperService(Protocol):
    def get_library(self, library_id: str) -> Any: ...

    def get_paper(self, paper_id: str) -> Any: ...


@dataclass(frozen=True, slots=True)
class RealtimeContextRequest:
    session_id: str | None = None
    capability: str = "chat"
    knowledge_bases: tuple[str, ...] = ()
    language: str = "en"
    paper_library_id: str = ""
    paper_id: str = ""
    exam_mode: bool = False
    page_context: str = ""
    question_context: str = ""

    @classmethod
    def from_payload(
        cls,
        payload: dict[str, Any] | None,
        *,
        session_id: str | None = None,
    ) -> "RealtimeContextRequest":
        payload = payload if isinstance(payload, dict) else {}
        raw_kbs = payload.get("knowledge_bases")
        if not isinstance(raw_kbs, list):
            raw_kbs = []
        knowledge_bases: list[str] = []
        for value in raw_kbs:
            name = str(value or "").strip()
            if not name or name in knowledge_bases:
                continue
            if len(name) > 256 or len(knowledge_bases) >= MAX_KNOWLEDGE_BASES:
                raise RealtimeContextError("Realtime context selection is invalid or too large.")
            knowledge_bases.append(name)
        capability = str(payload.get("capability") or "chat").strip() or "chat"
        language = str(payload.get("language") or "en").strip() or "en"
        paper_library_id = str(payload.get("paper_library_id") or "").strip()
        paper_id = str(payload.get("paper_id") or "").strip()
        exam_mode = payload.get("exam_mode") is True
        page_context = str(payload.get("page_context") or "").strip()
        question_context = str(payload.get("question_context") or "").strip()
        values = (capability, language, paper_library_id, paper_id, session_id or "")
        if any(len(value) > 256 for value in values):
            raise RealtimeContextError("Realtime context selection is invalid or too large.")
        if len(page_context) > 512 or len(question_context) > 8_000:
            raise RealtimeContextError("Realtime context selection is invalid or too large.")
        return cls(
            session_id=str(session_id or "").strip() or None,
            capability=capability,
            knowledge_bases=tuple(knowledge_bases),
            language=language,
            paper_library_id=paper_library_id,
            paper_id=paper_id,
            exam_mode=exam_mode,
            page_context=page_context,
            question_context=question_context,
        )


@dataclass(frozen=True, slots=True)
class RealtimeContextSnapshot:
    session_id: str
    capability: str
    language: str
    knowledge_bases: tuple[str, ...]
    direct_output_allowed: bool
    instructions: str = field(repr=False)
    initial_items: tuple[dict[str, str], ...] = field(repr=False)
    source_labels: tuple[str, ...] = ()
    exam_mode: bool = False

    def public_metadata(self) -> dict[str, Any]:
        """Return content-free metadata suitable for the browser."""
        return {
            "item_count": len(self.initial_items),
            "source_count": len(self.source_labels),
            "direct_output_allowed": self.direct_output_allowed,
            "exam_mode": self.exam_mode,
        }


def _truncate_to_token_budget(text: str, budget: int) -> str:
    if count_tokens(text) <= budget:
        return text
    low, high = 0, len(text)
    while low < high:
        middle = (low + high + 1) // 2
        if count_tokens(text[:middle]) <= budget:
            low = middle
        else:
            high = middle - 1
    return text[:low].rstrip()


def _bounded_items(candidates: list[tuple[str, str]]) -> tuple[dict[str, str], ...]:
    prepared = [(role, str(text or "").strip()) for role, text in candidates]
    prepared = [(role, text) for role, text in prepared if text]
    if len(prepared) > MAX_CONTEXT_ITEMS:
        raise RealtimeContextError("Realtime Context Snapshot has too many items.")

    items: list[dict[str, str]] = []
    remaining_tokens = MAX_CONTEXT_TOKENS
    for index, (role, text) in enumerate(prepared):
        remaining_items = len(prepared) - index
        item_budget = min(
            MAX_CONTEXT_ITEM_TOKENS,
            remaining_tokens // remaining_items,
        )
        text = _truncate_to_token_budget(text, item_budget)
        tokens = count_tokens(text)
        if text:
            items.append({"role": role, "text": text})
            remaining_tokens -= tokens
    return tuple(items)


async def _default_retrieve(query: str, kb_ref: str) -> str:
    from deeptutor.tools.rag_tool import rag_search

    result = await rag_search(query=query, kb_name=kb_ref)
    return str(result.get("answer") or result.get("content") or "").strip()


def _default_resolve_kb(kb_ref: str) -> Any:
    from deeptutor.multi_user.knowledge_access import resolve_kb

    return resolve_kb(kb_ref, require_write=False)


def _default_paper_service() -> _PaperService:
    from deeptutor.services.paper_library import PaperLibraryService

    return PaperLibraryService()


async def build_realtime_context_snapshot(
    store: SessionStoreProtocol,
    request: RealtimeContextRequest,
    *,
    resolve_kb: Callable[[str], Any] = _default_resolve_kb,
    retrieve: Callable[[str, str], Awaitable[str]] = _default_retrieve,
    paper_service: _PaperService | None = None,
) -> RealtimeContextSnapshot:
    """Build one bounded snapshot without logging or persisting its full text."""
    session = await store.ensure_session(request.session_id)
    session_id = str(session.get("session_id") or session.get("id") or "").strip()
    if not session_id:
        raise RealtimeContextError("Realtime context session could not be created.")

    try:
        messages = await store.get_messages_for_context(session_id)
        rich_messages = await store.get_messages(session_id)
    except Exception as exc:
        raise RealtimeContextError("Realtime conversation context is unavailable.") from exc

    capability = request.capability or "chat"
    exam_mode = request.exam_mode or capability == "exam"
    branch_ids = {
        str(message.get("id"))
        for message in messages
        if message.get("id") is not None
    }
    projection_messages = (
        [message for message in rich_messages if str(message.get("id")) in branch_ids]
        if branch_ids
        else rich_messages
    )
    instructions = _DELEGATE_INSTRUCTIONS
    candidates: list[tuple[str, str]] = [
        (
            "developer",
            "Context policy: this is a bounded snapshot, not the complete workspace. "
            "It may improve transcription and handoff context, but never answer "
            "source-dependent questions from it; route those to DeepTutor.",
        )
    ]
    candidates.extend(
        ("developer", text)
        for text in project_voice_capability_context(projection_messages, capability)
    )
    source_labels: list[str] = []
    direct_output_allowed = False

    summary = str(session.get("compressed_summary") or "").strip()
    if summary:
        candidates.append(("developer", f"Conversation summary:\n{summary}"))

    recent_messages = []
    for message in messages[-MAX_RECENT_MESSAGES:]:
        role = str(message.get("role") or "").strip()
        content = str(message.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        recent_messages.append((role, content))
    candidates.extend(recent_messages)
    if request.page_context:
        candidates.append(("developer", f"Current page context:\n{request.page_context}"))
    if request.question_context:
        candidates.append(("developer", f"Current question context:\n{request.question_context}"))

    if exam_mode:
        if not request.paper_library_id:
            raise RealtimeContextError("Exam Realtime context requires a Paper Library.")
        papers = paper_service or _default_paper_service()
        try:
            library = papers.get_library(request.paper_library_id)
            source_labels.append(f"paper_library:{request.paper_library_id}")
            details = [f"Selected Paper Library: {getattr(library, 'name', '')}"]
            description = str(getattr(library, "description", "") or "").strip()
            if description:
                details.append(f"Description: {description}")
            if request.paper_id:
                paper = papers.get_paper(request.paper_id)
                source_labels.append(f"paper:{request.paper_id}")
                details.append(f"Selected paper: {getattr(paper, 'display_name', '')}")
                details.append(f"Paper status: {getattr(paper, 'status', '')}")
            details.append(
                "Exam policy: route exam utterances through DeepTutor; brief "
                "acknowledgments are fine, but never judge answers, reveal "
                "solutions, or advance the exam yourself."
            )
            details.append(
                "Exam barge-in policy: speech during or immediately after playback is a "
                "new exam utterance. Delegate it; never judge the answer or advance "
                "the exam on your own."
            )
            candidates.append(("developer", "\n".join(details)))
        except Exception as exc:
            raise RealtimeContextError("Selected exam context is not accessible.") from exc
    else:
        last_user_query = next(
            (content for role, content in reversed(recent_messages) if role == "user"),
            "",
        )
        preload_query = last_user_query or (
            "請整理此知識庫最重要的核心重點。"
            if request.language.casefold().startswith("zh")
            else "Summarize the most important key points in this knowledge base."
        )
        for kb_ref in request.knowledge_bases:
            try:
                resource = resolve_kb(kb_ref)
            except Exception as exc:
                raise RealtimeContextError(
                    "Selected knowledge context is not accessible."
                ) from exc
            resource_id = str(getattr(resource, "id", "") or kb_ref)
            resource_name = str(getattr(resource, "name", "") or kb_ref)
            source_labels.append(f"knowledge_base:{resource_name}")
            try:
                excerpt = (await retrieve(preload_query, resource_id)).strip()
            except Exception:
                excerpt = ""
            if excerpt:
                retrieved_context = (
                    f'Retrieved snapshot key points from Knowledge Base "{resource_name}" '
                    f'for the initial realtime context:\n{excerpt}\nSource: {resource_id}'
                )
                candidates.append(
                    (
                        "developer",
                        _truncate_to_token_budget(
                            retrieved_context,
                            MAX_CONTEXT_ITEM_TOKENS,
                        ),
                    )
                )
            else:
                candidates.append(
                    (
                        "developer",
                        f'Knowledge Base "{resource_name}" was selected but no excerpt was '
                        "available in this snapshot; delegation is required for source-dependent questions.",
                    )
                )

    try:
        updated = await store.update_session_preferences(
            session_id,
            {
                "capability": capability,
                "knowledge_bases": list(request.knowledge_bases),
                "language": request.language,
            },
        )
    except Exception as exc:
        raise RealtimeContextError("Realtime session preferences could not be saved.") from exc
    if not updated:
        raise RealtimeContextError("Realtime session preferences could not be saved.")

    initial_items = _bounded_items(candidates)
    if not initial_items:
        raise RealtimeContextError("Realtime Context Snapshot is empty.")
    return RealtimeContextSnapshot(
        session_id=session_id,
        capability=capability,
        language=request.language,
        knowledge_bases=request.knowledge_bases,
        direct_output_allowed=direct_output_allowed,
        instructions=instructions,
        initial_items=initial_items,
        source_labels=tuple(source_labels),
        exam_mode=exam_mode,
    )


__all__ = [
    "MAX_CONTEXT_ITEMS",
    "MAX_CONTEXT_TOKENS",
    "RealtimeContextError",
    "RealtimeContextRequest",
    "RealtimeContextSnapshot",
    "build_realtime_context_snapshot",
]
