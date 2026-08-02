from __future__ import annotations

from dataclasses import dataclass
import json

import httpx
import pytest

from deeptutor.services.voice import realtime

OFFER_SDP = (
    "v=0\r\n"
    "o=- 1 2 IN IP4 127.0.0.1\r\n"
    "s=-\r\n"
    "t=0 0\r\n"
    "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
)
ANSWER_SDP = (
    "v=0\r\n"
    "o=- 2 3 IN IP4 127.0.0.1\r\n"
    "s=-\r\n"
    "t=0 0\r\n"
    "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"
)


@dataclass(frozen=True)
class _Token:
    access: str = "controlled-test-access"
    account_id: str = "controlled-test-account"


class _Socket:
    def __init__(self) -> None:
        self.sent: list[dict[str, object]] = []
        self.closed = False

    async def send(self, message: str) -> None:
        self.sent.append(json.loads(message))

    def __aiter__(self):
        return self

    async def __anext__(self):
        raise StopAsyncIteration

    async def close(self, *args: object, **kwargs: object) -> None:
        del args, kwargs
        self.closed = True


def test_codex_realtime_defaults_to_server_side_avas_provider() -> None:
    provider = realtime.CodexOAuthRealtimeProvider()
    assert provider.call_url.endswith("/backend-api/codex/realtime/calls")
    assert provider.sideband_url == "wss://api.openai.com/v1/live"
    assert realtime.configured_realtime_provider() == "openai_codex"


def test_call_id_matches_official_rtc_or_uuid_shape() -> None:
    assert realtime._parse_call_id("/v1/live/rtc_controlled") == "rtc_controlled"
    assert (
        realtime._parse_call_id("/v1/live/019eb97d-8e9a-7ff3-94b0-ea019babd5d7")
        == "019eb97d-8e9a-7ff3-94b0-ea019babd5d7"
    )
    with pytest.raises(realtime.RealtimeVoiceProviderError, match="call identifier"):
        realtime._parse_call_id("/v1/live/0123456789abcdef")


def test_avas_session_payload_rejects_unverified_model_or_voice() -> None:
    with pytest.raises(realtime.RealtimeVoiceProviderError, match="model is unsupported"):
        realtime.codex_avas_session_payload(model="gpt-realtime")
    with pytest.raises(realtime.RealtimeVoiceProviderError, match="voice is unsupported"):
        realtime.codex_avas_session_payload(voice="alloy")


def test_avas_session_payload_uses_official_frameless_bidi_contract() -> None:
    payload = realtime.codex_avas_session_payload(instructions="transport only")
    assert payload == {
        "instructions": "transport only",
        "audio": {"output": {"voice": "cove"}},
        "delegation": {"type": "client"},
        "model": "gpt-live-1-boulder-alpha",
    }
    strict_payload = realtime.codex_avas_session_payload()
    assert "For EVERY completed user utterance" in strict_payload["instructions"]
    assert "speaks while you are vocalizing" in strict_payload["instructions"]
    assert "short exam answers" in strict_payload["instructions"]
    assert "Barge-in is NEVER permission" in strict_payload["instructions"]
    assert "NEVER answer" in strict_payload["instructions"]
    assert "vocalize it verbatim" in strict_payload["instructions"]

    context_payload = realtime.codex_avas_session_payload(
        initial_items=(
            {"role": "developer", "text": "Use only this bounded context."},
            {"role": "user", "text": "Prior question"},
            {"role": "assistant", "text": "Prior answer"},
        )
    )
    assert context_payload["initial_items"] == [
        {
            "type": "message",
            "role": "developer",
            "content": [{"type": "input_text", "text": "Use only this bounded context."}],
        },
        {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "Prior question"}],
        },
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Prior answer"}],
        },
    ]


@pytest.mark.asyncio
async def test_create_call_uses_configured_model_and_voice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class _Settings:
        def load_realtime_voice(self) -> dict[str, object]:
            return {
                "provider": "openai_codex",
                "model": "gpt-live-1-boulder-alpha",
                "voice": "juniper",
            }

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            201,
            headers={"location": "/v1/realtime/calls/rtc_controlled"},
            content=ANSWER_SDP.encode(),
        )

    monkeypatch.setattr(realtime, "get_runtime_settings_service", _Settings)
    provider = realtime.CodexOAuthRealtimeProvider(
        token_loader=_Token,
        http_transport=httpx.MockTransport(handler),
    )

    await provider.create_call(OFFER_SDP, session_id="session-controlled")

    body = captured["body"]
    assert isinstance(body, dict)
    assert body["session"]["model"] == "gpt-live-1-boulder-alpha"  # type: ignore[index]
    assert body["session"]["audio"] == {"output": {"voice": "juniper"}}  # type: ignore[index]


