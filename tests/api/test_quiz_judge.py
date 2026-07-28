from __future__ import annotations

import importlib
from typing import Any

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI
from fastapi.testclient import TestClient

judge_module = importlib.import_module("deeptutor.api.routers.quiz_judge")


def test_judge_prompt_mentions_question_images() -> None:
    prompt = judge_module._build_judge_user_prompt(
        language="en",
        question="Read the diagram.",
        question_type="choice",
        options={"A": "one"},
        correct_answer="A",
        explanation="",
        user_answer="A",
        has_image=True,
        image_count=0,
        question_image_count=1,
    )
    assert "question includes 1 image" in prompt


@pytest.mark.asyncio
async def test_multimodal_judge_payload_contains_question_and_answer_images(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_stream(*, prompt: str, system_prompt: str, **kwargs: Any):
        captured.update(kwargs)
        yield "Judgment"

    monkeypatch.setattr(judge_module, "llm_stream", fake_stream)
    monkeypatch.setattr(
        "deeptutor.services.llm.capabilities.supports_vision",
        lambda *_args, **_kwargs: True,
    )
    auth_module = importlib.import_module("deeptutor.api.routers.auth")
    auth_module.AUTH_ENABLED = False

    async def _authenticated():
        return None

    monkeypatch.setattr(
        auth_module,
        "ws_require_auth",
        lambda _websocket: _authenticated(),
    )
    app = FastAPI()
    app.include_router(judge_module.router, prefix="/api/v1")

    with TestClient(app) as client:
        with client.websocket_connect("/api/v1/question/judge") as websocket:
            websocket.send_json(
                {
                    "question": "Read the diagram.",
                    "question_type": "choice",
                    "options": {"A": "one", "B": "two"},
                    "correct_answer": "A",
                    "explanation": "",
                    "user_answer": "B",
                    "question_images": [
                        {
                            "url": "/api/attachments/session-1/source-1/diagram.png",
                            "filename": "diagram.png",
                            "mime_type": "image/png",
                        }
                    ],
                    "user_answer_images": [
                        {
                            "base64": "aGVsbG8=",
                            "filename": "answer.png",
                            "mime_type": "image/png",
                        }
                    ],
                    "language": "en",
                }
            )
            assert websocket.receive_json()["type"] == "started"
            assert websocket.receive_json() == {"type": "text", "content": "Judgment"}
            assert websocket.receive_json()["type"] == "done"

    messages = captured["messages"]
    parts = messages[1]["content"]
    image_parts = [part for part in parts if part["type"] == "image_url"]
    assert len(image_parts) == 2
    assert image_parts[0]["image_url"]["url"].endswith("diagram.png")
    assert image_parts[1]["image_url"]["url"].startswith("data:image/png;base64,")
