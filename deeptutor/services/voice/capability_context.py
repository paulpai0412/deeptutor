"""Safe capability-state hints for the GPT-Live speech frontend."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

_QUIZ_CAPABILITIES = {"deep_question", "exam"}


def project_voice_capability_context(
    messages: Sequence[Mapping[str, Any]],
    capability: str,
) -> tuple[str, ...]:
    """Project only the minimum state GPT-Live needs to preserve references."""
    if capability not in _QUIZ_CAPABILITIES:
        return ()

    for message in reversed(messages):
        if message.get("role") != "assistant":
            continue
        message_capability = str(message.get("capability") or capability)
        if message_capability not in _QUIZ_CAPABILITIES:
            continue
        count = _quiz_question_count(message.get("events"))
        if count:
            label = "Exam" if capability == "exam" else "Quiz"
            return (
                f"Current {label} context: this session has {count} questions numbered "
                f"1 through {count}. Preserve ordinal references exactly and delegate "
                "the utterance; do not answer from this index.",
            )
    return ()


def _quiz_question_count(raw_events: object) -> int:
    if not isinstance(raw_events, list):
        return 0

    for event in reversed(raw_events):
        if not isinstance(event, dict) or event.get("type") != "result":
            continue
        metadata = event.get("metadata")
        summary = metadata.get("summary") if isinstance(metadata, dict) else None
        results = summary.get("results") if isinstance(summary, dict) else None
        if isinstance(results, list) and results:
            return len(results)

    question_keys: set[str] = set()
    for position, event in enumerate(raw_events):
        if not isinstance(event, dict):
            continue
        metadata = event.get("metadata")
        if (
            not isinstance(metadata, dict)
            or metadata.get("call_kind") != "quiz_question_emitted"
        ):
            continue
        question = metadata.get("qa_pair")
        if (
            not isinstance(question, dict)
            or not str(question.get("question") or "").strip()
        ):
            continue
        question_id = str(question.get("question_id") or "").strip()
        question_index = metadata.get("question_index")
        key = question_id or (
            f"index:{question_index}" if question_index is not None else f"event:{position}"
        )
        question_keys.add(key)
    return len(question_keys)


__all__ = ["project_voice_capability_context"]
