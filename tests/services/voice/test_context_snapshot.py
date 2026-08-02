from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from deeptutor.services.session.context_builder import count_tokens
from deeptutor.services.voice.context_snapshot import (
    MAX_CONTEXT_ITEM_TOKENS,
    MAX_CONTEXT_ITEMS,
    MAX_CONTEXT_TOKENS,
    RealtimeContextError,
    RealtimeContextRequest,
    build_realtime_context_snapshot,
)


class _Store:
    def __init__(self) -> None:
        self.preferences: dict[str, object] = {}
        self.session = {
            "id": "session-1",
            "session_id": "session-1",
            "compressed_summary": "The learner is reviewing photosynthesis.",
        }
        self.messages = [
            {"role": "user", "content": "Earlier unrelated question"},
            {"role": "assistant", "content": "Earlier answer"},
            {"role": "user", "content": "How does chlorophyll capture light?"},
        ]

    async def ensure_session(self, session_id: str | None = None):
        assert session_id in {None, "session-1"}
        return self.session

    async def get_messages_for_context(self, session_id: str):
        assert session_id == "session-1"
        return list(self.messages)

    async def get_messages(self, session_id: str):
        assert session_id == "session-1"
        return list(self.messages)

    async def update_session_preferences(self, session_id: str, preferences: dict):
        assert session_id == "session-1"
        self.preferences.update(preferences)
        return True


@pytest.mark.asyncio
async def test_snapshot_is_bounded_access_checked_and_retrieves_prior_context() -> None:
    store = _Store()
    retrievals: list[tuple[str, str]] = []

    def resolve_kb(name: str):
        assert name == "biology"
        return SimpleNamespace(
            id="user:kb:biology",
            name="biology",
            base_dir=Path("/safe/user/kb"),
        )

    async def retrieve(query: str, kb_ref: str) -> str:
        retrievals.append((query, kb_ref))
        return "Chlorophyll absorbs mostly red and blue wavelengths."

    snapshot = await build_realtime_context_snapshot(
        store,
        RealtimeContextRequest(
            session_id="session-1",
            capability="chat",
            knowledge_bases=("biology",),
            language="en",
            page_context="workspace chat",
            question_context="What is a cell?",
        ),
        resolve_kb=resolve_kb,
        retrieve=retrieve,
    )

    assert snapshot.session_id == "session-1"
    assert snapshot.direct_output_allowed is False
    assert snapshot.source_labels == ("knowledge_base:biology",)
    assert retrievals == [("How does chlorophyll capture light?", "user:kb:biology")]
    public = snapshot.public_metadata()
    assert "initial_items" not in public
    assert "Chlorophyll" not in str(public)
    serialized = "\n".join(item["text"] for item in snapshot.initial_items)
    assert "learner is reviewing photosynthesis" in serialized
    assert "Chlorophyll absorbs mostly red and blue wavelengths" in serialized
    assert "Current page context" in serialized
    assert "Current question context" in serialized
    assert "delegation" in snapshot.instructions.lower()
    assert "EVERY completed user utterance" in snapshot.instructions
    assert "NEVER answer" in snapshot.instructions
    assert len(snapshot.initial_items) <= MAX_CONTEXT_ITEMS
    assert sum(count_tokens(item["text"]) for item in snapshot.initial_items) <= MAX_CONTEXT_TOKENS
    assert store.preferences == {
        "capability": "chat",
        "knowledge_bases": ["biology"],
        "language": "en",
    }


@pytest.mark.asyncio
async def test_snapshot_preloads_key_points_without_a_prior_question() -> None:
    store = _Store()
    store.messages = []
    retrievals: list[str] = []

    def resolve_kb(name: str):
        assert name == "biology"
        return SimpleNamespace(id="user:kb:biology", name="biology")

    async def retrieve(query: str, kb_ref: str) -> str:
        retrievals.append(query)
        assert kb_ref == "user:kb:biology"
        return "Photosynthesis converts light energy into chemical energy."

    snapshot = await build_realtime_context_snapshot(
        store,
        RealtimeContextRequest(
            session_id="session-1",
            knowledge_bases=("biology",),
            language="en",
        ),
        resolve_kb=resolve_kb,
        retrieve=retrieve,
    )

    assert retrievals == ["Summarize the most important key points in this knowledge base."]
    assert "key points" in "\n".join(item["text"] for item in snapshot.initial_items)
    assert snapshot.direct_output_allowed is False


@pytest.mark.asyncio
async def test_snapshot_truncates_oversized_retrieved_key_points() -> None:
    store = _Store()
    store.messages = []

    def resolve_kb(name: str):
        return SimpleNamespace(id=f"user:kb:{name}", name=name)

    async def retrieve(query: str, kb_ref: str) -> str:
        del query, kb_ref
        return "important fact " * 5_000

    snapshot = await build_realtime_context_snapshot(
        store,
        RealtimeContextRequest(
            session_id="session-1",
            knowledge_bases=("biology",),
        ),
        resolve_kb=resolve_kb,
        retrieve=retrieve,
    )

    assert snapshot.direct_output_allowed is False
    assert all(
        count_tokens(item["text"]) <= MAX_CONTEXT_ITEM_TOKENS
        for item in snapshot.initial_items
    )


