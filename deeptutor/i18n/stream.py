"""Locale the human-readable side of streamed backend events."""

from __future__ import annotations

from dataclasses import replace

from deeptutor.core.stream import StreamEvent

from .zh_tw import to_traditional_chinese


_TRADITIONAL_CODES = {"zh-tw", "zh-hant", "zh-hk", "tw", "traditional"}


def is_traditional_chinese(language: str | None) -> bool:
    """Return whether *language* requests Taiwan Traditional Chinese."""
    code = str(language or "").strip().lower().replace("_", "-")
    return code in _TRADITIONAL_CODES


def localize_stream_event(event: StreamEvent, language: str | None) -> StreamEvent:
    """Return an event whose reader-facing text matches the requested locale.

    Event metadata remains untouched: tool names, model ids, source URLs and
    structured payloads are protocol data, not prose. ``content`` is the
    human-readable SSE/WS channel and is safe to localize at the transport
    boundary; this also makes the persisted assistant transcript match what
    the learner saw while streaming.
    """
    if not is_traditional_chinese(language) or not event.content:
        return event
    return replace(event, content=to_traditional_chinese(event.content))


__all__ = ["is_traditional_chinese", "localize_stream_event"]