@pytest.mark.asyncio
async def test_create_call_posts_real_v3_avas_request_without_exposing_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class _Settings:
        def load_realtime_voice(self) -> dict[str, object]:
            # Isolate from the developer's saved settings so defaults apply.
            return {}

    monkeypatch.setattr(realtime, "get_runtime_settings_service", _Settings)

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            201,
            headers={"location": "/v1/realtime/calls/rtc_controlled"},
            content=ANSWER_SDP.encode(),
        )

    provider = realtime.CodexOAuthRealtimeProvider(
        token_loader=_Token,
        http_transport=httpx.MockTransport(handler),
    )
    call = await provider.create_call(
        OFFER_SDP,
        session_id="session-controlled",
        instructions="handoff finalized speech",
    )

    headers = captured["headers"]
    assert isinstance(headers, dict)
    assert "intent=quicksilver&architecture=avas" in str(captured["url"])
    assert headers["authorization"] == "Bearer controlled-test-access"
    assert headers["openai-alpha"] == "quicksilver=v2"
    assert headers["x-session-id"] == "session-controlled"
    assert headers["session-id"] == "session-controlled"
    assert headers["thread-id"] == "session-controlled"
    assert "openai-beta" not in headers
    assert captured["body"] == {
        "sdp": OFFER_SDP,
        "session": realtime.codex_avas_session_payload(instructions="handoff finalized speech"),
    }
    assert call.answer_sdp == ANSWER_SDP
    assert call.call_id == "rtc_controlled"
    assert "controlled-test-access" not in repr(call)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "offer",
    [
        "",
        "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
        "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
    ],
)
async def test_create_call_rejects_invalid_or_incomplete_webrtc_offer(offer: str) -> None:
    provider = realtime.CodexOAuthRealtimeProvider(token_loader=_Token)
    with pytest.raises(realtime.RealtimeVoiceProviderError, match="offer SDP"):
        await provider.create_call(offer, session_id="session-controlled")


@pytest.mark.asyncio
async def test_create_call_fails_closed_when_oauth_is_missing() -> None:
    provider = realtime.CodexOAuthRealtimeProvider(
        token_loader=lambda: type("Token", (), {"access": None})(),
    )
    with pytest.raises(realtime.RealtimeVoiceProviderError, match="not logged in"):
        await provider.create_call(OFFER_SDP, session_id="session-controlled")


@pytest.mark.asyncio
async def test_create_call_does_not_forward_upstream_error_body() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403,
            content=b"Authorization Bearer secret must never reach the browser",
        )

    provider = realtime.CodexOAuthRealtimeProvider(
        token_loader=_Token,
        http_transport=httpx.MockTransport(handler),
    )
    with pytest.raises(realtime.RealtimeVoiceProviderError, match="access was denied") as caught:
        await provider.create_call(OFFER_SDP, session_id="session-controlled")
    assert "Bearer" not in str(caught.value)
    assert "secret" not in str(caught.value)


@pytest.mark.asyncio
async def test_create_call_rejects_invalid_answer_sdp() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            201,
            headers={"location": "/v1/realtime/calls/rtc_controlled"},
            content=b"not-sdp",
        )

    provider = realtime.CodexOAuthRealtimeProvider(
        token_loader=_Token,
        http_transport=httpx.MockTransport(handler),
    )
    with pytest.raises(realtime.RealtimeVoiceProviderError, match="invalid WebRTC answer"):
        await provider.create_call(OFFER_SDP, session_id="session-controlled")


@pytest.mark.asyncio
async def test_sideband_connect_keeps_oauth_headers_server_side() -> None:
    socket = _Socket()
    captured: dict[str, object] = {}

    async def connect(url: str, **kwargs: object) -> _Socket:
        captured["url"] = url
        captured["headers"] = kwargs.get("additional_headers")
        return socket

    provider = realtime.CodexOAuthRealtimeProvider(connect=connect)
    call = realtime.CodexRealtimeCall(
        answer_sdp=ANSWER_SDP,
        call_id="rtc_controlled",
        _sideband_headers={
            "Authorization": "Bearer controlled-test-access",
            "chatgpt-account-id": "controlled-test-account",
            "openai-alpha": "quicksilver=v2",
        },
    )
    sideband = await provider.connect_sideband(call)

    assert str(captured["url"]).endswith("/v1/live/rtc_controlled")
    assert captured["headers"] == call._sideband_headers
    assert socket.sent == []  # V3 session config was supplied at call creation.
    assert "controlled-test-access" not in repr(call)

    await sideband.close()
    assert socket.sent == [{"type": "session.close"}]
    assert socket.closed


@pytest.mark.asyncio
async def test_sideband_sends_frameless_context_on_explicit_channels() -> None:
    socket = _Socket()
    sideband = realtime.CodexRealtimeSideband(socket)
    await sideband.send_handoff_append("delegation-1", "DeepTutor progress")
    await sideband.send_handoff_speech("delegation-1", "DeepTutor answer")

    assert socket.sent == [
        {
            "type": "delegation.context.append",
            "delegation_item_id": "delegation-1",
            "channel": "commentary",
            "content": [{"type": "input_text", "text": "DeepTutor progress"}],
        },
        {
            "type": "delegation.context.append",
            "delegation_item_id": "delegation-1",
            "channel": "speakable",
            "content": [{"type": "input_text", "text": "DeepTutor answer"}],
        },
    ]


