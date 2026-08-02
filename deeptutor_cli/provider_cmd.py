"""CLI commands for provider auth and access validation."""

from __future__ import annotations

import typer

from .common import maybe_run


def register(app: typer.Typer) -> None:
    @app.command("login")
    def provider_login(
        provider: str = typer.Argument(
            ...,
            help="Provider: openai-codex (OAuth login) | github-copilot (OAuth device-flow login)",
        ),
    ) -> None:
        """Authenticate or validate provider access."""
        key = provider.strip().lower().replace("-", "_")
        if key == "openai_codex":
            _login_openai_codex()
            return
        if key == "github_copilot":
            maybe_run(_login_github_copilot())
            return
        raise typer.BadParameter(
            f"Unknown provider `{provider}`. Supported: openai-codex, github-copilot"
        )


def _login_openai_codex() -> None:
    try:
        from oauth_cli_kit import get_token, login_oauth_interactive
    except ImportError:
        typer.echo(
            "oauth_cli_kit is not installed. Install CLI deps from a local checkout: "
            "python -m pip install -e ./packaging/deeptutor-cli"
        )
        raise typer.Exit(code=1)

    token = None
    try:
        token = get_token()
    except Exception:
        token = None
    if not (token and getattr(token, "access", None)):
        token = login_oauth_interactive(
            print_fn=typer.echo,
            prompt_fn=typer.prompt,
        )
    if not (token and getattr(token, "access", None)):
        typer.echo("OpenAI Codex OAuth authentication failed.")
        raise typer.Exit(code=1)
    typer.echo("OpenAI Codex OAuth authentication succeeded.")


async def _login_github_copilot() -> None:
    """GitHub device-flow OAuth login (github.com/login/device), then validate."""
    try:
        from deeptutor.services.llm.provider_core.github_copilot_auth import (
            login_device_flow,
            save_github_token,
        )
        from deeptutor.services.llm.provider_core.github_copilot_provider import (
            GitHubCopilotProvider,
        )
    except ImportError as exc:
        typer.echo(f"Missing dependency: {exc}")
        raise typer.Exit(code=1) from exc

    token = await login_device_flow(print_fn=typer.echo)
    path = save_github_token(token)
    typer.echo(f"GitHub token saved to {path}")

    try:
        provider = GitHubCopilotProvider()
        await provider.chat(messages=[{"role": "user", "content": "ping"}], max_tokens=1)
    except Exception as exc:
        typer.echo(f"GitHub Copilot auth validation failed: {exc}")
        raise typer.Exit(code=1) from exc
    typer.echo("GitHub Copilot OAuth login succeeded.")
