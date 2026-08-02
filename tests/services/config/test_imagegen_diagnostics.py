from __future__ import annotations

from typing import Any

import pytest

from deeptutor.services.config.test_runner import ConfigTestRunner, TestRun


def _draft_catalog() -> dict[str, Any]:
    return {
        "version": 1,
        "services": {
            "imagegen": {
                "active_profile_id": "draft-profile",
                "active_model_id": "draft-model",
                "profiles": [
                    {
                        "id": "draft-profile",
                        "binding": "openai_codex",
                        "base_url": "",
                        "api_key": "",
                        "models": [
                            {
                                "id": "draft-model",
                                "model": "gpt-5.5",
                                "size": "1024x1024",
                                "quality": "high",
                            }
                        ],
                    }
                ],
            }
        },
    }


@pytest.mark.asyncio
async def test_imagegen_diagnostic_uses_draft_and_one_billable_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import deeptutor.services.imagegen as imagegen_service

    draft = _draft_catalog()
    captured: dict[str, Any] = {}

    async def fake_generate_image(
        prompt: str, *, catalog: dict[str, Any] | None = None, n: int = 1, **_kwargs: Any
    ) -> list[tuple[bytes, str]]:
        captured.update(prompt=prompt, catalog=catalog, n=n)
        return [(b"PNGDATA", "image/png")]

    monkeypatch.setattr(imagegen_service, "generate_image", fake_generate_image)

    run = TestRun(id="imagegen-diagnostics", service="imagegen")
    await ConfigTestRunner()._test_imagegen(run, draft)

    assert captured == {
        "prompt": "A small minimalist test icon of a blue book on a white background.",
        "catalog": draft,
        "n": 1,
    }
    response = next(event for event in run.events if event["type"] == "response")
    assert response["bytes"] == len(b"PNGDATA")
    assert response["content_type"] == "image/png"
    assert not any(event["type"] == "artifact" for event in run.events)
