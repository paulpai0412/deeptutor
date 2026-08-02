"""Exam request contract validation tests."""

from __future__ import annotations

import pytest

from deeptutor.runtime.request_contracts import (
    validate_deep_question_request_config,
    validate_exam_request_config,
)


def test_original_paper_requires_paper_id() -> None:
    with pytest.raises(ValueError, match="paper_id is required"):
        validate_exam_request_config({"mode": "original_paper"})


def test_original_paper_accepts_paper_id() -> None:
    model = validate_exam_request_config(
        {"mode": "original_paper", "paper_id": "paper-1"}
    )
    assert model.mode == "original_paper"
    assert model.paper_id == "paper-1"


def test_proctor_mode_needs_no_paper_id() -> None:
    model = validate_exam_request_config({"mode": "proctor"})
    assert model.mode == "proctor"
    assert model.paper_id == ""


def test_unknown_fields_still_rejected() -> None:
    with pytest.raises(ValueError, match="Invalid exam config"):
        validate_exam_request_config({"mode": "proctor", "topic": "x"})


def test_unknown_mode_rejected() -> None:
    with pytest.raises(ValueError, match="Invalid exam config"):
        validate_exam_request_config({"mode": "custom"})


def test_deep_question_accepts_proctor_mode() -> None:
    model = validate_deep_question_request_config({"mode": "proctor"})
    assert model.mode == "proctor"
