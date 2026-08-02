"""Codex OAuth native image-generation adapter.

Codex uses the Responses endpoint rather than ``/images/generations``. The
mainline model calls the native ``image_generation`` tool and returns the final
PNG as the ``result`` of an ``image_generation_call`` output item. Partial image
events are intentionally ignored so the existing imagegen artifact flow stays
unchanged.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import Any

import httpx

from deeptutor.services.generation_http import GenerationProviderError
from deeptutor.services.imagegen.base import BaseImagegenAdapter
from deeptutor.services.imagegen.config import ImagegenConfig
logger = logging.getLogger(__name__)


class CodexOAuthImagegenAdapter(BaseImagegenAdapter):
    """Generate one image through Codex OAuth's native image tool."""

    async def generate(
        self, prompt: str, config: ImagegenConfig, *, n: int = 1
    ) -> list[tuple[bytes, str]]:
        del n  # Native image_generation returns one image per call.
        # Import lazily: importing the Codex LLM provider while the imagegen
        # package is initializing creates a services.llm/services.config cycle.
        from deeptutor.services.llm.provider_core.openai_codex_provider import (
            DEFAULT_CODEX_URL,
            _build_headers,
            _strip_model_prefix,
            load_codex_oauth_token,
        )

        try:
            token = await asyncio.to_thread(load_codex_oauth_token)
        except Exception as exc:  # noqa: BLE001 - convert auth failures for the tool
            raise GenerationProviderError(str(exc)) from exc

        headers = _build_headers(
            getattr(token, "account_id", None), getattr(token, "access", None)
        )
        body = self._build_request_body(
            prompt, config, model_name=_strip_model_prefix(config.model)
        )
        logger.debug("codex imagegen model=%s", body["model"])

        try:
            async with httpx.AsyncClient(timeout=config.request_timeout) as client:
                async with client.stream(
                    "POST", DEFAULT_CODEX_URL, headers=headers, json=body
                ) as response:
                    if response.status_code >= 400:
                        detail = (await response.aread()).decode("utf-8", "replace")[:400]
                        raise GenerationProviderError(
                            f"Codex image generation failed with HTTP "
                            f"{response.status_code}: {detail}"
                        )
                    image_data = await self._consume_image_result(response)
        except GenerationProviderError:
            raise
        except httpx.HTTPError as exc:
            raise GenerationProviderError(f"Codex image generation request error: {exc}") from exc
        except Exception as exc:  # noqa: BLE001 - surface provider stream failures
            raise GenerationProviderError(f"Codex image generation failed: {exc}") from exc

        if not image_data:
            raise GenerationProviderError(
                "Codex returned no native image_generation result. "
                "Check the selected model and account image-generation access."
            )
        try:
            image_bytes = self._decode_image(image_data)
        except Exception as exc:  # noqa: BLE001 - malformed provider output
            raise GenerationProviderError(
                f"Codex returned an invalid image_generation result: {exc}"
            ) from exc
        return [(image_bytes, self._content_type(image_bytes))]

    @staticmethod
    def _build_request_body(
        prompt: str, config: ImagegenConfig, *, model_name: str
    ) -> dict[str, Any]:
        tool: dict[str, Any] = {"type": "image_generation"}
        if config.size:
            tool["size"] = config.size
        if config.quality:
            tool["quality"] = config.quality
        return {
            "model": model_name,
            "store": False,
            "stream": True,
            "instructions": (
                "Use the native image_generation tool for this request. "
                "Do not merely describe an image in text."
            ),
            "input": [
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": prompt}],
                }
            ],
            "text": {"verbosity": "low"},
            "include": ["reasoning.encrypted_content"],
            "tools": [tool],
            "tool_choice": "auto",
            "parallel_tool_calls": True,
        }

    @staticmethod
    async def _consume_image_result(response: httpx.Response) -> str | None:
        from deeptutor.services.llm.provider_core.openai_responses.parsing import iter_sse

        async for event in iter_sse(response):
            image_data = CodexOAuthImagegenAdapter._image_result(event)
            if image_data:
                return image_data
        return None

    @staticmethod
    def _image_result(event: dict[str, Any]) -> str | None:
        candidates: list[Any] = [event]
        for key in ("item", "output", "response"):
            value = event.get(key)
            if isinstance(value, dict):
                candidates.append(value)
            elif isinstance(value, list):
                candidates.extend(value)
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            if candidate.get("type") != "image_generation_call":
                continue
            result = candidate.get("result")
            if isinstance(result, str) and result:
                return result
        return None

    @staticmethod
    def _decode_image(value: str) -> bytes:
        if "," in value and value.startswith("data:"):
            value = value.split(",", 1)[1]
        return base64.b64decode(value, validate=True)

    @staticmethod
    def _content_type(image: bytes) -> str:
        if image.startswith(b"\x89PNG"):
            return "image/png"
        if image.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if image.startswith(b"GIF8"):
            return "image/gif"
        if image.startswith(b"RIFF") and image[8:12] == b"WEBP":
            return "image/webp"
        return "image/png"


__all__ = ["CodexOAuthImagegenAdapter"]
