"""Exam progress store accessors: latest snapshot + judgment events."""

from __future__ import annotations

import pytest

from deeptutor.services.session.sqlite_store import SQLiteSessionStore


async def _make_turn(store: SQLiteSessionStore, session_id: str) -> str:
    turn = await store.create_turn(session_id, "exam")
    return turn["id"]


@pytest.mark.asyncio
async def test_latest_quiz_snapshot_returns_most_recent(tmp_path) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    session = await store.ensure_session(None)
    session_id = session["id"]

    await store.create_quiz_snapshot(
        session_id, "turn-1", {"source": {"paper_id": "paper-old"}, "questions": []}
    )
    await store.create_quiz_snapshot(
        session_id, "turn-2", {"source": {"paper_id": "paper-new"}, "questions": []}
    )

    latest = await store.get_latest_quiz_snapshot(session_id)
    assert latest is not None
    assert latest["paper_id"] == "paper-new"
    assert latest["turn_id"] == "turn-2"


@pytest.mark.asyncio
async def test_latest_quiz_snapshot_empty_session(tmp_path) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    session = await store.ensure_session(None)
    assert await store.get_latest_quiz_snapshot(session["id"]) is None


@pytest.mark.asyncio
async def test_list_exam_judgments_in_recorded_order(tmp_path) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    session = await store.ensure_session(None)
    session_id = session["id"]
    turn_1 = await _make_turn(store, session_id)
    await store.update_turn_status(turn_1, "completed", "")
    turn_2 = await _make_turn(store, session_id)

    await store.append_turn_event(
        turn_1,
        {
            "type": "progress",
            "source": "exam",
            "metadata": {
                "call_kind": "exam_judgment",
                "question_id": "q-1",
                "verdict": "correct",
            },
        },
    )
    # Noise: other progress events must be ignored.
    await store.append_turn_event(
        turn_1,
        {
            "type": "progress",
            "source": "chat",
            "metadata": {"call_kind": "llm_call", "call_state": "complete"},
        },
    )
    # Noise: non-progress events with the marker must be ignored.
    await store.append_turn_event(
        turn_1,
        {
            "type": "content",
            "source": "exam",
            "metadata": {"call_kind": "exam_judgment", "question_id": "q-x"},
        },
    )
    await store.append_turn_event(
        turn_2,
        {
            "type": "progress",
            "source": "exam",
            "metadata": {
                "call_kind": "exam_judgment",
                "question_id": "q-2",
                "verdict": "wrong",
            },
        },
    )

    judgments = await store.list_exam_judgments(session_id)
    assert [(j["question_id"], j["verdict"]) for j in judgments] == [
        ("q-1", "correct"),
        ("q-2", "wrong"),
    ]
    assert [j["turn_id"] for j in judgments] == [turn_1, turn_2]
