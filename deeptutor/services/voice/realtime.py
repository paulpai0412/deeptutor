"""Codex OAuth GPT-Live AVAS transport.

The browser owns the WebRTC media leg. DeepTutor creates the call with a
server-only Codex OAuth credential and joins its Frameless Bidi sideband. GPT-Live
is the conversational frontend for bounded direct answers; when it delegates,
DeepTutor's normal turn runtime reasons, uses tools, or creates artifacts.
Delegated assistant text is returned on the provider's explicit ``speakable``
channel.

There is intentionally no PCM/WebSocket fallback and no legacy Quicksilver V1
path. Unsupported or malformed provider contracts fail closed.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
import json
import os
import re
from typing import Any, Protocol

import httpx
from websockets.asyncio.client import connect as websocket_connect

from deeptutor.services.config.runtime_settings import (
    DEFAULT_REALTIME_VOICE_SETTINGS,
    get_runtime_settings_service,
)
from deeptutor.services.llm.openai_http_client import disable_ssl_verify_enabled
from deeptutor.services.llm.provider_core.openai_codex_provider import (
    _build_headers,
    load_codex_oauth_token,
)

DEFAULT_CODEX_REALTIME_CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls"
DEFAULT_CODEX_REALTIME_SIDEBAND_URL = "wss://api.openai.com/v1/live"
DEFAULT_REALTIME_PROVIDER = "openai_codex"
REALTIME_CALL_URL_ENV = "DEEPTUTOR_CODEX_REALTIME_CALL_URL"
REALTIME_SIDEBAND_URL_ENV = "DEEPTUTOR_CODEX_REALTIME_SIDEBAND_URL"
CODEX_LOGIN_COMMAND = "deeptutor provider login openai-codex"
CODEX_REALTIME_VOICE = str(DEFAULT_REALTIME_VOICE_SETTINGS["voice"])
CODEX_REALTIME_MODEL = str(DEFAULT_REALTIME_VOICE_SETTINGS["model"])
SUPPORTED_CODEX_REALTIME_MODELS = (CODEX_REALTIME_MODEL,)
# Official Codex V3 validates against the Frameless/V1 voice set.
SUPPORTED_CODEX_REALTIME_VOICES = (
    "juniper",
    "maple",
    "spruce",
    "ember",
    "vale",
    "breeze",
    "arbor",
    "sol",
    "cove",
)
CODEX_REALTIME_ALPHA = "quicksilver=v2"
CODEX_REALTIME_ORIGINATOR = "DeepTutor"
REALTIME_CONTEXT_CHUNK_BYTES = 500
DEFAULT_REALTIME_INSTRUCTIONS = (
    "You are only the realtime speech front end for an external DeepTutor agent. "
    "For EVERY completed user utterance, without exception—including greetings, casual "
    "conversation, and simple arithmetic—you MUST create a delegation to the client and "
    "then wait. NEVER answer, explain, reason, call tools, translate, paraphrase, or emit "
    "assistant text or audio on your own. If the user speaks while you are vocalizing "
    "appended speakable text, immediately stop speaking and treat the complete interruption "
    "as a new completed user turn. This includes short exam answers such as A, B, C, D, "
    "yes, or no, plus corrections, hint, skip, repeat, and next-question requests. Create "
    "exactly one client delegation for that utterance and then wait. Barge-in is NEVER "
    "permission to answer directly, judge the answer, advance the exam, explain, or emit "
    "assistant text or audio. When speakable text is appended to that exact delegation, "
    "vocalize it verbatim in its original language, preserving every word, number, and "
    "ordering; do not add, omit, paraphrase, or translate anything."
)

# Provider ids are not credentials, but strict validation prevents arbitrary URL
# components and malformed sideband messages.
_CALL_ID_RE = re.compile(
    r"^(?:rtc_[A-Za-z0-9_-]+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$"
)
_ITEM_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,512}$")
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,200}$")
_MEDIA_LINE_RE = {kind: re.compile(rf"(?m)^m={kind}\s") for kind in ("audio", "application")}
_LEGACY_EVENT_TYPES = {
    "conversation.handoff.requested",
    "conversation.input_transcript.delta",
    "conversation.input_transcript.turn_marked",
    "conversation.item.input_audio_transcription.completed",
    "conversation.item.input_audio_transcription.delta",
    "conversation.output_audio.delta",
    "conversation.output_transcript.delta",
    "response.cancelled",
    "response.created",
    "response.done",
    "response.output_audio_transcript.delta",
    "response.output_audio_transcript.done",
}
_GPT_LIVE_V3_OUTBOUND_EVENT_TYPES = frozenset(
    {
        "session.update",
        "session.context.append",
        "delegation.context.append",
        "delegation.function_call_output.create",
        "session.close",
    }
)


class RealtimeVoiceProviderError(RuntimeError):
    """Safe, actionable provider error suitable for the browser boundary."""


class RealtimeSocket(Protocol):
    async def send(self, message: str) -> None: ...

    def __aiter__(self) -> AsyncIterator[str | bytes]: ...

    async def close(self, *args: Any, **kwargs: Any) -> None: ...


@dataclass(frozen=True, slots=True)
class RealtimeVoiceProviderStatus:
    provider: str
    ready: bool
    message: str
    login_command: str | None = None

    def public_dict(self) -> dict[str, Any]:
        """Return the intentionally credential-free settings payload."""
        return {
            "provider": self.provider,
            "ready": self.ready,
            "message": self.message,
            "login_command": self.login_command,
        }


@dataclass(frozen=True, slots=True)
class CodexRealtimeCall:
    """The SDP answer is public to the browser; auth headers stay private."""

    answer_sdp: str
    call_id: str
    _sideband_headers: dict[str, str] = field(repr=False, compare=False)


def configured_realtime_provider() -> str:
    """Resolve the independent provider without consulting STT/TTS settings."""
    settings = get_runtime_settings_service().load_realtime_voice()
    return str(settings.get("provider") or DEFAULT_REALTIME_PROVIDER)


def realtime_voice_status() -> RealtimeVoiceProviderStatus:
    """Return credential-free configured readiness for the AVAS transport."""
    settings = get_runtime_settings_service().load_realtime_voice()
    provider = str(settings.get("provider") or DEFAULT_REALTIME_PROVIDER)
    model = str(settings.get("model") or CODEX_REALTIME_MODEL)
    voice = str(settings.get("voice") or CODEX_REALTIME_VOICE)
    if provider != DEFAULT_REALTIME_PROVIDER:
        return RealtimeVoiceProviderStatus(
            provider=provider,
            ready=False,
            message="The configured Realtime Voice Provider is unsupported.",
        )
    if model not in SUPPORTED_CODEX_REALTIME_MODELS:
        return RealtimeVoiceProviderStatus(
            provider=provider,
            ready=False,
            message="The configured GPT-Live V3 model is unsupported.",
        )
    if voice not in SUPPORTED_CODEX_REALTIME_VOICES:
        return RealtimeVoiceProviderStatus(
            provider=provider,
            ready=False,
            message="The configured GPT-Live V3 voice is unsupported.",
        )

    try:
        load_codex_oauth_token()
    except ImportError:
        return RealtimeVoiceProviderStatus(
            provider=provider,
            ready=False,
            message="oauth_cli_kit is not installed. Install CLI deps or switch provider.",
            login_command=CODEX_LOGIN_COMMAND,
        )
    except RuntimeError as exc:
        message = str(exc)
        if "not logged in" in message.lower():
            return RealtimeVoiceProviderStatus(
                provider=provider,
                ready=False,
                message=message,
                login_command=CODEX_LOGIN_COMMAND,
            )
        return RealtimeVoiceProviderStatus(
            provider=provider,
            ready=False,
            message="OpenAI Codex OAuth is unavailable.",
            login_command=CODEX_LOGIN_COMMAND,
        )
    except Exception:
        return RealtimeVoiceProviderStatus(
            provider=provider,
            ready=False,
            message="OpenAI Codex OAuth is unavailable.",
            login_command=CODEX_LOGIN_COMMAND,
        )
    return RealtimeVoiceProviderStatus(
        provider=provider,
        ready=True,
        message="OpenAI Codex OAuth is connected; GPT-Live AVAS WebRTC is configured.",
    )


def codex_avas_session_payload(
    *,
    instructions: str = "",
    model: str = CODEX_REALTIME_MODEL,
    voice: str = CODEX_REALTIME_VOICE,
    initial_items: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    """Build Codex's official Frameless Bidi (Realtime V3) call payload."""
    if model not in SUPPORTED_CODEX_REALTIME_MODELS:
        raise RealtimeVoiceProviderError("The configured GPT-Live V3 model is unsupported.")
    if voice not in SUPPORTED_CODEX_REALTIME_VOICES:
        raise RealtimeVoiceProviderError("The configured GPT-Live V3 voice is unsupported.")
    from deeptutor.services.session.context_builder import count_tokens
    from deeptutor.services.voice.context_snapshot import (
        MAX_CONTEXT_ITEMS,
        MAX_CONTEXT_TOKENS,
    )

    wire_items: list[dict[str, Any]] = []
    token_count = 0
    if len(initial_items) > MAX_CONTEXT_ITEMS:
        raise RealtimeVoiceProviderError("Realtime Context Snapshot has too many items.")
    for item in initial_items:
        role = str(item.get("role") or "").strip()
        text = str(item.get("text") or "").strip()
        if role not in {"developer", "user", "assistant"} or not text:
            raise RealtimeVoiceProviderError("Realtime Context Snapshot contains an invalid item.")
        token_count += count_tokens(text)
        if token_count > MAX_CONTEXT_TOKENS:
            raise RealtimeVoiceProviderError("Realtime Context Snapshot exceeds its token budget.")
        content_type = "output_text" if role == "assistant" else "input_text"
        wire_items.append(
            {
                "type": "message",
                "role": role,
                "content": [{"type": content_type, "text": text}],
            }
        )

    payload: dict[str, Any] = {
        "instructions": instructions.strip() or DEFAULT_REALTIME_INSTRUCTIONS,
        "audio": {"output": {"voice": voice}},
        "delegation": {"type": "client"},
        "model": model,
    }
    if wire_items:
        payload["initial_items"] = wire_items
    return payload