@pytest.mark.asyncio
async def test_snapshot_requires_delegation_when_selected_kb_retrieval_fails() -> None:
    store = _Store()

    def resolve_kb(name: str):
        return SimpleNamespace(id=f"user:kb:{name}", name=name, base_dir=Path("/safe"))

    async def fail_retrieval(query: str, kb_ref: str) -> str:
        raise RuntimeError("retrieval failed")

    snapshot = await build_realtime_context_snapshot(
        store,
        RealtimeContextRequest(
            session_id="session-1",
            capability="chat",
            knowledge_bases=("biology",),
        ),
        resolve_kb=resolve_kb,
        retrieve=fail_retrieval,
    )
    assert snapshot.direct_output_allowed is False
    assert "delegation is required" in "\n".join(
        item["text"] for item in snapshot.initial_items
    )


@pytest.mark.asyncio
async def test_exam_snapshot_projects_question_index_without_answer_material() -> None:
    store = _Store()
    store.messages = [
        {
            "id": 1,
            "role": "assistant",
            "content": "",
            "capability": "exam",
            "events": [
                {
                    "type": "content",
                    "metadata": {
                        "call_kind": "quiz_question_emitted",
                        "question_index": 0,
                        "qa_pair": {
                            "question_id": "q-1",
                            "question": "Secret question stem",
                            "options": {"A": "First", "B": "Second"},
                            "correct_answer": "B",
                            "explanation": "Secret explanation",
                        },
                    },
                },
                {
                    "type": "content",
                    "metadata": {
                        "call_kind": "quiz_question_emitted",
                        "question_index": 1,
                        "qa_pair": {
                            "question_id": "q-2",
                            "question": "Another secret stem",
                            "correct_answer": "42",
                        },
                    },
                },
            ],
        }
    ]

    class _Papers:
        def get_library(self, library_id: str):
            assert library_id == "library-1"
            return SimpleNamespace(name="Calculus exams", description="Private exams")

        def get_paper(self, paper_id: str):
            assert paper_id == "paper-1"
            return SimpleNamespace(display_name="Midterm A", status="ready")

    async def should_not_retrieve(query: str, kb_ref: str) -> str:
        raise AssertionError((query, kb_ref))

    snapshot = await build_realtime_context_snapshot(
        store,
        RealtimeContextRequest(
            session_id="session-1",
            capability="deep_question",
            exam_mode=True,
            knowledge_bases=(),
            language="zh-TW",
            paper_library_id="library-1",
            paper_id="paper-1",
        ),
        retrieve=should_not_retrieve,
        paper_service=_Papers(),
    )

    assert snapshot.direct_output_allowed is False
    assert snapshot.source_labels == (
        "paper_library:library-1",
        "paper:paper-1",
    )
    assert "EVERY" in snapshot.instructions
    assert "speaks while you are vocalizing" in snapshot.instructions
    assert "short exam answers" in snapshot.instructions
    assert "Barge-in is NEVER permission" in snapshot.instructions
    assert "delegation" in snapshot.instructions.lower()
    serialized = "\n".join(item["text"] for item in snapshot.initial_items)
    assert "Calculus exams" in serialized
    assert "Midterm A" in serialized
    assert "Exam barge-in policy" in serialized
    assert "Delegate it exactly once" in serialized
    assert "2 questions numbered 1 through 2" in serialized
    assert "Secret question stem" not in serialized
    assert "correct_answer" not in serialized
    assert "Secret explanation" not in serialized


@pytest.mark.asyncio
async def test_snapshot_truncates_long_recent_messages_when_voice_restarts() -> None:
    store = _Store()
    store.messages = [
        {
            "role": "user" if index % 2 == 0 else "assistant",
            "content": "很長的歷史回答" * 5_000,
        }
        for index in range(8)
    ]

    snapshot = await build_realtime_context_snapshot(
        store,
        RealtimeContextRequest(session_id="session-1"),
    )

    assert len(snapshot.initial_items) == 10
    assert all(
        count_tokens(item["text"]) <= MAX_CONTEXT_ITEM_TOKENS
        for item in snapshot.initial_items
    )
    assert sum(
        count_tokens(item["text"]) for item in snapshot.initial_items
    ) <= MAX_CONTEXT_TOKENS


@pytest.mark.asyncio
async def test_snapshot_fails_closed_for_unavailable_selected_knowledge() -> None:
    store = _Store()

    def deny(_: str):
        raise RuntimeError("private path and secret details")

    with pytest.raises(RealtimeContextError, match="not accessible") as caught:
        await build_realtime_context_snapshot(
            store,
            RealtimeContextRequest(
                session_id="session-1",
                capability="chat",
                knowledge_bases=("forbidden",),
                language="en",
            ),
            resolve_kb=deny,
        )
    assert "private path" not in str(caught.value)
    assert "secret" not in str(caught.value)
