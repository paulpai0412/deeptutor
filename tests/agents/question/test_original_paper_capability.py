"""Original Paper capability tests.

The Original Paper path must consume the private, already-extracted question
records directly. These tests intentionally provide a fake Paper Library and
never construct an LLM pipeline.
"""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from deeptutor.agents.question.capability import DeepQuestionCapability, ExamCapability
from deeptutor.core.context import UnifiedContext
from deeptutor.core.stream import StreamEventType
from deeptutor.core.stream_bus import StreamBus
from deeptutor.runtime.request_contracts import (
    validate_deep_question_request_config,
    validate_exam_request_config,
)
from deeptutor.services.paper_library import PaperRecord


class _FakePaperService:
    record = PaperRecord(
        paper_id="paper-1",
        display_name="History paper",
        original_filename="history.pdf",
        source_hash="hash-1",
        status="ready_with_warnings",
        question_count=3,
        warning_count=1,
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
        warnings=["Review image association."],
    )
    questions = [
        {
            "question_id": "stable-q-2",
            "question_number": "2",
            "question_text": "Second source question",
            "question_type": "choice",
            "options": {"A": "a", "B": "b"},
            "answer": "B",
            "page": 3,
            "images": ["page-3.png"],
        },
        {
            "question_id": "stable-q-1",
            "question_number": "1",
            "question_text": "First source question",
            "question_type": "written",
            "options": {},
            "answer": "The source answer",
            "page": 1,
            "images": [],
        },
        {
            "question_id": "stable-q-3",
            "question_number": "3",
            "question_text": "Third source question",
            "question_type": "concept",
            "options": {},
            "answer": "true",
            "page": 4,
            "images": [],
        },
    ]

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        self.root = None

    def get_paper(self, paper_id: str) -> PaperRecord:
        if paper_id != self.record.paper_id:
            raise FileNotFoundError(paper_id)
        return self.record

    def get_questions(self, paper_id: str) -> list[dict[str, Any]]:
        self.get_paper(paper_id)
        return list(self.questions)


@pytest.mark.asyncio
async def test_original_paper_emits_all_questions_in_stored_order_without_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "deeptutor.services.paper_library.PaperLibraryService", _FakePaperService
    )
    monkeypatch.setattr(
        "deeptutor.services.llm.config.get_llm_config",
        lambda: SimpleNamespace(model="unused", api_key="", base_url=None, api_version=None),
    )
    monkeypatch.setattr(
        "deeptutor.services.path_service.get_path_service",
        lambda: SimpleNamespace(get_task_workspace=lambda *_args: None),
    )

    async def _snapshot(**kwargs: Any) -> dict[str, Any]:
        questions = []
        for question in kwargs["questions"]:
            questions.append(
                {
                    **question,
                    "is_multi_select": bool(question.get("is_multi_select", False)),
                    "images": [],
                }
            )
        return {
            "snapshot_id": "snapshot-1",
            "source": {
                "source_type": "original_paper",
                "paper_id": "paper-1",
                "paper_display_name": "History paper",
                "paper_source_hash": "hash-1",
            },
            "questions": questions,
        }

    monkeypatch.setattr(
        "deeptutor.services.session.quiz_snapshot.create_current_original_paper_snapshot",
        _snapshot,
    )

    pipeline_called = False

    def _unexpected_pipeline(*_args: Any, **_kwargs: Any) -> None:
        nonlocal pipeline_called
        pipeline_called = True
        raise AssertionError("Original Paper must not construct QuestionPipeline")

    monkeypatch.setattr("deeptutor.agents.question.pipeline.QuestionPipeline", _unexpected_pipeline)

    bus = StreamBus()
    context = UnifiedContext(
        session_id="session-1",
        user_message="start the paper quiz",
        active_capability="deep_question",
        config_overrides={"mode": "original_paper", "paper_id": "paper-1"},
        metadata={"turn_id": "turn-1"},
    )
    await DeepQuestionCapability().run(context, bus)

    events = list(bus._history)
    question_events = [
        event
        for event in events
        if event.type is StreamEventType.CONTENT
        and event.metadata.get("call_kind") == "quiz_question_emitted"
    ]
    assert [event.metadata["qa_pair"]["question_id"] for event in question_events] == [
        "stable-q-2",
        "stable-q-1",
        "stable-q-3",
    ]
    assert [event.metadata["qa_pair"]["question"] for event in question_events] == [
        "Second source question",
        "First source question",
        "Third source question",
    ]
    assert all(event.metadata["source_type"] == "original_paper" for event in question_events)
    assert all(event.metadata["qa_pair"]["snapshot_id"] == "snapshot-1" for event in question_events)
    assert not pipeline_called

    result = next(event for event in events if event.type is StreamEventType.RESULT)
    assert result.metadata["mode"] == "original_paper"
    assert result.metadata["paper_id"] == "paper-1"
    assert result.metadata["source_type"] == "original_paper"
    assert result.metadata["summary"]["source"] == "original_paper"
    assert [
        item["qa_pair"]["question_id"] for item in result.metadata["summary"]["results"]
    ] == ["stable-q-2", "stable-q-1", "stable-q-3"]


