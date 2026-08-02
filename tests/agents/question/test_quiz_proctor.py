"""Proctor mode for generated quizzes (deep_question without a snapshot).

Generated questions only exist as quiz_question_emitted turn events, and
their ids (q_1, q_2, …) repeat across generation runs. These tests prove the
resolver rebuilds the latest question set from events and that judgment
scoping keeps two runs isolated.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from deeptutor.agents.question.capability import DeepQuestionCapability
from deeptutor.agents.question.exam_progress import (
    derive_exam_state,
    resolve_latest_question_set,
)
from deeptutor.core.context import UnifiedContext
from deeptutor.core.stream import StreamEventType
from deeptutor.core.stream_bus import StreamBus
from deeptutor.services.session.sqlite_store import SQLiteSessionStore

_QUIZ_V1 = [
    {"question_id": "q_1", "question": "2+2=?", "question_type": "choice",
     "options": {"A": "3", "B": "4"}, "correct_answer": "B", "explanation": "math"},
    {"question_id": "q_2", "question": "3+3=?", "question_type": "choice",
     "options": {"A": "6", "B": "7"}, "correct_answer": "A", "explanation": "math"},
]
_QUIZ_V2 = [
    {"question_id": "q_1", "question": "首都?", "question_type": "short_answer",
     "options": {}, "correct_answer": "Paris", "explanation": "geo"},
]


class _FakeProctorAgent:
    scripted: list[tuple[str, str]] = []
    seen: list[dict[str, Any]] = []

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        pass

    def set_trace_callback(self, _callback: Any) -> None:
        pass

    async def process(self, **kwargs: Any) -> tuple[str, str]:
        self.seen.append(kwargs)
        return self.scripted.pop(0)


@pytest.fixture(autouse=True)
def _reset_fake_agent() -> None:
    _FakeProctorAgent.scripted = []
    _FakeProctorAgent.seen = []


def _patch_environment(monkeypatch: pytest.MonkeyPatch, store: SQLiteSessionStore) -> None:
    monkeypatch.setattr(
        "deeptutor.agents.question.agents.proctor_agent.ProctorAgent", _FakeProctorAgent
    )
    monkeypatch.setattr("deeptutor.services.session.get_sqlite_session_store", lambda: store)
    monkeypatch.setattr(
        "deeptutor.services.llm.config.get_llm_config",
        lambda: SimpleNamespace(model="test", api_key="", base_url=None, api_version=None),
    )


async def _seed_quiz_turn(
    store: SQLiteSessionStore, session_id: str, questions: list[dict[str, Any]]
) -> str:
    """Persist a quiz-generation turn the way the pipeline streams it."""
    turn = await store.create_turn(session_id, "deep_question")
    for index, qa in enumerate(questions):
        await store.append_turn_event(
            turn["id"],
            {
                "type": "content",
                "source": "deep_question",
                "stage": "quizzing",
                "metadata": {
                    "call_kind": "quiz_question_emitted",
                    "question_index": index,
                    "total_questions": len(questions),
                    "qa_pair": qa,
                },
            },
        )
    await store.update_turn_status(turn["id"], "completed", "")
    return turn["id"]


def _proctor_context(session_id: str, message: str, capability: str = "deep_question") -> UnifiedContext:
    return UnifiedContext(
        session_id=session_id,
        user_message=message,
        active_capability=capability,
        config_overrides={"mode": "proctor"},
        language="zh",
        metadata={"turn_id": f"turn-{message}"},
    )


@pytest.mark.asyncio
async def test_resolver_rebuilds_question_set_from_quiz_events(tmp_path) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    session = await store.ensure_session(None)
    turn_id = await _seed_quiz_turn(store, session["id"], _QUIZ_V1)

    question_set = await resolve_latest_question_set(store, session["id"])
    assert question_set is not None
    assert question_set.source == "generated"
    assert question_set.set_id == turn_id
    assert [q["question_id"] for q in question_set.questions] == ["q_1", "q_2"]
    # Normalized into the snapshot shape the proctor renders.
    first = question_set.questions[0]
    assert first["question_text"] == "2+2=?"
    assert first["answer"] == "B"
    assert first["options"] == {"A": "3", "B": "4"}
    assert first["question_number"] == "1"


@pytest.mark.asyncio
async def test_resolver_prefers_newer_generated_quiz_over_older_snapshot(tmp_path) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    session = await store.ensure_session(None)
    session_id = session["id"]
    # Older exam snapshot.
    exam_turn = await store.create_turn(session_id, "exam")
    await store.create_quiz_snapshot(
        session_id,
        exam_turn["id"],
        {
            "source": {"source_type": "original_paper", "paper_id": "paper-1"},
            "questions": [
                {
                    "question_id": "old-q",
                    "question_number": "1",
                    "question_text": "old",
                    "options": {},
                    "answer": "x",
                    "question_type": "concept",
                    "images": [],
                }
            ],
        },
    )
    await store.update_turn_status(exam_turn["id"], "completed", "")
    quiz_turn_id = await _seed_quiz_turn(store, session_id, _QUIZ_V1)

    question_set = await resolve_latest_question_set(store, session_id)
    assert question_set is not None
    assert question_set.source == "generated"
    assert question_set.set_id == quiz_turn_id


def test_derive_scopes_judgments_to_question_set() -> None:
    """Same q_1 id in two generation runs: judgments for run 1 must not mark
    run 2's q_1 as handled."""
    questions_v2 = [
        {"question_id": "q_1", "question_number": "1", "question_text": "首都?"},
    ]
    judgments = [
        {"question_id": "q_1", "verdict": "correct", "question_set_id": "turn-run-1"},
    ]
    state = derive_exam_state(questions_v2, judgments, question_set_id="turn-run-2")
    assert state.current_index == 0
    assert state.answered == 0


