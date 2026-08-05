"""Microsoft Edge TTS adapter.

Edge TTS is free and needs no API key. The upstream package returns a single
24 kHz mono MP3 stream, which is exactly what browsers need here.
"""

from __future__ import annotations

from typing import Any

from deeptutor.services.voice.base import BaseTTSAdapter, VoiceProviderError
from deeptutor.services.voice.config import TTSConfig


class EdgeTTSAdapter(BaseTTSAdapter):
    """Synthesize speech through the free Microsoft Edge TTS service."""

    async def synthesize(self, text: str, config: TTSConfig) -> tuple[bytes, str]:
        response_format = (config.response_format or "mp3").lower()
        if response_format != "mp3":
            raise VoiceProviderError("Microsoft Edge TTS outputs MP3; set output format to mp3.")

        try:
            import edge_tts  # type: ignore[import-not-found]
        except ImportError as exc:
            raise VoiceProviderError(
                "Microsoft Edge TTS is unavailable; install the `edge-tts` package."
            ) from exc

        kwargs: dict[str, Any] = {
            "connect_timeout": 10,
            "receive_timeout": config.request_timeout,
        }
        if config.speed is not None:
            kwargs["rate"] = f"{round((config.speed - 1) * 100):+d}%"

        chunks: list[bytes] = []
        try:
            communicate = edge_tts.Communicate(
                text,
                voice=config.voice or "zh-TW-HsiaoChenNeural",
                **kwargs,
            )
            async for chunk in communicate.stream():
                if chunk.get("type") == "audio":
                    chunks.append(chunk["data"])
        except Exception as exc:  # noqa: BLE001 - normalize provider errors
            raise VoiceProviderError(f"Microsoft Edge TTS synthesis failed: {exc}") from exc

        audio = b"".join(chunks)
        if not audio:
            raise VoiceProviderError("Microsoft Edge TTS returned empty audio.")
        return audio, "audio/mpeg"