@pytest.mark.asyncio
async def test_original_paper_rejects_unavailable_status(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unavailable = replace(_FakePaperService.record, status="processing")

    class _UnavailablePaperService(_FakePaperService):
        record = unavailable

    monkeypatch.setattr(
        "deeptutor.services.paper_library.PaperLibraryService", _UnavailablePaperService
    )
    monkeypatch.setattr(
        "deeptutor.services.llm.config.get_llm_config",
        lambda: SimpleNamespace(model="unused", api_key="", base_url=None, api_version=None),
    )
    monkeypatch.setattr(
        "deeptutor.services.path_service.get_path_service",
        lambda: SimpleNamespace(get_task_workspace=lambda *_args: None),
    )
    monkeypatch.setattr(
        "deeptutor.services.session.quiz_snapshot.create_current_original_paper_snapshot",
        lambda **_kwargs: None,
    )

    bus = StreamBus()
    context = UnifiedContext(
        session_id="session-1",
        active_capability="deep_question",
        config_overrides={"mode": "original_paper", "paper_id": "paper-1"},
    )
    await DeepQuestionCapability().run(context, bus)

    errors = [event for event in bus._history if event.type is StreamEventType.ERROR]
    assert len(errors) == 1
    assert "requires a ready" in errors[0].content
    assert not [event for event in bus._history if event.type is StreamEventType.RESULT]


def test_exam_capability_is_a_restricted_original_paper_facade() -> None:
    assert ExamCapability.manifest.name == "exam"
    assert validate_exam_request_config({"paper_id": "paper-1"}).paper_id == "paper-1"
    with pytest.raises(ValueError, match="topic"):
        validate_exam_request_config({"paper_id": "paper-1", "topic": "leak"})


@pytest.mark.asyncio
async def test_exam_capability_forces_original_paper_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_run(self: DeepQuestionCapability, context: UnifiedContext, stream: StreamBus) -> None:
        captured.update(context.config_overrides)

    monkeypatch.setattr(DeepQuestionCapability, "run", fake_run)
    context = UnifiedContext(
        active_capability="exam",
        config_overrides={"mode": "custom", "paper_id": "paper-1"},
    )
    await ExamCapability().run(context, StreamBus())
    assert captured == {"mode": "original_paper", "paper_id": "paper-1"}


def test_original_paper_request_contains_only_paper_id() -> None:
    validated = validate_deep_question_request_config(
        {"mode": "original_paper", "paper_id": "paper-1"}
    )
    assert validated.model_dump(exclude_none=True) == {
        "mode": "original_paper",
        "topic": "",
        "num_questions": 1,
        "difficulty": "",
        "question_types": [],
        "per_type_counts": {},
        "paper_path": "",
        "paper_id": "paper-1",
        "max_questions": 10,
    }

    with pytest.raises(ValueError, match="only mode and paper_id"):
        validate_deep_question_request_config(
            {"mode": "original_paper", "paper_id": "paper-1", "paper_path": "/tmp/paper"}
        )

    with pytest.raises(ValueError, match="requires paper_id"):
        validate_deep_question_request_config({"mode": "original_paper"})