@pytest.mark.asyncio
async def test_proctor_works_on_generated_quiz_and_scopes_judgments(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    _patch_environment(monkeypatch, store)
    session = await store.ensure_session(None)
    session_id = session["id"]
    run_1 = await _seed_quiz_turn(store, session_id, _QUIZ_V1)

    # Turn 1: answer run-1's first question correctly.
    _FakeProctorAgent.scripted = [("correct", "答對了")]
    bus = StreamBus()
    await DeepQuestionCapability().run(_proctor_context(session_id, "答案是 B"), bus)
    judgment = next(
        e for e in bus._history
        if e.type is StreamEventType.PROGRESS
        and e.metadata.get("call_kind") == "exam_judgment"
    )
    assert judgment.metadata["question_set_id"] == run_1
    assert judgment.metadata["verdict"] == "correct"

    # Persist the judgment (turn_runtime does this in production).
    judge_turn = await store.create_turn(session_id, "deep_question")
    await store.append_turn_event(
        judge_turn["id"],
        {
            "type": "progress",
            "source": "deep_question",
            "metadata": dict(judgment.metadata),
        },
    )
    await store.update_turn_status(judge_turn["id"], "completed", "")

    # Regenerate: a NEW quiz run reusing the same q_1 id.
    await _seed_quiz_turn(store, session_id, _QUIZ_V2)

    # Proctor must face run-2's q_1, not treat it as already answered.
    _FakeProctorAgent.scripted = [("none", "請作答")]
    bus2 = StreamBus()
    await DeepQuestionCapability().run(_proctor_context(session_id, "嗯"), bus2)
    shown = _FakeProctorAgent.seen[-1]
    assert shown["current_question"]["question_id"] == "q_1"
    assert shown["current_question"]["question_text"] == "首都?"
    assert shown["current_question"]["answer"] == "Paris"


@pytest.mark.asyncio
async def test_proctor_without_any_quiz_errors_friendly(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    _patch_environment(monkeypatch, store)
    session = await store.ensure_session(None)

    bus = StreamBus()
    await DeepQuestionCapability().run(_proctor_context(session["id"], "你好"), bus)
    errors = [e for e in bus._history if e.type is StreamEventType.ERROR]
    assert errors and "Start one first" in errors[0].content
