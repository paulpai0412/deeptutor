#!/usr/bin/env python
"""Single-call voice exam proctor.

One LLM call per student utterance: judge the utterance against the current
question and produce the spoken reply. The *flow* (advance on correct,
explain on wrong, skip on request) lives in the prompt — the code only
parses the machine-readable verdict line and lets progress derive from the
recorded judgments.
"""

from __future__ import annotations

import re
from typing import Any

from deeptutor.agents.base_agent import BaseAgent
from deeptutor.core.trace import build_trace_metadata, new_call_id
from deeptutor.services.prompt.language import append_language_directive

_VERDICT_LINE = re.compile(r"^\s*VERDICT:\s*(correct|wrong|skip|none)\s*$", re.IGNORECASE)
_VALID_VERDICTS = frozenset({"correct", "wrong", "skip", "none"})


def parse_proctor_reply(raw: str) -> tuple[str, str]:
    """Split the agent output into (verdict, spoken reply)."""
    text = (raw or "").strip()
    if not text:
        return "none", ""
    first_line, _, rest = text.partition("\n")
    match = _VERDICT_LINE.match(first_line)
    if not match:
        return "none", text
    verdict = match.group(1).lower()
    return (verdict if verdict in _VALID_VERDICTS else "none"), rest.strip()


class ProctorAgent(BaseAgent):
    """Judge one exam utterance and answer in one LLM call."""

    def __init__(self, language: str = "en", **kwargs: Any) -> None:
        super().__init__(
            module_name="question",
            agent_name="proctor_agent",
            language=language,
            **kwargs,
        )

    async def process(
        self,
        *,
        user_message: str,
        current_question: dict[str, Any],
        next_question: dict[str, Any] | None,
        progress_context: str,
        history_context: str = "",
    ) -> tuple[str, str]:
        system_prompt = append_language_directive(
            self.get_prompt("system", ""),
            self.language,
        )
        user_prompt_template = self.get_prompt("proctor_turn", "")
        if not user_prompt_template:
            user_prompt_template = (
                "Exam progress:\n{progress_context}\n\n"
                "Current question:\n{current_question}\n\n"
                "Next question (if any):\n{next_question}\n\n"
                "Conversation history:\n{history_context}\n\n"
                "Student utterance:\n{user_message}\n"
            )
        user_prompt = user_prompt_template.format(
            progress_context=progress_context or "(none)",
            current_question=self._render_question(current_question),
            next_question=(
                self._render_question(next_question) if next_question else "(none — last question)"
            ),
            history_context=history_context or "(none)",
            user_message=user_message.strip() or "(empty)",
        )

        _chunks: list[str] = []
        async for chunk in self.stream_llm(
            user_prompt=user_prompt,
            system_prompt=system_prompt,
            stage="exam_proctor",
            trace_meta=build_trace_metadata(
                call_id=new_call_id(
                    f"exam-proctor-{current_question.get('question_id', 'question')}"
                ),
                phase="generation",
                label="Exam proctor turn",
                call_kind="llm_generation",
                question_id=str(current_question.get("question_id", "")),
            ),
        ):
            _chunks.append(chunk)
        return parse_proctor_reply("".join(_chunks))

    @staticmethod
    def _render_question(question: dict[str, Any]) -> str:
        options = question.get("options") or {}
        option_lines: list[str] = []
        if isinstance(options, dict):
            for key, value in options.items():
                if str(value or "").strip():
                    option_lines.append(f"{key}. {value}")
        lines = [
            f"Question number: {question.get('question_number') or '(none)'}",
            f"Question type: {question.get('question_type') or '(none)'}",
            "Question:",
            str(question.get("question_text") or question.get("question") or "(none)"),
        ]
        if option_lines:
            lines.extend(["", "Options:", *option_lines])
        lines.extend(
            ["", f"Reference answer: {question.get('answer') or '(none)'}"]
        )
        return "\n".join(lines)


__all__ = ["ProctorAgent", "parse_proctor_reply"]