def _has_webrtc_media(sdp: str, kind: str) -> bool:
    return bool(_MEDIA_LINE_RE[kind].search(sdp.replace("\r\n", "\n")))


def _validate_offer_sdp(offer_sdp: object) -> str:
    if not isinstance(offer_sdp, str):
        raise RealtimeVoiceProviderError("Realtime WebRTC offer SDP is empty or invalid.")
    candidate = offer_sdp.strip()
    if (
        not candidate.startswith("v=0")
        or not _has_webrtc_media(candidate, "audio")
        or not _has_webrtc_media(candidate, "application")
    ):
        raise RealtimeVoiceProviderError(
            "Realtime WebRTC offer SDP must contain audio and the events data channel."
        )
    return offer_sdp


def _validate_answer_sdp(answer_sdp: str) -> None:
    if (
        not answer_sdp.strip().startswith("v=0")
        or not _has_webrtc_media(answer_sdp, "audio")
        or not _has_webrtc_media(answer_sdp, "application")
    ):
        raise RealtimeVoiceProviderError("Codex Realtime returned an invalid WebRTC answer.")


def _parse_call_id(location: str | None) -> str:
    if not location:
        raise RealtimeVoiceProviderError(
            "Codex Realtime call response did not include a call identifier."
        )
    segment = location.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1]
    if not _CALL_ID_RE.fullmatch(segment):
        raise RealtimeVoiceProviderError(
            "Codex Realtime call response included an invalid call identifier."
        )
    return segment


