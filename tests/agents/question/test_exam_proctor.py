"""Exam proctor mode tests.

The proctor judges each utterance against the *derived* current question and
records judgments as progress events. Progress itself is never stored as a
counter — these tests prove advancement falls out of the recorded judgments.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from deeptutor.agents.question.agents.proctor_agent import parse_proctor_reply
from deeptutor.agents.question.capability import DeepQuestionCapability, ExamCapability
from deeptutor.agents.question.exam_progress import derive_exam_state
from deeptutor.core.context import UnifiedContext
from deeptutor.core.stream import StreamEventType
from deeptutor.core.stream_bus import StreamBus
from deeptutor.services.session.sqlite_store import SQLiteSessionStore

_QUESTIONS = [
    {
        "question_id": "q-1",
        "question_number": "1",
        "question_text": "2+2=?",
        "options": {"A": "3", "B": "4"},
        "answer": "B",
        "question_type": "choice",
        "images": [],
    },
    {
        "question_id": "q-2",
        "question_number": "2",
        "question_text": "Capital of France?",
        "options": {},
        "answer": "Paris",
        "question_type": "short_answer",
        "images": [],
    },
]


class _FakeProctorAgent:
    """Queue of scripted (verdict, reply) turns; records what it was shown."""

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


def _patch_environment(
    monkeypatch: pytest.MonkeyPatch, store: SQLiteSessionStore
) -> None:
    monkeypatch.setattr(
        "deeptutor.agents.question.agents.proctor_agent.ProctorAgent", _FakeProctorAgent
    )
    monkeypatch.setattr(
        "deeptutor.services.session.get_sqlite_session_store", lambda: store
    )
    monkeypatch.setattr(
        "deeptutor.services.llm.config.get_llm_config",
        lambda: SimpleNamespace(model="test", api_key="", base_url=None, api_version=None),
    )


async def _seed_exam(store: SQLiteSessionStore) -> tuple[str, str]:
    session = await store.ensure_session(None)
    session_id = session["id"]
    turn = await store.create_turn(session_id, "exam")
    snapshot = await store.create_quiz_snapshot(
        session_id,
        turn["id"],
        {
            "source": {"source_type": "original_paper", "paper_id": "paper-1"},
            "questions": list(_QUESTIONS),
        },
    )
    await store.update_turn_status(turn["id"], "completed", "")
    return session_id, snapshot["snapshot_id"]


def _proctor_context(session_id: str, message: str) -> UnifiedContext:
    return UnifiedContext(
        session_id=session_id,
        user_message=message,
        active_capability="exam",
        config_overrides={"mode": "proctor"},
        language="zh",
        metadata={"turn_id": f"turn-{message}"},
    )


async def _persist_progress_events(
    store: SQLiteSessionStore, session_id: str, bus: StreamBus
) -> None:
    """Mirror what turn_runtime does in production: persist streamed events
    into turn_events so the next turn derives from them."""
    progress = [
        e for e in _events(bus) if e.type is StreamEventType.PROGRESS
    ]
    if not progress:
        return
    turn = await store.create_turn(session_id, "exam")
    for event in progress:
        await store.append_turn_event(
            turn["id"],
            {
                "type": "progress",
                "source": event.source,
                "stage": event.stage,
                "metadata": dict(event.metadata),
            },
        )
    await store.update_turn_status(turn["id"], "completed", "")


def _events(bus: StreamBus) -> list:
    return list(bus._history)


# ── parse_proctor_reply ────────────────────────────────────────────────


def test_parse_verdict_line() -> None:
    assert parse_proctor_reply("VERDICT: correct\n答對了！") == ("correct", "答對了！")


def test_parse_no_verdict_defaults_none() -> None:
    assert parse_proctor_reply("只是閒聊") == ("none", "只是閒聊")


def test_parse_case_insensitive_and_whitespace() -> None:
    assert parse_proctor_reply("  VERDICT:  Wrong \n再想想。") == ("wrong", "再想想。")


# ── derive_exam_state ──────────────────────────────────────────────────


def test_derive_current_is_first_unanswered() -> None:
    state = derive_exam_state(_QUESTIONS, [])
    assert state.current_index == 0
    assert state.next_question["question_id"] == "q-2"
    assert not state.complete


def test_derive_latest_judgment_wins_and_advances() -> None:
    judgments = [
        {"question_id": "q-1", "verdict": "wrong"},
        {"question_id": "q-1", "verdict": "correct"},
    ]
    state = derive_exam_state(_QUESTIONS, judgments)
    assert state.verdicts["q-1"] == "correct"
    assert state.current_index == 1
    assert state.next_question is None


def test_derive_skip_counts_as_handled_and_completion() -> None:
    state = derive_exam_state(
        _QUESTIONS,
        [
            {"question_id": "q-1", "verdict": "skip"},
            {"question_id": "q-2", "verdict": "correct"},
        ],
    )
    assert state.complete
    assert state.answered == 2


# ── capability proctor path ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_proctor_without_snapshot_errors_friendly(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    _patch_environment(monkeypatch, store)
    session = await store.ensure_session(None)

    bus = StreamBus()
    await ExamCapability().run(_proctor_context(session["id"], "你好"), bus)

    errors = [e for e in _events(bus) if e.type is StreamEventType.ERROR]
    assert errors and "Start one first" in errors[0].content


@pytest.mark.asyncio
async def test_proctor_correct_records_judgment_and_next_turn_advances(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    _patch_environment(monkeypatch, store)
    session_id, _set_id = await _seed_exam(store)
    _FakeProctorAgent.scripted = [("correct", "答對了！下一題：法國首都？")]

    bus = StreamBus()
    await ExamCapability().run(_proctor_context(session_id, "答案是 B"), bus)

    events = _events(bus)
    judgments = [
        e for e in events
        if e.type is StreamEventType.PROGRESS
        and e.metadata.get("call_kind") == "exam_judgment"
    ]
    assert len(judgments) == 1
    assert judgments[0].metadata["question_id"] == "q-1"
    assert judgments[0].metadata["verdict"] == "correct"

    contents = [e for e in events if e.type is StreamEventType.CONTENT]
    assert contents[-1].content == "答對了！下一題：法國首都？"
    assert contents[-1].metadata["call_kind"] == "exam_proctor_reply"
    assert contents[-1].metadata["question_index"] == 0

    # The judgment event is what the next turn derives from — prove the fake
    # agent is shown q-2 on the following turn with no extra wiring.
    _FakeProctorAgent.scripted = [("none", "請作答第二題")]
    await _persist_progress_events(store, session_id, bus)
    bus2 = StreamBus()
    await ExamCapability().run(_proctor_context(session_id, "嗯…"), bus2)
    shown = _FakeProctorAgent.seen[-1]
    assert shown["current_question"]["question_id"] == "q-2"
    assert shown["next_question"] is None

    result = next(e for e in events if e.type is StreamEventType.RESULT)
    assert result.metadata["mode"] == "proctor"
    assert result.metadata["verdict"] == "correct"


@pytest.mark.asyncio
async def test_proctor_wrong_explains_and_current_stays(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    _patch_environment(monkeypatch, store)
    session_id, _set_id = await _seed_exam(store)
    _FakeProctorAgent.scripted = [("wrong", "不對，2+2 是 4 因為…")]

    bus = StreamBus()
    await ExamCapability().run(_proctor_context(session_id, "答案是 A"), bus)

    events = _events(bus)
    judgment = next(
        e for e in events
        if e.type is StreamEventType.PROGRESS
        and e.metadata.get("call_kind") == "exam_judgment"
    )
    assert judgment.metadata["verdict"] == "wrong"

    # Wrong counts as handled: the derived position advances, while the
    # *retry vs. advance* policy lives in the prompt — derivation only
    # guarantees latest-wins.
    await _persist_progress_events(store, session_id, bus)
    state = derive_exam_state(
        _QUESTIONS, await store.list_exam_judgments(session_id)
    )
    assert state.verdicts["q-1"] == "wrong"
    assert state.current_index == 1


@pytest.mark.asyncio
async def test_proctor_non_answer_turn_records_no_judgment(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    _patch_environment(monkeypatch, store)
    session_id, _set_id = await _seed_exam(store)
    _FakeProctorAgent.scripted = [("none", "題目是：2+2 等於多少？")]

    bus = StreamBus()
    await ExamCapability().run(_proctor_context(session_id, "再念一次題目"), bus)

    assert not [
        e for e in _events(bus)
        if e.type is StreamEventType.PROGRESS
        and e.metadata.get("call_kind") == "exam_judgment"
    ]
    assert await store.list_exam_judgments(session_id) == []


@pytest.mark.asyncio
async def test_proctor_reports_completion_when_all_handled(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    _patch_environment(monkeypatch, store)
    session_id, set_id = await _seed_exam(store)
    turn = await store.create_turn(session_id, "exam")
    for question in _QUESTIONS:
        await store.append_turn_event(
            turn["id"],
            {
                "type": "progress",
                "source": "exam",
                "metadata": {
                    "call_kind": "exam_judgment",
                    "question_id": question["question_id"],
                    "verdict": "correct",
                    "question_set_id": set_id,
                },
            },
        )

    bus = StreamBus()
    await ExamCapability().run(_proctor_context(session_id, "我考完了嗎"), bus)

    contents = [e for e in _events(bus) if e.type is StreamEventType.CONTENT]
    assert contents and "全部作答完畢" in contents[-1].content
    # Completion short-circuits before any LLM call.
    assert _FakeProctorAgent.seen == []


@pytest.mark.asyncio
async def test_exam_capability_passes_proctor_mode_through(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    """ExamCapability must not clobber mode=proctor back to original_paper."""
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    _patch_environment(monkeypatch, store)
    session_id, _set_id = await _seed_exam(store)
    _FakeProctorAgent.scripted = [("none", "hi")]

    bus = StreamBus()
    await ExamCapability().run(_proctor_context(session_id, "嗨"), bus)

    # Proctor path reached (agent called), not original_paper (would raise
    # "requires a paper_id" against the fake environment).
    assert len(_FakeProctorAgent.seen) == 1
    # DeepQuestionCapability honors the same mode.
    _FakeProctorAgent.scripted = [("none", "hi again")]
    bus2 = StreamBus()
    await DeepQuestionCapability().run(_proctor_context(session_id, "嗨"), bus2)
    assert len(_FakeProctorAgent.seen) == 2
