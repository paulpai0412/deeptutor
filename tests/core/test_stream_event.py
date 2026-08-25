"""Tests for the stream event serialization protocol."""

from __future__ import annotations

import pytest

from deeptutor.core.stream import StreamEvent, StreamEventType


def test_to_dict_preserves_complete_serialized_shape() -> None:
    metadata = {"args": {"query": "test"}}
    event = StreamEvent(
        type=StreamEventType.TOOL_CALL,
        source="chat",
        stage="responding",
        content="web_search",
        metadata=metadata,
        session_id="session-1",
        turn_id="turn-1",
        seq=3,
        timestamp=123.5,
    )

    assert event.to_dict() == {
        "type": "tool_call",
        "source": "chat",
        "stage": "responding",
        "content": "web_search",
        "metadata": metadata,
        "session_id": "session-1",
        "turn_id": "turn-1",
        "seq": 3,
        "timestamp": 123.5,
    }


def test_from_dict_round_trips_to_dict_output() -> None:
    original = StreamEvent(
        type=StreamEventType.RESULT,
        source="deep_solve",
        stage="writing",
        content="answer",
        metadata={"cost": 1.25},
        session_id="session-1",
        turn_id="turn-1",
        seq=7,
        timestamp=456.75,
    )

    restored = StreamEvent.from_dict(original.to_dict())

    assert restored == original
    assert isinstance(restored.type, StreamEventType)


@pytest.mark.parametrize("event_type", list(StreamEventType))
def test_from_dict_converts_every_string_event_type(event_type: StreamEventType) -> None:
    event = StreamEvent.from_dict({"type": event_type.value})

    assert event.type is event_type


def test_from_dict_accepts_stream_event_type_instance() -> None:
    event = StreamEvent.from_dict({"type": StreamEventType.CONTENT})

    assert event.type is StreamEventType.CONTENT


def test_from_dict_uses_dataclass_defaults_for_omitted_optional_fields() -> None:
    event = StreamEvent.from_dict({"type": "content"})

    assert event.source == ""
    assert event.stage == ""
    assert event.content == ""
    assert event.metadata == {}
    assert event.session_id == ""
    assert event.turn_id == ""
    assert event.seq == 0
    assert isinstance(event.timestamp, float)


def test_from_dict_ignores_unknown_fields() -> None:
    event = StreamEvent.from_dict(
        {
            "type": "thinking",
            "content": "working",
            "future_protocol_field": {"enabled": True},
        }
    )

    assert event.type is StreamEventType.THINKING
    assert event.content == "working"
    assert not hasattr(event, "future_protocol_field")


def test_from_dict_reports_missing_required_type_field() -> None:
    with pytest.raises(ValueError, match=r"required field 'type'"):
        StreamEvent.from_dict({"content": "missing type"})


@pytest.mark.parametrize("invalid_type", ["unknown", "CONTENT", "", None, 1])
def test_from_dict_reports_invalid_type_field(invalid_type: object) -> None:
    with pytest.raises(ValueError, match=r"field 'type'"):
        StreamEvent.from_dict({"type": invalid_type})