def _safe_call_error(status_code: int) -> RealtimeVoiceProviderError:
    if status_code == 401:
        return RealtimeVoiceProviderError(
            "Codex OAuth Realtime authentication failed. Run `deeptutor provider login openai-codex`."
        )
    if status_code == 403:
        return RealtimeVoiceProviderError(
            "Codex Realtime access was denied. Refresh the Codex OAuth login and try again."
        )
    if 400 <= status_code < 500:
        return RealtimeVoiceProviderError(
            "Codex Realtime rejected the WebRTC offer or session configuration."
        )
    return RealtimeVoiceProviderError(
        "Codex Realtime call creation failed. Check network access and try again."
    )


def _utf8_chunks(text: str) -> list[str]:
    chunks: list[str] = []
    current: list[str] = []
    current_bytes = 0
    for character in text:
        width = len(character.encode("utf-8"))
        if current and current_bytes + width > REALTIME_CONTEXT_CHUNK_BYTES:
            chunks.append("".join(current))
            current = []
            current_bytes = 0
        current.append(character)
        current_bytes += width
    if current:
        chunks.append("".join(current))
    return chunks


class CodexRealtimeSideband:
    """Server-side Frameless Bidi control socket for one AVAS call."""

    def __init__(self, socket: RealtimeSocket):
        self._socket = socket
        self._closed = False

    async def events(self) -> AsyncIterator[dict[str, Any]]:
        try:
            async for raw in self._socket:
                if isinstance(raw, bytes):
                    raise RealtimeVoiceProviderError(
                        "Codex Realtime sideband returned binary data."
                    )
                try:
                    payload = json.loads(raw)
                except (TypeError, json.JSONDecodeError) as exc:
                    raise RealtimeVoiceProviderError(
                        "Codex Realtime sideband returned invalid data."
                    ) from exc
                if not isinstance(payload, dict):
                    raise RealtimeVoiceProviderError(
                        "Codex Realtime sideband returned invalid data."
                    )
                yield payload
        except RealtimeVoiceProviderError:
            raise
        except Exception as exc:
            raise RealtimeVoiceProviderError("Codex Realtime sideband connection failed.") from exc

    async def send_handoff_append(self, handoff_id: str, output_text: str) -> None:
        await self._send_context(handoff_id, output_text, channel="commentary")

    async def send_handoff_speech(self, handoff_id: str, output_text: str) -> None:
        """Append one DeepTutor-owned speakable chunk to the delegation."""
        await self._send_context(handoff_id, output_text, channel="speakable")

    async def send_speech(self, output_text: str) -> None:
        """Append speakable text without a delegation (session-level append).

        Used for synthetic transcript handoffs, where the user utterance was
        committed from its final transcript and no provider delegation item
        exists to append to. Mirrors the official ``appendSpeech`` contract:
        ``session.context.append`` with the ``speakable`` channel.
        """
        output_text = str(output_text)
        if not output_text.strip():
            raise RealtimeVoiceProviderError("Realtime speech output is empty.")
        for chunk in _utf8_chunks(output_text):
            await self._send(
                {
                    "type": "session.context.append",
                    "channel": "speakable",
                    "content": [{"type": "input_text", "text": chunk}],
                }
            )

    async def _send_context(self, handoff_id: str, output_text: str, *, channel: str) -> None:
        handoff_id = str(handoff_id).strip()
        output_text = str(output_text)
        if not _ITEM_ID_RE.fullmatch(handoff_id) or not output_text.strip():
            raise RealtimeVoiceProviderError("Realtime handoff output is empty or invalid.")
        for chunk in _utf8_chunks(output_text):
            await self._send(
                {
                    "type": "delegation.context.append",
                    "delegation_item_id": handoff_id,
                    "channel": channel,
                    "content": [{"type": "input_text", "text": chunk}],
                }
            )

    async def close(self) -> None:
        if self._closed:
            return
        try:
            await self._send({"type": "session.close"})
        except RealtimeVoiceProviderError:
            pass
        self._closed = True
        try:
            await self._socket.close()
        except Exception:
            pass

    async def _send(self, payload: dict[str, Any]) -> None:
        if self._closed:
            raise RealtimeVoiceProviderError("Codex Realtime sideband is closed.")
        if payload.get("type") not in _GPT_LIVE_V3_OUTBOUND_EVENT_TYPES:
            raise RealtimeVoiceProviderError(
                "Codex Realtime outbound event is not supported by GPT-Live V3."
            )
        try:
            await self._socket.send(json.dumps(payload, separators=(",", ":")))
        except Exception as exc:
            raise RealtimeVoiceProviderError("Codex Realtime sideband connection failed.") from exc


