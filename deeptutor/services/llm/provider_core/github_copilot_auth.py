"""GitHub device-flow OAuth login for Copilot (https://github.com/login/device).

Obtains a GitHub OAuth token and stores it where
:class:`GitHubCopilotProvider` already looks (oauth_cli_kit FileTokenStorage,
``github-copilot.json`` / app ``nanobot``).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
import time

import httpx

# VS Code's public OAuth client ID — the one Copilot device flow uses.
CLIENT_ID = "Iv1.b507a08c87ecfe98"
DEVICE_CODE_URL = "https://github.com/login/device/code"
ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
SCOPE = "read:user"
TOKEN_FILENAME = "github-copilot.json"
APP_NAME = "nanobot"  # must match GitHubCopilotProvider._load_stored_github_token
_FAR_FUTURE_SECONDS = 10 * 365 * 24 * 3600  # GitHub OAuth tokens don't expire on their own


async def request_device_code() -> dict:
    """Ask GitHub for a device/user code pair."""
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            DEVICE_CODE_URL,
            data={"client_id": CLIENT_ID, "scope": SCOPE},
            headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        return resp.json()


async def poll_for_token(device_code: str, interval: int, expires_in: int) -> str:
    """Poll GitHub until the user authorizes the device code."""
    deadline = time.time() + expires_in
    async with httpx.AsyncClient(timeout=20.0) as client:
        while time.time() < deadline:
            await asyncio.sleep(interval)
            resp = await client.post(
                ACCESS_TOKEN_URL,
                data={
                    "client_id": CLIENT_ID,
                    "device_code": device_code,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                },
                headers={"Accept": "application/json"},
            )
            data = resp.json()
            if data.get("access_token"):
                return str(data["access_token"])
            error = data.get("error")
            if error == "authorization_pending":
                continue
            if error == "slow_down":
                interval += 5
                continue
            raise RuntimeError(
                f"GitHub device flow failed: {data.get('error_description') or error}"
            )
    raise TimeoutError("GitHub device flow timed out before authorization.")


async def login_device_flow(print_fn: Callable[[str], None] = print) -> str:
    """Run the GitHub device flow and return the access token."""
    payload = await request_device_code()
    verification_uri = payload.get("verification_uri", "https://github.com/login/device")
    print_fn(f"Open {verification_uri} and enter code: {payload['user_code']}")
    return await poll_for_token(
        payload["device_code"],
        int(payload.get("interval", 5)),
        int(payload.get("expires_in", 900)),
    )


@dataclass
class DeviceLoginSession:
    status: str = "idle"  # idle | pending | authorized | error
    user_code: str = ""
    verification_uri: str = ""
    error: str = ""


# ponytail: single-process in-memory login state; a device login doesn't need more
_session = DeviceLoginSession()


def device_login_status() -> DeviceLoginSession:
    return _session


async def start_device_login() -> DeviceLoginSession:
    """Begin a web-driven device login; poll completion in the background."""
    global _session
    if _session.status == "pending":
        return _session
    payload = await request_device_code()
    _session = DeviceLoginSession(
        status="pending",
        user_code=payload["user_code"],
        verification_uri=payload.get("verification_uri", "https://github.com/login/device"),
    )
    asyncio.create_task(_finish_device_login(payload))
    return _session


async def _finish_device_login(payload: dict) -> None:
    try:
        token = await poll_for_token(
            payload["device_code"],
            int(payload.get("interval", 5)),
            int(payload.get("expires_in", 900)),
        )
        save_github_token(token)
        _session.status = "authorized"
    except Exception as exc:
        _session.status = "error"
        _session.error = str(exc)


def has_stored_github_token() -> bool:
    """True when a stored GitHub OAuth token is available for Copilot exchange."""
    try:
        from oauth_cli_kit.storage import FileTokenStorage
    except ImportError:
        return False
    storage = FileTokenStorage(  # nosec B106 - token_filename is a file name, not a password.
        token_filename=TOKEN_FILENAME,
        app_name=APP_NAME,
        import_codex_cli=False,
    )
    token = storage.load()
    return bool(token and getattr(token, "access", None))


def save_github_token(access_token: str) -> Path:
    """Persist the GitHub token where GitHubCopilotProvider reads it."""
    from oauth_cli_kit.models import OAuthToken
    from oauth_cli_kit.storage import FileTokenStorage

    storage = FileTokenStorage(  # nosec B106 - token_filename is a file name, not a password.
        token_filename=TOKEN_FILENAME,
        app_name=APP_NAME,
        import_codex_cli=False,
    )
    storage.save(
        OAuthToken(
            access=access_token,
            refresh="",
            expires=int(time.time()) + _FAR_FUTURE_SECONDS,
        )
    )
    return storage.get_token_path()
