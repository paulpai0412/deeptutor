from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace

import pytest

from deeptutor.services.llm.provider_core import openai_codex_provider


def test_authorize_codex_oauth_runs_existing_browser_flow_without_returning_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    oauth_module = ModuleType("oauth_cli_kit")

    def login_oauth_interactive(**kwargs: object):
        captured.update(kwargs)
        print_fn = kwargs["print_fn"]
        assert callable(print_fn)
        print_fn("https://auth.example/callback-state")
        return SimpleNamespace(access="server-only-token")

    oauth_module.login_oauth_interactive = login_oauth_interactive  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "oauth_cli_kit", oauth_module)

    result = openai_codex_provider.authorize_codex_oauth()

    assert result is None
    assert captured["open_browser"] is True
    assert captured["originator"] == "DeepTutor"
    assert callable(captured["prompt_fn"])
