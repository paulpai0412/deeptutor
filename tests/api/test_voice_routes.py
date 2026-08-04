"""Voice router tests — /tts and /stt request/response contracts."""

from __future__ import annotations

import asyncio
import io
import json
from typing import Any
import wave

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from deeptutor.api.routers import voice as voice_router
from deeptutor.services.voice import VoiceProviderError
from deeptutor.services.voice.context_snapshot import RealtimeContextSnapshot


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    app.include_router(voice_router.router, prefix="/api/v1/voice")
    return TestClient(app)


def test_tts_returns_audio_bytes(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    async def fake_synth(text: str, *, voice=None, response_format=None, **_: Any):
        captured["text"] = text
        captured["voice"] = voice
        captured["format"] = response_format
        return b"audio-bytes", "audio/mpeg"

    monkeypatch.setattr(voice_router, "synthesize_speech", fake_synth)
    resp = client.post("/api/v1/voice/tts", json={"text": "hello", "voice": "nova"})
    assert resp.status_code == 200
    assert resp.content == b"audio-bytes"
    assert resp.headers["content-type"] == "audio/mpeg"
    assert captured == {"text": "hello", "voice": "nova", "format": None}


def test_tts_wraps_pcm_bytes_as_browser_playable_wav(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pcm = b"\x00\x00\x01\x00" * 12

    async def fake_synth(text: str, *, voice=None, response_format=None, **_: Any):
        return pcm, "audio/pcm;rate=24000;channels=1"

    monkeypatch.setattr(voice_router, "synthesize_speech", fake_synth)
    resp = client.post("/api/v1/voice/tts", json={"text": "hello"})

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/wav"
    assert resp.content.startswith(b"RIFF")
    with wave.open(io.BytesIO(resp.content), "rb") as wav:
        assert wav.getframerate() == 24000
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.readframes(wav.getnframes()) == pcm


def test_tts_rejects_empty_text(client: TestClient) -> None:
    resp = client.post("/api/v1/voice/tts", json={"text": ""})
    assert resp.status_code == 422  # pydantic min_length


def test_tts_provider_error_is_502(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(*_: Any, **__: Any):
        raise VoiceProviderError("upstream down")

    monkeypatch.setattr(voice_router, "synthesize_speech", boom)
    resp = client.post("/api/v1/voice/tts", json={"text": "hi"})
    assert resp.status_code == 502
    assert "upstream down" in resp.json()["detail"]


def test_tts_missing_config_is_400(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def no_config(*_: Any, **__: Any):
        raise ValueError("No active TTS model is configured.")

    monkeypatch.setattr(voice_router, "synthesize_speech", no_config)
    resp = client.post("/api/v1/voice/tts", json={"text": "hi"})
    assert resp.status_code == 400


def test_stt_returns_text(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    async def fake_transcribe(audio: bytes, *, filename: str, content_type: str, language=None):
        captured["bytes"] = len(audio)
        captured["filename"] = filename
        return "hello world"

    monkeypatch.setattr(voice_router, "transcribe_audio", fake_transcribe)
    resp = client.post(
        "/api/v1/voice/stt",
        files={"file": ("clip.webm", b"audiobytes", "audio/webm")},
    )
    assert resp.status_code == 200
    assert resp.json() == {"text": "hello world"}
    assert captured["filename"] == "clip.webm"
    assert captured["bytes"] == 10


def test_stt_rejects_empty_upload(client: TestClient) -> None:
    resp = client.post(
        "/api/v1/voice/stt",
        files={"file": ("empty.webm", b"", "audio/webm")},
    )
    assert resp.status_code == 400


def test_realtime_status_is_credential_free(client: TestClient) -> None:
    response = client.get("/api/v1/voice/realtime/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"] == "openai_codex"
    assert "access" not in str(payload).lower()
    assert "authorization" not in str(payload).lower()
    assert "bearer" not in str(payload).lower()


class _RealtimeWebSocket:
    def __init__(self) -> None:
        self.incoming: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self.sent: list[dict[str, object]] = []
        self.closed = False
        self.close_code: int | None = None

    async def receive_json(self) -> dict[str, object]:
        return await self.incoming.get()

    async def send_json(self, payload: dict[str, object]) -> None:
        self.sent.append(payload)

    async def close(self, code: int = 1000) -> None:
        self.closed = True
        self.close_code = code


class _StrictRealtimeWebSocket(_RealtimeWebSocket):
    async def send_json(self, payload: dict[str, object]) -> None:
        if self.closed:
            raise RuntimeError('Cannot call "send" once a close message has been sent.')
        await super().send_json(payload)


class _RealtimeSideband:
    def __init__(self) -> None:
        self.incoming: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()
        self.speech: list[tuple[str, str]] = []
        self.session_speech: list[str] = []
        self.closed = False

    async def events(self):
        while True:
            event = await self.incoming.get()
            if event is None:
                return
            yield event

    async def send_handoff_speech(self, handoff_id: str, text: str) -> None:
        self.speech.append((handoff_id, text))

    async def send_speech(self, text: str) -> None:
        self.session_speech.append(text)

    async def close(self) -> None:
        self.closed = True
        await self.incoming.put(None)


class _RealtimeProvider:
    def __init__(self, sideband: _RealtimeSideband) -> None:
        self.sideband = sideband
        self.session_ids: list[str] = []
        self.call_options: list[dict[str, object]] = []

    async def create_call(self, offer_sdp: str, *, session_id: str, **options: object):
        from deeptutor.services.voice.realtime import CodexRealtimeCall

        assert offer_sdp
        self.session_ids.append(session_id)
        self.call_options.append(options)
        return CodexRealtimeCall(
            answer_sdp="v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
            call_id="rtc_controlled",
            _sideband_headers={"Authorization": "Bearer controlled-secret"},
        )

    async def connect_sideband(self, call: object) -> _RealtimeSideband:
        del call
        return self.sideband


class _RuntimeStore:
    async def get_turn(self, turn_id: str) -> dict[str, str]:
        return {"id": turn_id, "session_id": "chat-session"}


class _DirectSessionStore:
    def __init__(self) -> None:
        self.messages: list[dict[str, object]] = []
        self.next_id = 1

    async def add_message(self, **payload: object) -> int:
        record = dict(payload)
        record["id"] = self.next_id
        self.next_id += 1
        self.messages.append(record)
        return int(record["id"])


class _TurnRuntime:
    def __init__(self, *, wait_for_cancel: bool = False) -> None:
        self.store = _RuntimeStore()
        self.wait_for_cancel = wait_for_cancel
        self.subscribed = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.cancelled_turns: list[str] = []

    async def subscribe_turn(self, turn_id: str):
        del turn_id
        self.subscribed.set()
        if self.wait_for_cancel:
            await self.cancelled.wait()
            # Deliberately emit a late event: the voice bridge must suppress it.
            yield {
                "type": "content",
                "content": "late response",
                "metadata": {"call_kind": "llm_final_response"},
            }
            return
        yield {
            "type": "content",
            "content": "DeepTutor answer",
            "metadata": {"call_kind": "llm_final_response"},
        }
        yield {"type": "done"}

    async def cancel_turn(self, turn_id: str) -> None:
        self.cancelled_turns.append(turn_id)
        self.cancelled.set()


class _DelayedTurnRuntime(_TurnRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.release = asyncio.Event()

    async def subscribe_turn(self, turn_id: str):
        del turn_id
        self.subscribed.set()
        await self.release.wait()
        yield {
            "type": "content",
            "content": "DeepTutor delayed answer",
            "metadata": {"call_kind": "llm_final_response"},
        }
        yield {"type": "done"}


class _StreamingTurnRuntime(_TurnRuntime):
    def __init__(self) -> None:
        super().__init__()
        self.release = asyncio.Event()

    async def subscribe_turn(self, turn_id: str):
        del turn_id
        self.subscribed.set()
        metadata = {"call_id": "round-1", "call_kind": "agent_loop_round"}
        yield {"type": "content", "content": "First ", "metadata": metadata}
        await asyncio.sleep(0.21)
        yield {"type": "content", "content": "partial. ", "metadata": metadata}
        await self.release.wait()
        yield {"type": "content", "content": "Final.", "metadata": metadata}
        yield {
            "type": "progress",
            "metadata": {
                **metadata,
                "call_state": "complete",
                "call_role": "finish",
            },
        }
        yield {"type": "done"}


async def _wait_for(predicate, *, timeout: float = 2.0) -> None:
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.01)


def _context_snapshot() -> RealtimeContextSnapshot:
    return RealtimeContextSnapshot(
        session_id="chat-session",
        capability="chat",
        language="en",
        knowledge_bases=(),
        direct_output_allowed=False,
        instructions="controlled context",
        initial_items=({"role": "developer", "text": "controlled context"},),
    )


async def _fake_context_snapshot(*_args: object, **_kwargs: object) -> RealtimeContextSnapshot:
    return _context_snapshot()


_DELEGATION_EVENT = {
    "type": "delegation.created",
    "item": {
        "id": "delegation-1",
        "type": "delegation",
        "target": "client",
        "content": [{"type": "input_text", "text": "Explain this"}],
    },
}


@pytest.mark.asyncio
async def test_realtime_bridge_preloads_context_before_creating_provider_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    runtime = _TurnRuntime()
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put(
        {
            "type": "prepare",
            "session_id": "chat-session",
            "context": {"knowledge_bases": ["biology"]},
        }
    )
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await _wait_for(lambda: any(message.get("type") == "context_ready" for message in ws.sent))

    assert provider.session_ids == []
    assert not any(message.get("type") == "webrtc_answer" for message in ws.sent)
    assert (
        next(message for message in ws.sent if message.get("type") == "context_ready")["session_id"]
        == "chat-session"
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    await _wait_for(lambda: any(message.get("type") == "webrtc_answer" for message in ws.sent))
    assert provider.session_ids
    await ws.incoming.put({"type": "stop"})
    await task


@pytest.mark.asyncio
async def test_realtime_bridge_binds_committed_turn_and_returns_speakable_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    runtime = _TurnRuntime()
    store = _DirectSessionStore()
    monkeypatch.setattr(voice_router, "get_session_store", lambda: store)
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    await sideband.incoming.put(_DELEGATION_EVENT)
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await _wait_for(lambda: any(message.get("type") == "handoff" for message in ws.sent))
    await sideband.incoming.put(_DELEGATION_EVENT)
    await asyncio.sleep(0.05)
    assert len([message for message in ws.sent if message.get("type") == "handoff"]) == 1
    await ws.incoming.put(
        {
            "type": "turn_started",
            "handoff_id": "delegation-1",
            "turn_id": "turn-1",
            "session_id": "chat-session",
        }
    )
    await _wait_for(lambda: bool(sideband.speech))
    await ws.incoming.put({"type": "stop"})
    await task

    assert sideband.speech == [("delegation-1", "DeepTutor answer")]
    assert not store.messages
    assert provider.session_ids[0].startswith("deeptutor-")
    assert provider.call_options[0]["instructions"] == "controlled context"
    assert provider.call_options[0]["initial_items"] == (
        {"role": "developer", "text": "controlled context"},
    )
    serialized = json.dumps(ws.sent)
    assert "rtc_controlled" not in serialized
    assert "controlled-secret" not in serialized
    assert any(message.get("type") == "webrtc_answer" for message in ws.sent)
    # Codex mode: the bridge never emits playback authorization messages.
    assert not any(message.get("type") == "playback_authorized" for message in ws.sent)
    assert not any(message.get("type") == "playback_suppressed" for message in ws.sent)
    assert ws.close_code == 1000


@pytest.mark.asyncio
async def test_realtime_bridge_streams_delegated_speech_before_turn_completion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    runtime = _StreamingTurnRuntime()
    monkeypatch.setattr(
        voice_router,
        "CodexOAuthRealtimeProvider",
        lambda: _RealtimeProvider(sideband),
    )
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    await sideband.incoming.put(_DELEGATION_EVENT)
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await _wait_for(lambda: any(message.get("type") == "handoff" for message in ws.sent))
    await ws.incoming.put(
        {
            "type": "turn_started",
            "handoff_id": "delegation-1",
            "turn_id": "turn-1",
            "session_id": "chat-session",
        }
    )

    await _wait_for(lambda: bool(sideband.speech))
    assert sideband.speech == [("delegation-1", "First partial. ")]
    assert not runtime.release.is_set()
    runtime.release.set()
    await _wait_for(lambda: len(sideband.speech) == 2)
    await ws.incoming.put({"type": "stop"})
    await task

    assert "".join(text for _, text in sideband.speech) == "First partial. Final."
    assert not any(message.get("type") == "playback_authorized" for message in ws.sent)


@pytest.mark.asyncio
async def test_realtime_bridge_absorbs_short_final_after_delegated_speech_starts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    runtime = _TurnRuntime()
    monkeypatch.setattr(
        voice_router,
        "CodexOAuthRealtimeProvider",
        lambda: _RealtimeProvider(sideband),
    )
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    await sideband.incoming.put(
        {
            "type": "delegation.created",
            "item": {
                "id": "short-answer-delegation",
                "type": "delegation",
                "target": "client",
                "content": [{"type": "input_text", "text": "C"}],
            },
        }
    )
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await _wait_for(lambda: any(message.get("type") == "handoff" for message in ws.sent))
    await ws.incoming.put(
        {
            "type": "turn_started",
            "handoff_id": "short-answer-delegation",
            "turn_id": "short-answer-turn",
            "session_id": "chat-session",
        }
    )
    await _wait_for(lambda: bool(sideband.speech))

    # The provider's final event is the other representation of the same
    # utterance, even though its transcript contains extra words.
    await sideband.incoming.put(
        {
            "type": "turn.done",
            "turn": {
                "id": "short-answer-final",
                "role": "user",
                "transcript": "答案 C",
            },
        }
    )
    await asyncio.sleep(0.05)
    await ws.incoming.put({"type": "stop"})
    await task

    handoffs = [message for message in ws.sent if message.get("type") == "handoff"]
    assert [message.get("handoff_id") for message in handoffs] == ["short-answer-delegation"]
    assert runtime.cancelled_turns == []
    assert not any(message.get("state") == "interrupted" for message in ws.sent)


@pytest.mark.asyncio
async def test_realtime_bridge_forwards_provider_commentary_without_cancelling_delegation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    runtime = _DelayedTurnRuntime()
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    try:
        await sideband.incoming.put(_DELEGATION_EVENT)
        await _wait_for(lambda: any(message.get("type") == "handoff" for message in ws.sent))
        await ws.incoming.put(
            {
                "type": "turn_started",
                "handoff_id": "delegation-1",
                "turn_id": "turn-1",
                "session_id": "chat-session",
            }
        )
        await _wait_for(lambda: runtime.subscribed.is_set())
        # Frameless Bidi emits delegation.created before the matching finalized
        # user turn. That late final must not replace the delegated correlation.
        await sideband.incoming.put(
            {
                "type": "turn.done",
                "turn": {
                    "id": "late-user-final",
                    "role": "user",
                    "transcript": "Explain this, please.",
                },
            }
        )
        await sideband.incoming.put(
            {
                "type": "input_transcript.added",
                "item": {"id": "late-user-partial", "text": "Explain this differently"},
            }
        )
        await sideband.incoming.put(
            {
                "type": "output_transcript.added",
                "item": {"id": "provider-commentary", "text": "Working on that"},
            }
        )
        await sideband.incoming.put({"type": "output_audio.delta", "audio": "AQID"})
        await sideband.incoming.put(
            {
                "type": "turn.done",
                "turn": {
                    "id": "provider-commentary-turn",
                    "role": "assistant",
                    "transcript": "Working on that",
                },
            }
        )
        await asyncio.sleep(0.05)
        runtime.release.set()

        await _wait_for(lambda: bool(sideband.speech))
        await asyncio.sleep(0.05)
        await sideband.incoming.put(
            {
                "type": "turn.done",
                "turn": {
                    "id": "delegated-output-turn",
                    "role": "assistant",
                    "transcript": "DeepTutor delayed answer",
                },
            }
        )
        await asyncio.sleep(0.05)
    finally:
        if not task.done():
            await ws.incoming.put({"type": "stop"})
        await task

    assert sideband.speech == [("delegation-1", "DeepTutor delayed answer")]
    assert runtime.cancelled_turns == []
    # Codex mode: provider commentary is forwarded, not muted.
    assert any(message.get("type") == "audio_output" for message in ws.sent)
    assert not any(message.get("type") == "error" for message in ws.sent)


@pytest.mark.asyncio
async def test_realtime_bridge_ignores_whitespace_partial_before_delegation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    runtime = _TurnRuntime()
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await _wait_for(lambda: any(message.get("type") == "webrtc_answer" for message in ws.sent))
    await sideband.incoming.put(
        {
            "type": "input_transcript.added",
            "item": {"id": "noise-only", "text": " \n\t "},
        }
    )
    await sideband.incoming.put(_DELEGATION_EVENT)
    await _wait_for(lambda: any(message.get("type") == "handoff" for message in ws.sent))
    await ws.incoming.put({"type": "stop"})
    await task

    assert not any(message.get("type") == "error" for message in ws.sent)


@pytest.mark.asyncio
async def test_realtime_bridge_does_not_send_after_provider_closes_socket(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _StrictRealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    runtime = _TurnRuntime()
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await _wait_for(lambda: any(message.get("type") == "webrtc_answer" for message in ws.sent))
    await sideband.incoming.put({"type": "error"})
    await _wait_for(lambda: ws.closed)
    await ws.incoming.put({"type": "stop"})
    await task

    assert not any(message.get("type") == "ended" for message in ws.sent)


@pytest.mark.asyncio
async def test_realtime_bridge_tolerates_autonomous_output_without_user_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    runtime = _TurnRuntime()
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    await sideband.incoming.put(
        {
            "type": "turn.done",
            "turn": {
                "id": "assistant-without-user",
                "role": "assistant",
                "transcript": "Unauthorized answer",
            },
        }
    )
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await asyncio.sleep(0.05)
    await ws.incoming.put({"type": "stop"})
    await task

    # An autonomous assistant answer with no user utterance starts no
    # DeepTutor turn, but it is never treated as an error either.
    assert not any(message.get("type") == "handoff" for message in ws.sent)
    assert not any(message.get("type") == "turn_rejected" for message in ws.sent)
    assert not any(message.get("type") == "error" for message in ws.sent)
    assert ws.close_code == 1000


@pytest.mark.asyncio
async def test_realtime_bridge_routes_late_delegation_without_replaying_final(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    runtime = _TurnRuntime()
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await sideband.incoming.put(
        {
            "type": "turn.done",
            "turn": {"id": "explicit-user-turn", "role": "user", "transcript": "答案 C"},
        }
    )
    await sideband.incoming.put(
        {
            "type": "delegation.created",
            "item": {
                "id": "explicit-delegation",
                "type": "delegation",
                "target": "client",
                "content": [{"type": "input_text", "text": "C"}],
            },
        }
    )
    await _wait_for(lambda: any(message.get("type") == "handoff" for message in ws.sent))
    await ws.incoming.put({"type": "stop"})
    await task

    handoffs = [message for message in ws.sent if message.get("type") == "handoff"]
    assert [message.get("handoff_id") for message in handoffs] == ["explicit-delegation"]
    assert len(
        [
            message
            for message in ws.sent
            if message.get("type") == "transcript" and message.get("phase") == "final"
        ]
    ) == 2
    assert runtime.cancelled_turns == []
    assert not any(message.get("state") == "interrupted" for message in ws.sent)
    assert sideband.closed


@pytest.mark.asyncio
async def test_realtime_bridge_keeps_direct_provider_turns_out_of_deeptutor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    runtime = _TurnRuntime()
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await sideband.incoming.put(
        {
            "type": "turn.done",
            "turn": {
                "id": "user-final",
                "role": "user",
                "transcript": "What is two plus two?",
            },
        }
    )
    await sideband.incoming.put({"type": "output_audio.delta", "audio": "AQID"})
    await sideband.incoming.put(
        {
            "type": "turn.done",
            "turn": {
                "id": "assistant-final",
                "role": "assistant",
                "transcript": "Two plus two equals four.",
            },
        }
    )
    await _wait_for(
        lambda: any(message.get("type") == "assistant_transcript" for message in ws.sent)
    )
    await ws.incoming.put({"type": "stop"})
    await task

    assert not any(message.get("type") == "handoff" for message in ws.sent)
    assert not any(message.get("state") == "interrupted" for message in ws.sent)
    assert runtime.cancelled_turns == []
    assert {
        "type": "transcript",
        "phase": "final",
        "mode": "provider",
        "provider_turn_id": "user-final",
        "text": "What is two plus two?",
    } in ws.sent
    assert {
        "type": "assistant_transcript",
        "phase": "final",
        "provider_turn_id": "assistant-final",
        "text": "Two plus two equals four.",
    } in ws.sent


@pytest.mark.asyncio
async def test_realtime_bridge_never_rejects_provider_direct_output(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    runtime = _TurnRuntime()
    store = _DirectSessionStore()
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(voice_router, "get_session_store", lambda: store)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await sideband.incoming.put(
        {
            "type": "turn.done",
            "turn": {
                "id": "exam-user-turn",
                "role": "user",
                "transcript": "Can I see the answer?",
            },
        }
    )
    await sideband.incoming.put({"type": "output_audio.delta", "audio": "AQID"})
    await sideband.incoming.put(
        {
            "type": "turn.done",
            "turn": {
                "id": "exam-assistant-turn",
                "role": "assistant",
                "transcript": "Unauthorized exam answer",
            },
        }
    )
    await _wait_for(
        lambda: any(message.get("type") == "assistant_transcript" for message in ws.sent)
    )
    assert not ws.closed

    # A later native delegation is the only event that enters DeepTutor.
    # normal delegated path in the same microphone session.
    await sideband.incoming.put(_DELEGATION_EVENT)
    await _wait_for(
        lambda: any(
            message.get("type") == "handoff" and message.get("handoff_id") == "delegation-1"
            for message in ws.sent
        )
    )
    await ws.incoming.put({"type": "stop"})
    await task

    handoffs = [message for message in ws.sent if message.get("type") == "handoff"]
    assert [message.get("handoff_id") for message in handoffs] == ["delegation-1"]
    assert not any(message.get("state") == "interrupted" for message in ws.sent)
    assert not any(message.get("type") == "turn_rejected" for message in ws.sent)
    assert not any(message.get("code") == "delegation_required" for message in ws.sent)
    assert not any("answered without native delegation" in record.message for record in caplog.records)
    # Provider audio is forwarded (single audio source, no gate).
    assert any(message.get("type") == "audio_output" for message in ws.sent)
    assert not any(message.get("type") == "playback_authorized" for message in ws.sent)
    assert not store.messages
    assert ws.close_code == 1000


@pytest.mark.asyncio
async def test_realtime_bridge_dedupes_provider_final_by_turn_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    event = {
        "type": "turn.done",
        "turn": {
            "id": "voice-turn-direct",
            "role": "user",
            "transcript": "What is two plus two?",
        },
    }
    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await sideband.incoming.put(event)
    await sideband.incoming.put(event)
    await _wait_for(
        lambda: any(
            message.get("type") == "transcript" and message.get("phase") == "final"
            for message in ws.sent
        )
    )
    await ws.incoming.put({"type": "stop"})
    await task

    finals = [
        message
        for message in ws.sent
        if message.get("type") == "transcript" and message.get("phase") == "final"
    ]
    assert len(finals) == 1
    assert not any(message.get("type") == "handoff" for message in ws.sent)
    assert not any(message.get("state") == "interrupted" for message in ws.sent)


@pytest.mark.asyncio
async def test_realtime_bridge_leaves_provider_barge_in_to_gpt_live(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    runtime = _StreamingTurnRuntime()
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    await sideband.incoming.put(_DELEGATION_EVENT)
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await _wait_for(lambda: any(message.get("type") == "handoff" for message in ws.sent))
    await ws.incoming.put(
        {
            "type": "turn_started",
            "handoff_id": "delegation-1",
            "turn_id": "question-turn",
            "session_id": "chat-session",
        }
    )
    await _wait_for(lambda: bool(sideband.speech))
    await sideband.incoming.put(
        {
            "type": "turn.done",
            "turn": {"id": "barge-in-user", "role": "user", "transcript": "答案 C"},
        }
    )
    await sideband.incoming.put(
        {
            "type": "turn.done",
            "turn": {
                "id": "barge-in-assistant",
                "role": "assistant",
                "transcript": "Provider direct answer",
            },
        }
    )
    await _wait_for(
        lambda: any(message.get("type") == "assistant_transcript" for message in ws.sent)
    )

    runtime.release.set()
    await ws.incoming.put({"type": "stop"})
    await task

    handoffs = [message for message in ws.sent if message.get("type") == "handoff"]
    assert [message.get("handoff_id") for message in handoffs] == ["delegation-1"]
    assert runtime.cancelled_turns == []
    assert not any(message.get("state") == "interrupted" for message in ws.sent)


@pytest.mark.asyncio
async def test_realtime_bridge_routes_new_delegation_without_voice_interruption(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    runtime = _StreamingTurnRuntime()
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    await sideband.incoming.put(_DELEGATION_EVENT)
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await _wait_for(lambda: any(message.get("type") == "handoff" for message in ws.sent))
    await ws.incoming.put(
        {
            "type": "turn_started",
            "handoff_id": "delegation-1",
            "turn_id": "turn-1",
            "session_id": "chat-session",
        }
    )
    await _wait_for(lambda: bool(sideband.speech))
    await sideband.incoming.put(
        {
            "type": "delegation.created",
            "item": {
                "id": "delegation-2",
                "type": "delegation",
                "target": "client",
                "content": [{"type": "input_text", "text": "new instruction"}],
            },
        }
    )
    await _wait_for(
        lambda: any(message.get("handoff_id") == "delegation-2" for message in ws.sent)
    )

    runtime.release.set()
    await ws.incoming.put({"type": "stop"})
    await task

    handoffs = [message.get("handoff_id") for message in ws.sent if message.get("type") == "handoff"]
    assert handoffs == ["delegation-1", "delegation-2"]
    assert runtime.cancelled_turns == []
    assert not any(message.get("state") == "interrupted" for message in ws.sent)


@pytest.mark.asyncio
async def test_realtime_bridge_cancel_output_stays_fail_open(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    store = _DirectSessionStore()
    runtime = _TurnRuntime()
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(voice_router, "get_session_store", lambda: store)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await sideband.incoming.put(_DELEGATION_EVENT)
    await _wait_for(lambda: any(message.get("type") == "handoff" for message in ws.sent))
    await ws.incoming.put(
        {
            "type": "turn_started",
            "handoff_id": "delegation-1",
            "turn_id": "turn-cancel",
            "session_id": "chat-session",
        }
    )
    await _wait_for(lambda: bool(sideband.speech))
    await sideband.incoming.put(
        {
            "type": "output_transcript.added",
            "item": {"id": "assistant-partial-cancel", "text": "I will explain"},
        }
    )
    await sideband.incoming.put({"type": "output_audio.delta", "audio": "AQID"})
    await asyncio.sleep(0.05)
    await ws.incoming.put({"type": "cancel_output"})
    await _wait_for(lambda: any(message.get("state") == "interrupted" for message in ws.sent))
    await sideband.incoming.put({"type": "output_audio.delta", "audio": "AQID"})
    await sideband.incoming.put(
        {
            "type": "turn.done",
            "turn": {
                "id": "assistant-turn-late",
                "role": "assistant",
                "transcript": "Late answer must not persist.",
            },
        }
    )
    await asyncio.sleep(0.05)
    await ws.incoming.put({"type": "stop"})
    await task

    assert any(message.get("state") == "interrupted" for message in ws.sent)
    assert not any(message.get("type") == "turn_rejected" for message in ws.sent)
    assert not any(message.get("type") == "error" for message in ws.sent)
    assert not store.messages


@pytest.mark.asyncio
async def test_realtime_bridge_cancels_runtime_and_suppresses_late_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.session as session_services

    ws = _RealtimeWebSocket()
    sideband = _RealtimeSideband()
    provider = _RealtimeProvider(sideband)
    runtime = _TurnRuntime(wait_for_cancel=True)
    monkeypatch.setattr(voice_router, "CodexOAuthRealtimeProvider", lambda: provider)
    monkeypatch.setattr(session_services, "get_turn_runtime_manager", lambda: runtime)
    monkeypatch.setattr(
        voice_router,
        "build_realtime_context_snapshot",
        _fake_context_snapshot,
    )

    await ws.incoming.put({"type": "start", "sdp": "controlled-offer"})
    await sideband.incoming.put(_DELEGATION_EVENT)
    task = asyncio.create_task(voice_router._serve_codex_realtime(ws))
    await _wait_for(lambda: any(message.get("type") == "handoff" for message in ws.sent))
    await ws.incoming.put(
        {
            "type": "turn_started",
            "handoff_id": "delegation-1",
            "turn_id": "turn-1",
            "session_id": "chat-session",
        }
    )
    await asyncio.wait_for(runtime.subscribed.wait(), timeout=2)
    await ws.incoming.put({"type": "cancel_output"})
    await asyncio.wait_for(runtime.cancelled.wait(), timeout=2)
    await sideband.incoming.put({"type": "output_audio.delta", "audio": "AQID"})
    await _wait_for(lambda: any(message.get("state") == "listening" for message in ws.sent))
    await asyncio.sleep(0.05)
    await ws.incoming.put({"type": "stop"})
    await task

    assert runtime.cancelled_turns == ["turn-1"]
    assert sideband.speech == []
    assert any(message.get("state") == "interrupted" for message in ws.sent)
    # Raw provider audio never crosses the normalized boundary either way.
    assert "AQID" not in json.dumps(ws.sent)
