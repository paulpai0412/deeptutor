#!/usr/bin/env python3
"""PROTOTYPE: probe GPT-Live V3 generic whiteboard-tool configuration.

Usage:
    DEEPTUTOR_REALTIME_TOOL_PROBE=1 .venv/bin/python \
        scripts/probe_codex_realtime_whiteboard_tool.py

The probe makes real Codex OAuth AVAS calls. It first proves the generated SDP
works, then tests a function tool in the initial session and through
``session.update``. It never prints credentials, provider response bodies, or
call identifiers.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
import json
import os
from pathlib import Path
import subprocess
from typing import Any

from deeptutor.services.voice import realtime

ROOT = Path(__file__).resolve().parents[1]
TOOL = {
    "type": "function",
    "name": "present_whiteboard_batch",
    "description": "Queue a non-blocking whiteboard update while continuing to speak.",
    "parameters": {
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
        "additionalProperties": False,
    },
}
NODE_OFFER = r"""
const { chromium } = require('./web/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const sdp = await page.evaluate(async () => {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const destination = audio.createMediaStreamDestination();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    const peer = new RTCPeerConnection();
    for (const track of destination.stream.getAudioTracks()) {
      peer.addTrack(track, destination.stream);
    }
    peer.createDataChannel('oai-events');
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (peer.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    }
    const value = peer.localDescription?.sdp ?? '';
    peer.close();
    oscillator.stop();
    await audio.close();
    return value;
  });
  process.stdout.write(sdp);
  await browser.close();
})();
"""


def generate_offer() -> str:
    result = subprocess.run(
        ["node", "-e", NODE_OFFER],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    offer = result.stdout
    if "m=audio " not in offer or "m=application " not in offer:
        raise RuntimeError("Playwright did not generate the required AVAS SDP media sections.")
    return offer


async def create_control(provider: realtime.CodexOAuthRealtimeProvider, offer: str, label: str):
    return await provider.create_call(
        offer,
        session_id=label,
        instructions="For every completed user utterance, create a client delegation and wait.",
    )


async def probe() -> dict[str, object]:
    offer = generate_offer()
    provider = realtime.CodexOAuthRealtimeProvider()

    control = await create_control(provider, offer, "deeptutor-whiteboard-tool-control")
    control_sideband = await provider.connect_sideband(control)
    await control_sideband.close()

    original_payload = realtime.codex_avas_session_payload

    def payload_with_tool(
        *,
        instructions: str = "",
        model: str = realtime.CODEX_REALTIME_MODEL,
        voice: str = realtime.CODEX_REALTIME_VOICE,
        initial_items: Sequence[Mapping[str, Any]] = (),
    ) -> dict[str, Any]:
        payload = original_payload(
            instructions=instructions,
            model=model,
            voice=voice,
            initial_items=initial_items,
        )
        payload["tools"] = [TOOL]
        payload["tool_choice"] = "auto"
        return payload

    initial_tool_result: dict[str, object]
    realtime.codex_avas_session_payload = payload_with_tool
    try:
        try:
            call = await provider.create_call(
                offer,
                session_id="deeptutor-whiteboard-tool-initial",
                instructions=(
                    "Call present_whiteboard_batch once, then continue speaking without waiting."
                ),
            )
        except realtime.RealtimeVoiceProviderError as exc:
            initial_tool_result = {"accepted": False, "error": str(exc)}
        else:
            initial_tool_result = {"accepted": True}
            sideband = await provider.connect_sideband(call)
            await sideband.close()
    finally:
        realtime.codex_avas_session_payload = original_payload

    update_call = await create_control(provider, offer, "deeptutor-whiteboard-tool-update")
    update_sideband = await provider.connect_sideband(update_call)
    await update_sideband._send(
        {
            "type": "session.update",
            "session": {"tools": [TOOL], "tool_choice": "auto"},
        }
    )
    update_result: dict[str, object] = {"accepted": False, "event": "timeout"}
    iterator = update_sideband.events().__aiter__()
    try:
        for _ in range(3):
            event = await asyncio.wait_for(iterator.__anext__(), timeout=5)
            if event.get("type") == "session.updated":
                update_result = {"accepted": True, "event": "session.updated"}
                break
            if event.get("type") == "error":
                raw_error = event.get("error")
                error = raw_error if isinstance(raw_error, dict) else {}
                update_result = {
                    "accepted": False,
                    "event": "error",
                    "code": error.get("code"),
                    "param": error.get("param"),
                    "message": error.get("message"),
                }
                break
    except (asyncio.TimeoutError, StopAsyncIteration):
        update_result = {"accepted": False, "event": "timeout"}
    await update_sideband.close()

    return {
        "control_call": "accepted",
        "initial_tools": initial_tool_result,
        "session_update_tools": update_result,
        "verdict": (
            "configuration accepted; run an audio-continuity probe next"
            if initial_tool_result.get("accepted") or update_result.get("accepted")
            else "generic function tools are unsupported by this GPT-Live V3 contract"
        ),
    }


if __name__ == "__main__":
    if os.environ.get("DEEPTUTOR_REALTIME_TOOL_PROBE") != "1":
        raise SystemExit(
            "Refusing to run a real provider probe. Set DEEPTUTOR_REALTIME_TOOL_PROBE=1."
        )
    print(json.dumps(asyncio.run(probe()), ensure_ascii=False, indent=2))
