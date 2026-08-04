"""Voice endpoints — text-to-speech and speech-to-text.

These are thin HTTP surfaces over :mod:`deeptutor.services.voice`. Config comes
from the admin-managed model catalog (``services.tts`` / ``services.stt``), so
voice is shared infrastructure like embedding/search — any authenticated user
may call it; it is not gated by per-user LLM grants.
"""

from __future__ import annotations

import asyncio
import io
import logging
from uuid import uuid4
import wave

from fastapi import (
    APIRouter,
    File,
    Form,
    HTTPException,
    Response,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from pydantic import BaseModel, Field

from deeptutor.services.session import get_session_store
from deeptutor.services.voice import (
    VoiceProviderError,
    synthesize_speech,
    transcribe_audio,
)
from deeptutor.services.voice.context_snapshot import (
    RealtimeContextError,
    RealtimeContextRequest,
    RealtimeContextSnapshot,
    build_realtime_context_snapshot,
)
from deeptutor.services.voice.realtime import (
    CodexOAuthRealtimeProvider,
    CodexRealtimeSideband,
    RealtimeVoiceProviderError,
    normalize_codex_event,
    realtime_voice_status,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Guard against pathological uploads (the providers cap well below this anyway).
_MAX_AUDIO_BYTES = 25 * 1024 * 1024  # 25 MB, matching OpenAI's limit.
_DEFAULT_PCM_SAMPLE_RATE = 24_000
_DEFAULT_PCM_CHANNELS = 1
_PCM16_SAMPLE_WIDTH = 2


class TTSRequest(BaseModel):
    """Text-to-speech request body."""

    text: str = Field(..., min_length=1)
    voice: str | None = None
    format: str | None = None


def _parse_pcm_content_type(content_type: str) -> tuple[int, int] | None:
    """Return ``(sample_rate, channels)`` when a provider sent raw PCM audio."""
    media_type, *params = (content_type or "").split(";")
    if media_type.strip().lower() not in {"audio/pcm", "audio/x-pcm", "audio/l16"}:
        return None
    sample_rate = _DEFAULT_PCM_SAMPLE_RATE
    channels = _DEFAULT_PCM_CHANNELS
    for item in params:
        key, sep, value = item.strip().partition("=")
        if not sep:
            continue
        key = key.strip().lower()
        value = value.strip().strip('"')
        try:
            parsed = int(value)
        except ValueError:
            continue
        if key in {"rate", "sample-rate", "samplerate"} and parsed > 0:
            sample_rate = parsed
        elif key in {"channels", "channel"} and parsed > 0:
            channels = parsed
    return sample_rate, channels


def _pcm16_to_wav(audio: bytes, *, sample_rate: int, channels: int) -> bytes:
    """Wrap provider PCM16 bytes in a WAV container browsers can play."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(_PCM16_SAMPLE_WIDTH)
        wav.setframerate(sample_rate)
        wav.writeframes(audio)
    return buffer.getvalue()


@router.post("/tts")
async def text_to_speech(payload: TTSRequest) -> Response:
    """Synthesize ``text`` to audio using the active TTS provider."""
    try:
        audio, content_type = await synthesize_speech(
            payload.text,
            voice=payload.voice,
            response_format=payload.format,
        )
    except ValueError as exc:  # missing/invalid configuration
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except VoiceProviderError as exc:
        logger.warning("TTS provider error: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    pcm_info = _parse_pcm_content_type(content_type)
    if pcm_info:
        sample_rate, channels = pcm_info
        audio = _pcm16_to_wav(audio, sample_rate=sample_rate, channels=channels)
        content_type = "audio/wav"
    return Response(
        content=audio,
        media_type=content_type,
        headers={"Cache-Control": "no-store"},
    )


@router.post("/stt")
async def speech_to_text(
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
) -> dict[str, str]:
    """Transcribe an uploaded audio clip using the active STT provider."""
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty audio upload.")
    if len(audio) > _MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Audio exceeds the 25 MB limit.",
        )
    try:
        text = await transcribe_audio(
            audio,
            filename=file.filename or "audio.webm",
            content_type=file.content_type or "application/octet-stream",
            language=language,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except VoiceProviderError as exc:
        logger.warning("STT provider error: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    return {"text": text}


@router.get("/realtime/status")
async def realtime_voice_provider_status() -> dict[str, object]:
    """Return credential-free readiness for the independent Realtime provider."""
    return realtime_voice_status().public_dict()


async def _serve_codex_realtime(ws: WebSocket) -> None:
    """Bridge WebRTC, Codex handoffs, and the normal DeepTutor turn runtime."""
    closed = False
    session: CodexRealtimeSideband | None = None
    pending_handoffs: set[str] = set()
    seen_handoffs: set[str] = set()
    active_turns: dict[str, str] = {}
    cancelled_handoffs: set[str] = set()
    turn_tasks: set[asyncio.Task[None]] = set()
    provider_turn: dict[str, object] = {
        "route": "idle",
        "provider_output_done": False,
    }
    seen_provider_user_turns: set[str] = set()
    seen_provider_assistant_turns: set[str] = set()
    cancellation_lock = asyncio.Lock()
    context_snapshot: RealtimeContextSnapshot | None = None
    session_store = get_session_store()

    async def send(payload: dict[str, object]) -> None:
        nonlocal closed
        if closed:
            return
        try:
            await ws.send_json(payload)
        except RuntimeError as exc:
            if 'Cannot call "send" once a close message has been sent.' not in str(exc):
                raise
            closed = True

    async def close_socket(code: int) -> None:
        nonlocal closed
        closed = True
        try:
            await ws.close(code=code)
        except RuntimeError as exc:
            if 'Cannot call "send" once a close message has been sent.' not in str(exc):
                raise

    def _validate_provider_id(value: object, *, label: str) -> str:
        candidate = str(value or "").strip()
        allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-"
        if not candidate or len(candidate) > 160 or any(char not in allowed for char in candidate):
            raise RealtimeVoiceProviderError(f"Realtime Voice Session returned an invalid {label}.")
        return candidate

    def _validate_provider_text(value: object) -> str:
        text = str(value or "").strip()
        if not text or len(text) > 12_000:
            raise RealtimeVoiceProviderError(
                "Realtime Voice Session returned an invalid finalized transcript."
            )
        return text

    async def forward_provider_user_turn(
        provider_turn_id: object,
        raw_text: object,
    ) -> None:
        provider_id = str(provider_turn_id or "").strip()
        if provider_id:
            provider_id = _validate_provider_id(provider_id, label="provider turn id")
            if provider_id in seen_provider_user_turns:
                return
            seen_provider_user_turns.add(provider_id)
        await send(
            {
                "type": "transcript",
                "phase": "final",
                "mode": "provider",
                "provider_turn_id": provider_id,
                "text": _validate_provider_text(raw_text),
            }
        )

    async def announce_delegation(handoff_id: object, raw_text: object) -> None:
        """Commit one native client delegation into DeepTutor's turn path."""
        delegation_id = _validate_provider_id(handoff_id, label="handoff id")
        text = _validate_provider_text(raw_text)
        async with cancellation_lock:
            if delegation_id in seen_handoffs:
                return
            seen_handoffs.add(delegation_id)
            provider_turn.clear()
            provider_turn.update(
                {
                    "route": "delegated",
                    "text": text,
                    "finalized": True,
                    "delegation_id": delegation_id,
                    "handoff_response_sent": False,
                }
            )
            pending_handoffs.add(delegation_id)
        logger.info("Realtime Voice route committed: delegated")
        await send({"type": "handoff", "handoff_id": delegation_id, "text": text})
        await send(
            {
                "type": "transcript",
                "phase": "final",
                "mode": "delegated",
                "handoff_id": delegation_id,
                "text": text,
            }
        )

    async def forward_provider_assistant_turn(
        provider_turn_id: object,
        raw_text: object,
    ) -> None:
        provider_id = str(provider_turn_id or "").strip()
        if provider_id:
            provider_id = _validate_provider_id(provider_id, label="assistant turn id")
            if provider_id in seen_provider_assistant_turns:
                return
            seen_provider_assistant_turns.add(provider_id)
        provider_turn["provider_output_done"] = True
        await send(
            {
                "type": "assistant_transcript",
                "phase": "final",
                "provider_turn_id": provider_id,
                "text": _validate_provider_text(raw_text),
            }
        )

    async def cancel_active_turns() -> bool:
        """Establish the cancellation boundary before awaiting runtime cleanup."""
        from deeptutor.services.session import get_turn_runtime_manager

        runtime = get_turn_runtime_manager()
        async with cancellation_lock:
            provider_active = (
                provider_turn.get("route")
                in {
                    "pending",
                    "delegated",
                    "delegated_completed",
                }
                and not provider_turn.get("provider_output_done")
            )
            interrupted = bool(pending_handoffs or active_turns or provider_active)
            cancelled_handoffs.update(pending_handoffs)
            cancelled_handoffs.update(active_turns)
            pending_handoffs.clear()
            turn_ids = list(active_turns.values())
            if provider_active:
                provider_turn["route"] = "cancelled"
        # GPT-Live V3 has no per-response cancellation event. Barge-in remains
        # local while DeepTutor-owned turns are cooperatively cancelled below.
        for turn_id in turn_ids:
            try:
                await runtime.cancel_turn(turn_id)
            except Exception:
                logger.debug("Failed to cancel Realtime-backed turn %s", turn_id, exc_info=True)
        return interrupted

    async def deliver_speech(handoff_id: str, text: str) -> bool:
        """Append canonical speech only after checking the cancellation boundary."""
        if session is None:
            raise RealtimeVoiceProviderError("Realtime Voice sideband is unavailable.")
        async with cancellation_lock:
            if handoff_id in cancelled_handoffs:
                return False
            if provider_turn.get("delegation_id") == handoff_id:
                provider_turn["handoff_response_sent"] = True
                provider_turn["provider_output_done"] = False
            provider_turn["audio_logged"] = False
            logger.info(
                "Realtime Voice speech appended: handoff=%s chars=%d",
                handoff_id,
                len(text),
            )
            await session.send_handoff_speech(handoff_id, text)
        return True

    async def forward_turn(handoff_id: str, turn_id: str, session_id: str) -> None:
        from deeptutor.services.session import get_turn_runtime_manager

        runtime = get_turn_runtime_manager()
        turn = await runtime.store.get_turn(turn_id)
        if not turn or str(turn.get("session_id") or "") != session_id:
            await send(
                {
                    "type": "error",
                    "code": "invalid_turn_binding",
                    "message": "Realtime Voice turn binding is invalid.",
                }
            )
            return
        async with cancellation_lock:
            if handoff_id in cancelled_handoffs:
                return
            active_turns[handoff_id] = turn_id
        speech_buffer: list[str] = []
        last_speech_flush = asyncio.get_running_loop().time()

        async def flush_speech(*, force: bool = False) -> bool:
            nonlocal last_speech_flush
            if not speech_buffer:
                return True
            now = asyncio.get_running_loop().time()
            if not force and now - last_speech_flush < 0.2:
                return True
            text = "".join(speech_buffer)
            speech_buffer.clear()
            last_speech_flush = now
            return await deliver_speech(handoff_id, text)

        try:
            async for event in runtime.subscribe_turn(turn_id):
                if handoff_id in cancelled_handoffs:
                    return
                event_type = str(event.get("type") or "")
                metadata = event.get("metadata")
                metadata = metadata if isinstance(metadata, dict) else {}
                if event_type == "content":
                    text = str(event.get("content") or "")
                    call_id = str(metadata.get("call_id") or "")
                    call_kind = str(metadata.get("call_kind") or "")
                    if not text or (
                        call_id and call_kind not in {"agent_loop_round", "llm_final_response"}
                    ):
                        continue
                    # ponytail: spoken output follows the live UI and may include a
                    # provisional narration round; add BEM-style phase tags if
                    # narration must remain silent before its late role marker.
                    speech_buffer.append(text)
                    if not await flush_speech():
                        return
                elif event_type == "progress" and metadata.get("call_state") == "complete":
                    if not await flush_speech(force=True):
                        return
                elif event_type == "done":
                    await flush_speech(force=True)
                    return
        except RealtimeVoiceProviderError as exc:
            if not closed:
                await send(
                    {
                        "type": "error",
                        "code": "realtime_handoff_error",
                        "message": str(exc),
                    }
                )
        finally:
            async with cancellation_lock:
                active_turns.pop(handoff_id, None)
                cancelled_handoffs.discard(handoff_id)
                if (
                    provider_turn.get("route") == "delegated"
                    and provider_turn.get("delegation_id") == handoff_id
                ):
                    provider_turn["route"] = "delegated_completed"

    start_message = await ws.receive_json()
    prepared_context = False
    if isinstance(start_message, dict) and start_message.get("type") == "prepare":
        try:
            requested_session_id = start_message.get("session_id")
            context_request = RealtimeContextRequest.from_payload(
                start_message.get("context"),
                session_id=(
                    str(requested_session_id).strip() if requested_session_id is not None else None
                ),
            )
            context_snapshot = await build_realtime_context_snapshot(
                session_store,
                context_request,
            )
        except RealtimeContextError as exc:
            await send(
                {
                    "type": "error",
                    "code": "realtime_context_unavailable",
                    "message": str(exc),
                }
            )
            await close_socket(1011)
            return
        await send(
            {
                "type": "context_ready",
                "session_id": context_snapshot.session_id,
                **context_snapshot.public_metadata(),
            }
        )
        prepared_context = True
        start_message = await ws.receive_json()

    if not isinstance(start_message, dict) or start_message.get("type") != "start":
        await send(
            {
                "type": "error",
                "code": "invalid_session_start",
                "message": "Realtime Voice Session must start with a WebRTC offer.",
            }
        )
        await close_socket(1008)
        return
    offer_sdp = start_message.get("sdp")
    if not isinstance(offer_sdp, str) or not offer_sdp.strip():
        await send(
            {
                "type": "error",
                "code": "invalid_webrtc_offer",
                "message": "Realtime Voice Session WebRTC offer is empty or invalid.",
            }
        )
        await close_socket(1008)
        return

    try:
        if not prepared_context:
            requested_session_id = start_message.get("session_id")
            context_request = RealtimeContextRequest.from_payload(
                start_message.get("context"),
                session_id=(
                    str(requested_session_id).strip() if requested_session_id is not None else None
                ),
            )
            context_snapshot = await build_realtime_context_snapshot(
                session_store,
                context_request,
            )
        if context_snapshot is None:
            raise RealtimeVoiceProviderError("Realtime Voice context was not prepared.")
        provider = CodexOAuthRealtimeProvider()
        call = await provider.create_call(
            offer_sdp,
            # Provider correlation is intentionally independent from the
            # browser/DeepTutor session id used to bind committed turns.
            session_id=f"deeptutor-{uuid4().hex}",
            instructions=context_snapshot.instructions,
            initial_items=context_snapshot.initial_items,
        )
        session = await provider.connect_sideband(call)
        logger.info(
            "Realtime Voice provider session ready: session=%s capability=%s exam=%s",
            context_snapshot.session_id,
            context_snapshot.capability,
            context_snapshot.exam_mode,
        )
        # The SDP answer and content-free session metadata are public to the
        # browser. OAuth, the call id, and the full context snapshot stay server-side.
        await send(
            {
                "type": "session_ready",
                "session_id": context_snapshot.session_id,
                **context_snapshot.public_metadata(),
            }
        )
        await send({"type": "webrtc_answer", "sdp": call.answer_sdp})
        await send({"type": "state", "state": "connected"})
        await send({"type": "state", "state": "listening"})
    except RealtimeContextError as exc:
        logger.warning("Realtime Voice session setup failed (context): %s", exc)
        await send(
            {
                "type": "error",
                "code": "realtime_context_unavailable",
                "message": str(exc),
            }
        )
        await close_socket(1011)
        return
    except RealtimeVoiceProviderError as exc:
        logger.warning("Realtime Voice session setup failed (provider): %s", exc)
        await send(
            {
                "type": "error",
                "code": "realtime_provider_unavailable",
                "message": str(exc),
            }
        )
        await close_socket(1011)
        return

    async def forward_provider_events() -> None:
        nonlocal closed
        if session is None:
            raise RealtimeVoiceProviderError("Realtime Voice sideband is unavailable.")
        provider_stream_active = False
        try:
            async for provider_event in session.events():
                if provider_event.get("type") == "error":
                    error = provider_event.get("error")
                    error_message = provider_event.get("message")
                    if not isinstance(error_message, str) and isinstance(error, dict):
                        error_message = error.get("message")
                    if isinstance(error_message, str):
                        error_message = " ".join(error_message.split())[:300]
                        if any(
                            marker in error_message.casefold()
                            for marker in (
                                "authorization",
                                "bearer ",
                                "access_token",
                                "refresh_token",
                            )
                        ):
                            error_message = "[redacted credential-bearing provider error]"
                    else:
                        error_message = None
                    logger.warning(
                        "Realtime Voice provider error: type=%s code=%s param=%s message=%r",
                        error.get("type") if isinstance(error, dict) else None,
                        error.get("code") if isinstance(error, dict) else None,
                        error.get("param") if isinstance(error, dict) else None,
                        error_message,
                    )
                if not provider_stream_active:
                    provider_stream_active = True
                    logger.info("Realtime Voice provider stream active")
                if (
                    provider_event.get("type") == "output_audio.delta"
                    and not provider_turn.get("audio_logged")
                ):
                    provider_turn["audio_logged"] = True
                    logger.info("Realtime Voice provider audio output started")
                for normalized in normalize_codex_event(provider_event):
                    event_type = normalized.get("type")
                    if event_type == "handoff":
                        await announce_delegation(
                            normalized.get("handoff_id"),
                            normalized.get("text"),
                        )
                        continue
                    if event_type == "provider_user_turn":
                        await forward_provider_user_turn(
                            normalized.get("provider_turn_id"),
                            normalized.get("text"),
                        )
                        continue
                    if event_type == "provider_assistant_turn":
                        await forward_provider_assistant_turn(
                            normalized.get("provider_turn_id"),
                            normalized.get("text"),
                        )
                        continue
                    if (
                        event_type == "assistant_transcript"
                        and normalized.get("phase") == "partial"
                    ):
                        provider_turn["assistant_started"] = True
                    # Delegation announcements already emit the canonical final
                    # transcript. Never forward the provider's internal copy.
                    if event_type == "transcript" and normalized.get("phase") == "final":
                        continue
                    await send(normalized)
        except RealtimeVoiceProviderError as exc:
            logger.warning("Realtime Voice provider policy error: %s", exc)
            if not closed:
                await send(
                    {
                        "type": "error",
                        "code": "realtime_provider_error",
                        "message": str(exc),
                    }
                )
        finally:
            if not closed:
                await close_socket(1011)

    event_task = asyncio.create_task(forward_provider_events())
    try:
        while not closed:
            message = await ws.receive_json()
            if closed:
                break
            message_type = message.get("type") if isinstance(message, dict) else None
            if message_type == "client_diagnostic":
                event = str(message.get("event") or "").strip()
                allowed_events = {
                    "remote_track",
                    "provider_audio_delta",
                    "audio_play_resolved",
                    "audio_play_failed",
                    "audio_onplaying",
                    "inbound_audio_stats",
                }
                if event in allowed_events:
                    detail = " ".join(str(message.get("detail") or "").split())[:160]
                    logger.info(
                        "Realtime Voice client audio: event=%s detail=%s",
                        event,
                        detail,
                    )
                continue
            if message_type == "turn_started":
                handoff_id = str(message.get("handoff_id") or "").strip()
                turn_id = str(message.get("turn_id") or "").strip()
                bound_session_id = str(message.get("session_id") or "").strip()
                if handoff_id in cancelled_handoffs:
                    continue
                if (
                    not handoff_id
                    or not turn_id
                    or not bound_session_id
                    or handoff_id not in pending_handoffs
                ):
                    await send(
                        {
                            "type": "error",
                            "code": "invalid_turn_binding",
                            "message": "Realtime Voice turn binding is invalid.",
                        }
                    )
                    await close_socket(1008)
                    continue
                pending_handoffs.discard(handoff_id)
                task = asyncio.create_task(forward_turn(handoff_id, turn_id, bound_session_id))
                turn_tasks.add(task)
                task.add_done_callback(turn_tasks.discard)
                continue
            if message_type == "cancel_output":
                await send({"type": "state", "state": "interrupted"})
                await cancel_active_turns()
                await send({"type": "state", "state": "listening"})
                continue
            if message_type == "stop":
                await cancel_active_turns()
                await session.close()
                await send({"type": "state", "state": "ended"})
                await close_socket(1000)
                continue
            if message_type == "ping":
                await send({"type": "pong"})
                continue
            await send(
                {
                    "type": "error",
                    "code": "unknown_message",
                    "message": f"Unknown Realtime Voice Session message: {message_type}",
                }
            )
    except WebSocketDisconnect:
        closed = True
    except RealtimeVoiceProviderError as exc:
        if not closed:
            await send({"type": "error", "code": "realtime_provider_error", "message": str(exc)})
            await close_socket(1011)
    finally:
        closed = True
        await cancel_active_turns()
        event_task.cancel()
        for task in list(turn_tasks):
            task.cancel()
        await asyncio.gather(event_task, *turn_tasks, return_exceptions=True)
        if session is not None:
            await session.close()


@router.websocket("/realtime")
async def realtime_voice_session(ws: WebSocket) -> None:
    """Serve the normalized server-side Codex Realtime Voice boundary."""
    from deeptutor.api.routers.auth import ws_auth_failed, ws_require_auth
    from deeptutor.multi_user.context import reset_current_user

    user_token = await ws_require_auth(ws)
    if user_token is ws_auth_failed:
        return

    await ws.accept()
    closed = False

    async def send(payload: dict[str, object]) -> None:
        if not closed:
            await ws.send_json(payload)

    try:
        await _serve_codex_realtime(ws)
    except WebSocketDisconnect:
        logger.debug("Realtime Voice Session client disconnected")
    except Exception as exc:  # noqa: BLE001 — close the session fail-closed
        logger.warning("Realtime Voice Session failed: %s", exc)
        if not closed:
            try:
                await send(
                    {
                        "type": "error",
                        "code": "realtime_session_error",
                        "message": "Realtime Voice Session failed.",
                    }
                )
                await ws.close(code=1011)
            except Exception:
                pass
    finally:
        reset_current_user(user_token)  # type: ignore[arg-type]  # sentinel returned above
