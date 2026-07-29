"""Conservative deterministic grading for quiz answers."""

from __future__ import annotations

import re
import unicodedata
from typing import Mapping

_FILL_PUNCTUATION = re.compile(r"^[.,!?;:，。！？；：、\"'「」『』（）()【】\[\]…]+|[.,!?;:，。！？；：、\"'「」『』（）()【】\[\]…]+$")


def normalize_fill_answer(value: str) -> str:
    """Normalize only unambiguous formatting differences."""
    return _FILL_PUNCTUATION.sub(
        "",
        re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or "")).strip()).casefold(),
    )


def deterministic_grade(
    *,
    question_type: str,
    options: Mapping[str, str] | None,
    correct_answer: str,
    user_answer: str,
    is_multi_select: bool = False,
    image_dependent: bool = False,
) -> bool | None:
    """Return a verdict only where exact grading is conservative.

    ``None`` means manual/AI review is required. Multi-select, subjective,
    and answer-less questions are never guessed here. An image-dependent
    single-choice question can still be graded from its answer key; the image
    only changes how the learner reads the prompt.
    """
    if is_multi_select:
        return None
    qtype = str(question_type or "").strip().casefold()
    if image_dependent and qtype != "choice":
        return None
    correct = str(correct_answer or "").strip()
    answer = str(user_answer or "").strip()
    if not correct or not answer:
        return None

    if qtype == "choice" and isinstance(options, Mapping) and options:
        answer_key = answer.casefold()
        if answer in options:
            answer_key = answer.casefold()
        else:
            for key, value in options.items():
                if str(value).strip().casefold() == answer.casefold():
                    answer_key = str(key).strip().casefold()
                    break
        correct_key = correct.casefold()
        if correct in options:
            correct_key = correct.casefold()
        else:
            for key, value in options.items():
                if str(value).strip().casefold() == correct.casefold():
                    correct_key = str(key).strip().casefold()
                    break
        return answer_key == correct_key

    if qtype == "concept":
        truth = {"true": "true", "t": "true", "yes": "true", "1": "true", "對": "true", "正確": "true"}
        truth.update({"false": "false", "f": "false", "no": "false", "0": "false", "錯": "false", "錯誤": "false"})
        normalized_answer = truth.get(answer.casefold())
        normalized_correct = truth.get(correct.casefold())
        return (
            normalized_answer == normalized_correct
            if normalized_answer is not None and normalized_correct is not None
            else None
        )

    if qtype == "fill_in_blank":
        return normalize_fill_answer(answer) == normalize_fill_answer(correct)

    return None


__all__ = ["deterministic_grade", "normalize_fill_answer"]