@pytest.mark.asyncio
async def test_sideband_rejects_non_v3_outbound_events() -> None:
    socket = _Socket()
    sideband = realtime.CodexRealtimeSideband(socket)

    with pytest.raises(realtime.RealtimeVoiceProviderError, match="GPT-Live V3"):
        await sideband._send({"type": "response.cancel"})

    assert socket.sent == []


@pytest.mark.asyncio
async def test_sideband_chunks_utf8_context_without_splitting_characters() -> None:
    socket = _Socket()
    sideband = realtime.CodexRealtimeSideband(socket)
    text = "語音回答" * 80
    await sideband.send_handoff_speech("delegation-1", text)

    chunks = [
        str(message["content"][0]["text"])  # type: ignore[index]
        for message in socket.sent
    ]
    assert "".join(chunks) == text
    assert all(len(chunk.encode("utf-8")) <= 500 for chunk in chunks)


def test_frameless_events_normalize_transcript_handoff_and_audio_signal() -> None:
    assert realtime.normalize_codex_event({"type": "session.closed"}) == []
    assert realtime.normalize_codex_event(
        {"type": "input_transcript.added", "item": {"text": "hello"}}
    ) == [{"type": "transcript", "phase": "partial", "text": "hello"}]
    assert realtime.normalize_codex_event(
        {
            "type": "turn.done",
            "turn": {"id": "turn-1", "role": "user", "transcript": "Explain this question"},
        }
    ) == [
        {
            "type": "provider_user_turn",
            "provider_turn_id": "turn-1",
            "text": "Explain this question",
        }
    ]
    assert realtime.normalize_codex_event(
        {
            "type": "turn.done",
            "turn": {"role": "user", "transcript": "No provider id required"},
        }
    ) == [{"type": "provider_user_turn", "text": "No provider id required"}]
    assert realtime.normalize_codex_event(
        {
            "type": "delegation.created",
            "item": {
                "id": "delegation-1",
                "type": "delegation",
                "target": "client",
                "content": [{"type": "input_text", "text": "Explain this question"}],
            },
        }
    ) == [
        {
            "type": "handoff",
            "handoff_id": "delegation-1",
            "text": "Explain this question",
        },
        {
            "type": "transcript",
            "phase": "final",
            "handoff_id": "delegation-1",
            "text": "Explain this question",
        },
    ]
    assert realtime.normalize_codex_event({"type": "output_audio.delta", "audio": "AQID"}) == [
        {"type": "state", "state": "speaking"},
        {"type": "audio_output"},
    ]
    assert realtime.normalize_codex_event(
        {
            "type": "turn.done",
            "turn": {"id": "assistant-turn-1", "role": "assistant", "transcript": "Answer"},
        }
    ) == [
        {
            "type": "provider_assistant_turn",
            "provider_turn_id": "assistant-turn-1",
            "text": "Answer",
        },
        {"type": "state", "state": "listening"},
    ]


def test_frameless_events_ignore_whitespace_only_partial_transcripts() -> None:
    for event_type in ("input_transcript.added", "output_transcript.added"):
        assert (
            realtime.normalize_codex_event(
                {"type": event_type, "item": {"id": "noise-only", "text": " \n\t "}}
            )
            == []
        )


def test_frameless_events_reject_v1_and_v2_contracts() -> None:
    for event_type in ("conversation.handoff.requested", "response.created"):
        with pytest.raises(realtime.RealtimeVoiceProviderError, match="legacy"):
            realtime.normalize_codex_event({"type": event_type})


def test_frameless_events_fail_closed_on_empty_final_transcript_or_audio() -> None:
    with pytest.raises(realtime.RealtimeVoiceProviderError, match="empty final transcript"):
        realtime.normalize_codex_event(
            {"type": "turn.done", "turn": {"role": "user", "transcript": "   "}}
        )
    with pytest.raises(realtime.RealtimeVoiceProviderError, match="empty handoff transcript"):
        realtime.normalize_codex_event(
            {
                "type": "delegation.created",
                "item": {
                    "id": "delegation-1",
                    "type": "delegation",
                    "target": "client",
                    "content": [],
                },
            }
        )
    with pytest.raises(realtime.RealtimeVoiceProviderError, match="invalid audio output"):
        realtime.normalize_codex_event({"type": "output_audio.delta", "audio": ""})
    with pytest.raises(realtime.RealtimeVoiceProviderError, match="invalid audio output"):
        realtime.normalize_codex_event({"type": "output_audio.delta", "audio": "not-base64"})


def test_status_is_credential_free() -> None:
    status = realtime.realtime_voice_status().public_dict()
    serialized = json.dumps(status)
    assert status["provider"] == "openai_codex"
    assert "access" not in serialized.lower()
    assert "authorization" not in serialized.lower()
    assert "bearer" not in serialized.lower()
