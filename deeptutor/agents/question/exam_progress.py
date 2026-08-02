"""Exam progress derivation.

Progress is *derived*, never stored as a counter: the latest quiz snapshot
provides the ordered questions, and recorded judgment events (one per handled
answer, ``call_kind=exam_judgment``) mark questions as handled. The current
question is simply the first one with no judgment yet. Latest judgment per
question wins, so re-answering or re-judging a question overrides naturally.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Verdicts that mark a question as handled (advance the derived position).
HANDLED_VERDICTS = frozenset({"correct", "wrong", "skip"})


@dataclass(frozen=True)
class QuestionSet:
    """One unit of interactive quiz work: an ordered list of questions plus
    the identity judgments are scoped to (snapshot id for exams, origin turn
    id for generated quizzes — generated ids like ``q_1`` repeat across
    generation runs, so scoping is what keeps two runs from polluting each
    other)."""

    set_id: str
    questions: list[dict[str, Any]]
    source: str  # "original_paper" | "generated"
    paper_id: str = ""
    paper_display_name: str = ""
    created_at: float = 0.0


def normalize_quiz_event_question(qa_pair: dict[str, Any], index: int) -> dict[str, Any]:
    """Normalize a streamed ``qa_pair`` (generated quiz) into the snapshot
    question shape the proctor renders."""
    return {
        "question_id": str(qa_pair.get("question_id") or "").strip(),
        "question_number": str(
            qa_pair.get("source_question_number") or qa_pair.get("question_number") or index + 1
        ),
        "question_text": str(qa_pair.get("question") or qa_pair.get("question_text") or ""),
        "options": dict(qa_pair.get("options") or {}),
        "answer": str(qa_pair.get("correct_answer") or qa_pair.get("answer") or ""),
        "question_type": str(qa_pair.get("question_type") or ""),
        "explanation": str(qa_pair.get("explanation") or ""),
        "images": list(qa_pair.get("images") or []),
    }


@dataclass(frozen=True)
class ExamState:
    total: int
    answered: int
    current_index: int | None  # 0-based; None when every question is handled
    current_question: dict[str, Any] | None
    next_question: dict[str, Any] | None
    verdicts: dict[str, str] = field(default_factory=dict)

    @property
    def complete(self) -> bool:
        return self.current_question is None


def derive_exam_state(
    questions: list[dict[str, Any]],
    judgments: list[dict[str, Any]],
    question_set_id: str | None = None,
) -> ExamState:
    verdicts: dict[str, str] = {}
    for judgment in judgments:
        if question_set_id and str(judgment.get("question_set_id") or "") != question_set_id:
            continue
        question_id = str(judgment.get("question_id") or "").strip()
        verdict = str(judgment.get("verdict") or "").strip().lower()
        if question_id and verdict in HANDLED_VERDICTS:
            verdicts[question_id] = verdict

    ordered_ids = [str(q.get("question_id") or "").strip() for q in questions]
    current_index: int | None = None
    for index, question_id in enumerate(ordered_ids):
        if question_id not in verdicts:
            current_index = index
            break

    return ExamState(
        total=len(questions),
        answered=sum(1 for question_id in ordered_ids if question_id in verdicts),
        current_index=current_index,
        current_question=questions[current_index] if current_index is not None else None,
        next_question=(
            questions[current_index + 1]
            if current_index is not None and current_index + 1 < len(questions)
            else None
        ),
        verdicts=verdicts,
    )


async def resolve_latest_question_set(
    store: Any,
    session_id: str,
) -> QuestionSet | None:
    """The question set the next interactive turn should work against.

    Two kinds exist: immutable exam snapshots (Original Paper) and the
    question events of the latest quiz-generation turn. Whichever is newer
    wins; older sets stay readable through their own turns.
    """
    session_id = str(session_id or "").strip()
    if not session_id:
        return None

    candidates: list[QuestionSet] = []

    snapshot = await store.get_latest_quiz_snapshot(session_id)
    if snapshot and isinstance(snapshot.get("questions"), list) and snapshot["questions"]:
        candidates.append(
            QuestionSet(
                set_id=str(snapshot.get("snapshot_id") or ""),
                questions=list(snapshot["questions"]),
                source="original_paper",
                paper_id=str(snapshot.get("paper_id") or ""),
                paper_display_name=str(snapshot.get("paper_display_name") or ""),
                created_at=float(snapshot.get("created_at") or 0.0),
            )
        )

    quiz_turn_id = await store.get_latest_quiz_turn_id(session_id)
    if quiz_turn_id:
        events = await store.get_turn_events(quiz_turn_id)
        emitted: list[tuple[int, dict[str, Any], float]] = []
        for event in events:
            if str(event.get("type") or "") != "content":
                continue
            metadata = event.get("metadata")
            if not isinstance(metadata, dict):
                continue
            if metadata.get("call_kind") != "quiz_question_emitted":
                continue
            qa_pair = metadata.get("qa_pair")
            if not isinstance(qa_pair, dict) or not str(qa_pair.get("question") or "").strip():
                continue
            index = metadata.get("question_index")
            emitted.append(
                (
                    int(index) if isinstance(index, (int, float)) else len(emitted),
                    qa_pair,
                    float(event.get("timestamp") or event.get("created_at") or 0.0),
                )
            )
        if emitted:
            emitted.sort(key=lambda item: item[0])
            questions = [
                normalize_quiz_event_question(qa_pair, position)
                for position, (_index, qa_pair, _ts) in enumerate(emitted)
            ]
            candidates.append(
                QuestionSet(
                    set_id=str(quiz_turn_id),
                    questions=questions,
                    source="generated",
                    created_at=max(ts for _i, _q, ts in emitted),
                )
            )

    if not candidates:
        return None
    return max(candidates, key=lambda candidate: candidate.created_at)


__all__ = [
    "ExamState",
    "HANDLED_VERDICTS",
    "QuestionSet",
    "derive_exam_state",
    "normalize_quiz_event_question",
    "resolve_latest_question_set",
]