class CodexOAuthRealtimeProvider:
    """Create GPT-Live AVAS calls with a server-only Codex OAuth token."""

    def __init__(
        self,
        *,
        call_url: str | None = None,
        sideband_url: str | None = None,
        token_loader: Callable[[], Any] = load_codex_oauth_token,
        connect: Callable[..., Awaitable[RealtimeSocket]] | None = None,
        http_transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.call_url = (
            call_url or os.environ.get(REALTIME_CALL_URL_ENV) or DEFAULT_CODEX_REALTIME_CALL_URL
        )
        self.sideband_url = (
            sideband_url
            or os.environ.get(REALTIME_SIDEBAND_URL_ENV)
            or DEFAULT_CODEX_REALTIME_SIDEBAND_URL
        )
        self._token_loader = token_loader
        self._connect = connect or websocket_connect
        self._http_transport = http_transport

    async def create_call(
        self,
        offer_sdp: str,
        *,
        session_id: str,
        instructions: str = "",
        initial_items: Sequence[Mapping[str, Any]] = (),
    ) -> CodexRealtimeCall:
        offer_sdp = _validate_offer_sdp(offer_sdp)
        session_id = str(session_id).strip()
        if not _SESSION_ID_RE.fullmatch(session_id):
            raise RealtimeVoiceProviderError("Realtime session id is empty or invalid.")

        token = await self._load_token()
        access = getattr(token, "access", None)
        if not access:
            raise RealtimeVoiceProviderError(
                f"OpenAI Codex is not logged in. Run `{CODEX_LOGIN_COMMAND}`."
            )
        headers = _build_headers(getattr(token, "account_id", None), access)
        # The shared Responses helper carries a different beta marker. GPT-Live
        # V3 uses the Frameless Bidi alpha and correlates the call/sideband with
        # the same server-side ids.
        headers.pop("OpenAI-Beta", None)
        headers.update(
            {
                "originator": CODEX_REALTIME_ORIGINATOR,
                "openai-alpha": CODEX_REALTIME_ALPHA,
                "x-session-id": session_id,
                "session-id": session_id,
                "thread-id": session_id,
                "accept": "application/sdp",
                "content-type": "application/json",
            }
        )
        realtime_settings = get_runtime_settings_service().load_realtime_voice()
        body = {
            "sdp": offer_sdp,
            "session": codex_avas_session_payload(
                instructions=instructions,
                model=str(realtime_settings.get("model") or CODEX_REALTIME_MODEL),
                voice=str(realtime_settings.get("voice") or CODEX_REALTIME_VOICE),
                initial_items=initial_items,
            ),
        }
        try:
            async with httpx.AsyncClient(
                timeout=30.0,
                verify=not disable_ssl_verify_enabled(),
                transport=self._http_transport,
            ) as client:
                response = await client.post(
                    f"{self.call_url}?intent=quicksilver&architecture=avas",
                    headers=headers,
                    json=body,
                )
        except httpx.HTTPError as exc:
            raise RealtimeVoiceProviderError(
                "Codex Realtime call creation failed. Check network access and try again."
            ) from exc
        if not response.is_success:
            raise _safe_call_error(response.status_code)
        try:
            answer_sdp = response.content.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RealtimeVoiceProviderError(
                "Codex Realtime returned an invalid WebRTC answer."
            ) from exc
        _validate_answer_sdp(answer_sdp)
        call_id = _parse_call_id(response.headers.get("location"))
        sideband_headers = {
            key: value
            for key, value in headers.items()
            if key.lower()
            in {
                "authorization",
                "chatgpt-account-id",
                "openai-alpha",
                "originator",
                "session-id",
                "thread-id",
                "user-agent",
                "x-session-id",
            }
        }
        return CodexRealtimeCall(
            answer_sdp=answer_sdp,
            call_id=call_id,
            _sideband_headers=sideband_headers,
        )

    async def connect_sideband(self, call: CodexRealtimeCall) -> CodexRealtimeSideband:
        url = f"{self.sideband_url.rstrip('/')}/{call.call_id}"
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                socket = await self._connect(
                    url,
                    additional_headers=call._sideband_headers,
                    open_timeout=30,
                    max_size=4 * 1024 * 1024,
                )
                # V3 session configuration is part of call creation, so no
                # redundant session.update is needed after joining the sideband.
                return CodexRealtimeSideband(socket)
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    await asyncio.sleep(0.25 * (2**attempt))
        raise RealtimeVoiceProviderError(
            "Codex Realtime sideband connection failed. Check OAuth and network access."
        ) from last_error

    async def _load_token(self) -> Any:
        try:
            return await asyncio.to_thread(self._token_loader)
        except ImportError as exc:
            raise RealtimeVoiceProviderError(
                "oauth_cli_kit is not installed. Install CLI deps or switch provider."
            ) from exc
        except RuntimeError as exc:
            message = str(exc)
            if "not logged in" in message.lower():
                raise RealtimeVoiceProviderError(
                    f"{message} Realtime Voice is unavailable until OAuth login completes."
                ) from exc
            raise RealtimeVoiceProviderError("OpenAI Codex OAuth is unavailable.") from exc
        except Exception as exc:
            raise RealtimeVoiceProviderError("OpenAI Codex OAuth is unavailable.") from exc


def _item_text(payload: dict[str, Any]) -> str | None:
    item = payload.get("item")
    if not isinstance(item, dict):
        return None
    text = item.get("text")
    return text if isinstance(text, str) else None


def _client_delegation(payload: dict[str, Any]) -> tuple[str, str] | None:
    item = payload.get("item")
    if not isinstance(item, dict):
        raise RealtimeVoiceProviderError("Codex Realtime returned an invalid handoff.")
    if item.get("type") != "delegation" or item.get("target") != "client":
        return None
    handoff_id = item.get("id")
    if not isinstance(handoff_id, str) or not _ITEM_ID_RE.fullmatch(handoff_id):
        raise RealtimeVoiceProviderError("Codex Realtime returned an invalid handoff id.")
    content = item.get("content")
    if not isinstance(content, list):
        content = []
    text = "".join(
        str(part.get("text") or "")
        for part in content
        if isinstance(part, dict) and part.get("type") == "input_text"
    ).strip()
    if not text:
        raise RealtimeVoiceProviderError("Codex Realtime returned an empty handoff transcript.")
    return handoff_id, text


def normalize_codex_event(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize Frameless Bidi events without forwarding audio or credentials."""
    event_type = payload.get("type")
    if event_type in _LEGACY_EVENT_TYPES:
        raise RealtimeVoiceProviderError(
            "Codex Realtime returned an unsupported legacy session contract."
        )
    if event_type in {"session.started", "session.updated"}:
        return [
            {"type": "state", "state": "connected"},
            {"type": "state", "state": "listening"},
        ]
    if event_type == "input_transcript.added":
        text = _item_text(payload)
        if not text or not text.strip():
            return []
        item = payload.get("item") if isinstance(payload.get("item"), dict) else {}
        item_id = item.get("id")
        normalized: dict[str, Any] = {"type": "transcript", "phase": "partial", "text": text}
        if isinstance(item_id, str) and _ITEM_ID_RE.fullmatch(item_id):
            normalized["provider_turn_id"] = item_id
        return [normalized]
    if event_type == "delegation.created":
        delegation = _client_delegation(payload)
        if delegation is None:
            return []
        handoff_id, text = delegation
        return [
            {"type": "handoff", "handoff_id": handoff_id, "text": text},
            {
                "type": "transcript",
                "phase": "final",
                "handoff_id": handoff_id,
                "text": text,
            },
        ]
    if event_type == "output_transcript.added":
        text = _item_text(payload)
        if not text or not text.strip():
            return []
        item = payload.get("item") if isinstance(payload.get("item"), dict) else {}
        item_id = item.get("id")
        normalized = {"type": "assistant_transcript", "phase": "partial", "text": text}
        if isinstance(item_id, str) and _ITEM_ID_RE.fullmatch(item_id):
            normalized["provider_turn_id"] = item_id
        return [normalized]
    if event_type == "turn.done":
        turn = payload.get("turn")
        if not isinstance(turn, dict):
            raise RealtimeVoiceProviderError("Codex Realtime returned an invalid turn event.")
        role = turn.get("role")
        text = turn.get("transcript")
        if role == "user" and (not isinstance(text, str) or not text.strip()):
            raise RealtimeVoiceProviderError("Codex Realtime returned an empty final transcript.")
        turn_id = turn.get("id")
        normalized_id = (
            turn_id if isinstance(turn_id, str) and _ITEM_ID_RE.fullmatch(turn_id) else None
        )
        if role == "user":
            normalized = {
                "type": "provider_user_turn",
                "text": text.strip(),
            }
            if normalized_id is not None:
                normalized["provider_turn_id"] = normalized_id
            return [normalized]
        if role == "assistant":
            if not isinstance(text, str) or not text.strip():
                return [{"type": "state", "state": "listening"}]
            normalized = {
                "type": "provider_assistant_turn",
                "text": text.strip(),
            }
            if normalized_id is not None:
                normalized["provider_turn_id"] = normalized_id
            return [normalized, {"type": "state", "state": "listening"}]
        return []
    if event_type == "output_audio.delta":
        audio = payload.get("audio")
        try:
            decoded = base64.b64decode(audio, validate=True) if isinstance(audio, str) else b""
        except (binascii.Error, ValueError):
            decoded = b""
        if not decoded:
            raise RealtimeVoiceProviderError("Codex Realtime returned invalid audio output.")
        # WebRTC carries the media directly. Only a content-free signal crosses
        # DeepTutor's normalized boundary; raw provider audio is never persisted.
        return [
            {"type": "state", "state": "speaking"},
            {"type": "audio_output"},
        ]
    if event_type == "error":
        raise RealtimeVoiceProviderError(
            "OpenAI Codex Realtime rejected a session event. The voice session was stopped safely."
        )
    return []


async def close_realtime_session(session: CodexRealtimeSideband | None) -> None:
    if session is not None:
        await session.close()


__all__ = [
    "CODEX_LOGIN_COMMAND",
    "CODEX_REALTIME_ALPHA",
    "CODEX_REALTIME_MODEL",
    "CODEX_REALTIME_VOICE",
    "SUPPORTED_CODEX_REALTIME_MODELS",
    "SUPPORTED_CODEX_REALTIME_VOICES",
    "CodexOAuthRealtimeProvider",
    "CodexRealtimeCall",
    "CodexRealtimeSideband",
    "DEFAULT_CODEX_REALTIME_CALL_URL",
    "DEFAULT_CODEX_REALTIME_SIDEBAND_URL",
    "DEFAULT_REALTIME_PROVIDER",
    "RealtimeVoiceProviderError",
    "RealtimeVoiceProviderStatus",
    "codex_avas_session_payload",
    "close_realtime_session",
    "configured_realtime_provider",
    "normalize_codex_event",
    "realtime_voice_status",
]
