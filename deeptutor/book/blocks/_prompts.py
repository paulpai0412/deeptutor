"""
Shared prompt loader for non-BaseAgent call sites in ``deeptutor/book``.

All LLM-facing prompts inside this module live as YAML under
``deeptutor/book/prompts/{en,zh}/<name>.yaml`` and are loaded through the
unified :class:`~deeptutor.services.prompt.PromptManager`. This helper is the
thin wrapper that block generators and the SectionArchitect use, since they
call ``llm_text`` directly instead of inheriting :class:`BaseAgent`.

Conventions
-----------
* One YAML file per logical writer (block generator, planner stage…), named
  after the python module (``text.py`` → ``text.yaml``).
* Top-level keys are short identifiers (``system``, ``user_template``,
  ``bridge_system``, ``outline_system``…) and contain plain strings.
* Variable interpolation uses ``str.format`` placeholders (``{chapter_title}``).

Missing files / keys raise :class:`RuntimeError` so the failure surfaces at
the call site instead of silently producing degenerate prompts.
"""

from __future__ import annotations

from typing import Any

from deeptutor.core.i18n import parse_language
from deeptutor.services.prompt import get_prompt_manager


def load_book_prompts(name: str, language: str) -> dict[str, Any]:
    """Load a YAML prompt bundle for the ``book`` module.

    Args:
        name: File stem under ``deeptutor/book/prompts/{lang}/``
            (e.g. ``"text"``, ``"section"``, ``"page_planner"``).
        language: ``"en"`` or ``"zh"``.

    Returns:
        Parsed YAML as a dictionary.

    Raises:
        RuntimeError: When the bundle is missing or empty.
    """
    prompts = get_prompt_manager().load_prompts(
        module_name="book",
        agent_name=name,
        language=language,
    )
    if not prompts:
        raise RuntimeError(
            f"Missing prompt bundle for book/{name} (language={language}). "
            f"Expected deeptutor/book/prompts/{{en,zh}}/{name}.yaml."
        )
    return prompts


def book_text(language: str, *, en: str, zh: str, zh_tw: str) -> str:
    """Select explicit book copy without runtime script conversion."""
    locale = parse_language(language)
    return zh_tw if locale == "zh-TW" else zh if locale == "zh" else en


def get_book_prompt(prompts: dict[str, Any], key: str) -> str:
    """Return the prompt string under ``key`` from a loaded bundle.

    Raises ``RuntimeError`` if the key is missing or not a non-empty string.
    """
    value = prompts.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"Prompt key '{key}' missing or empty in loaded book prompt bundle.")
    return value


__all__ = ["book_text", "get_book_prompt", "load_book_prompts"]
