"""Exam paper_id recovery in start_turn.

Exam mode persists at the session level, but paper_id only travels in the
per-turn config. Voice turns and restored sessions arrive without it; the
runtime must recover it from the session's latest quiz snapshot.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from deeptutor.core.stream import StreamEvent, StreamEventType
from deeptutor.services.session.sqlite_store import SQLiteSessionStore
from deeptutor.services.session.turn_runtime import TurnRuntimeManager


async def _noop_async(*_args: Any, **_kwargs: Any) -> None:
    return None


def _patch_turn_environment(monkeypatch: pytest.MonkeyPatch, captured: dict) -> None:
    class FakeContextBuilder:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        async def build(self, **_kwargs: Any) -> SimpleNamespace:
            return SimpleNamespace(
                conversation_history=[],
                conversation_summary="",
                context_text="",
                token_count=0,
                budget=0,
            )

    class FakeOrchestrator:
        async def handle(self, context):
            captured["config_overrides"] = dict(context.config_overrides)
            yield StreamEvent(
                type=StreamEventType.CONTENT,
                source="exam",
                stage="quizzing",
                content="ok",
            )
            yield StreamEvent(type=StreamEventType.DONE, source="exam")

    monkeypatch.setattr("deeptutor.services.llm.config.get_llm_config", lambda: SimpleNamespace())
    monkeypatch.setattr(
        "deeptutor.services.session.context_builder.ContextBuilder", FakeContextBuilder
    )
    monkeypatch.setattr("deeptutor.runtime.orchestrator.ChatOrchestrator", FakeOrchestrator)
    monkeypatch.setattr(
        "deeptutor.services.memory.get_memory_store",
        lambda: SimpleNamespace(read_l3_concat=lambda: "", emit=_noop_async),
    )
    monkeypatch.setattr(
        "deeptutor.services.skill.get_skill_service",
        lambda: SimpleNamespace(
            summary_entries=lambda: [],
            load_always_for_context=lambda: "",
            load_for_context=lambda _skills: "",
            list_skills=lambda: [],
        ),
    )
    monkeypatch.setattr(
        "deeptutor.services.persona.get_persona_service",
        lambda: SimpleNamespace(load_for_context=lambda _name: ""),
    )


async def _seed_session_with_snapshot(store: SQLiteSessionStore) -> str:
    session = await store.ensure_session(None)
    session_id = session["id"]
    await store.create_quiz_snapshot(
        session_id,
        "turn-seed",
        {
            "source": {
                "source_type": "original_paper",
                "paper_id": "paper-1",
                "paper_display_name": "History",
                "paper_source_hash": "hash-1",
            },
            "questions": [
                {
                    "question_id": "q-1",
                    "question_number": "1",
                    "question_text": "Q1",
                    "options": {},
                    "answer": "A",
                    "question_type": "choice",
                    "images": [],
                }
            ],
        },
    )
    return session_id


@pytest.mark.asyncio
async def test_exam_turn_recovers_missing_paper_id_from_latest_snapshot(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)
    captured: dict[str, Any] = {}
    _patch_turn_environment(monkeypatch, captured)
    session_id = await _seed_session_with_snapshot(store)

    _session, turn = await runtime.start_turn(
        {
            "type": "start_turn",
            "content": "下一題",
            "session_id": session_id,
            "capability": "exam",
            "config": {"mode": "original_paper"},
            "language": "zh",
        }
    )
    async for _event in runtime.subscribe_turn(turn["id"], after_seq=0):
        pass

    assert captured["config_overrides"]["paper_id"] == "paper-1"


@pytest.mark.asyncio
async def test_exam_turn_without_paper_id_and_no_history_still_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    runtime = TurnRuntimeManager(store)
    captured: dict[str, Any] = {}
    _patch_turn_environment(monkeypatch, captured)
    session = await store.ensure_session(None)

    with pytest.raises(RuntimeError, match="paper_id is required"):
        await runtime.start_turn(
            {
                "type": "start_turn",
                "content": "開始考試",
                "session_id": session["id"],
                "capability": "exam",
                "config": {"mode": "original_paper"},
                "language": "zh",
            }
        )
