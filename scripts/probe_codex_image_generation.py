#!/usr/bin/env python3
"""Probe whether the Codex OAuth Responses endpoint supports image_generation.

This is intentionally separate from the production provider. It performs one
live image-generation request only when ``--live`` is supplied, never prints
OAuth credentials, and writes a successful image to ``/tmp`` by default.

Run with:
    .venv/bin/python scripts/probe_codex_image_generation.py --live
"""

from __future__ import annotations

import argparse
import asyncio
import base64
from pathlib import Path
import sys
from typing import Any

import httpx

from deeptutor.services.llm.provider_core.openai_codex_provider import (
    DEFAULT_CODEX_URL,
    _build_headers,
    _strip_model_prefix,
)
from deeptutor.services.llm.provider_core.openai_responses.parsing import iter_sse

DEFAULT_PROMPT = (
    "Generate exactly one small test image: a simple blue book icon on a white "
    "background. Use the image generation tool and return the generated image."
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Probe native image_generation support on the Codex OAuth endpoint."
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Send the live, billable image-generation request.",
    )
    parser.add_argument(
        "--model",
        default="openai-codex/gpt-5.5",
        help="Codex model id (default: openai-codex/gpt-5.5).",
    )
    parser.add_argument(
        "--prompt",
        default=DEFAULT_PROMPT,
        help="Prompt sent to the image_generation tool.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("/tmp/deeptutor-codex-image-probe.png"),
        help="Output path for a successful image.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=120.0,
        help="HTTP timeout in seconds (default: 120).",
    )
    return parser.parse_args()


def _load_oauth_token() -> Any:
    try:
        from oauth_cli_kit import get_token
    except ImportError as exc:
        raise RuntimeError(
            "oauth_cli_kit is not installed in this Python environment."
        ) from exc
    token = get_token()
    if not getattr(token, "access", None):
        raise RuntimeError(
            "No OpenAI Codex OAuth token is available. Run "
            "`deeptutor provider login openai-codex` first."
        )
    return token


def _request_body(model: str, prompt: str) -> dict[str, Any]:
    return {
        "model": _strip_model_prefix(model),
        "store": False,
        "stream": True,
        "instructions": (
            "Use the native image_generation tool for this request. Do not merely "
            "describe an image in text."
        ),
        "input": [
            {
                "role": "user",
                "content": [{"type": "input_text", "text": prompt}],
            }
        ],
        "text": {"verbosity": "low"},
        "include": ["reasoning.encrypted_content"],
        "tools": [{"type": "image_generation"}],
        "tool_choice": "auto",
        "parallel_tool_calls": True,
    }


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


def _decode_image(value: str) -> bytes:
    if "," in value and value.startswith("data:"):
        value = value.split(",", 1)[1]
    return base64.b64decode(value, validate=True)


async def _probe(args: argparse.Namespace) -> int:
    token = _load_oauth_token()
    headers = _build_headers(
        getattr(token, "account_id", None), getattr(token, "access", None)
    )
    body = _request_body(args.model, args.prompt)

    if not args.live:
        print("DRY-RUN: OAuth token is available; no request was sent.")
        print(f"Endpoint: {DEFAULT_CODEX_URL}")
        print(f"Model: {body['model']}")
        print(f"Native tool: {body['tools'][0]['type']}")
        print("Re-run with --live to send one billable image request.")
        return 0

    event_types: set[str] = set()
    image_data: str | None = None
    try:
        async with httpx.AsyncClient(timeout=args.timeout) as client:
            async with client.stream(
                "POST", DEFAULT_CODEX_URL, headers=headers, json=body
            ) as response:
                if response.status_code != 200:
                    detail = (await response.aread()).decode("utf-8", "replace")
                    print(
                        f"REJECTED: HTTP {response.status_code}: {detail[:1000]}",
                        file=sys.stderr,
                    )
                    return 2

                async for event in iter_sse(response):
                    event_type = str(event.get("type") or "")
                    if event_type:
                        event_types.add(event_type)
                    image_data = image_data or _image_result(event)
    except Exception as exc:  # noqa: BLE001 - probe must report provider failures
        print(f"REJECTED: {type(exc).__name__}: {exc}", file=sys.stderr)
        if event_types:
            print(f"Events observed: {', '.join(sorted(event_types))}", file=sys.stderr)
        return 2

    if image_data is None:
        print("INCONCLUSIVE: request completed without an image_generation_call.")
        print(f"Events observed: {', '.join(sorted(event_types)) or '(none)'}")
        return 3

    try:
        image_bytes = _decode_image(image_data)
    except Exception as exc:  # noqa: BLE001 - report malformed provider output
        print(f"REJECTED: image_generation_call result was not valid Base64: {exc}")
        return 2

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(image_bytes)
    print("PASS: Codex OAuth endpoint accepted native image_generation.")
    print(f"Image bytes: {len(image_bytes)}")
    print(f"Saved to: {args.output}")
    print(f"Events observed: {', '.join(sorted(event_types))}")
    return 0


def main() -> int:
    try:
        args = _parse_args()
        return asyncio.run(_probe(args))
    except Exception as exc:  # noqa: BLE001 - friendly CLI failure
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
