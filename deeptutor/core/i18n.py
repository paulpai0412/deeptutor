"""Small runtime i18n helper for backend-facing user messages."""

from __future__ import annotations

from typing import Any


def _parse_language(language: str | None) -> str:
    raw = (language or "en").strip().lower().replace("_", "-")
    if raw in {"zh-tw", "zh-hant", "zh-hk", "tw", "traditional"}:
        return "zh-TW"
    if raw.startswith("zh") or raw in {"cn", "chinese"}:
        return "zh"
    return "en"


_MESSAGES: dict[str, dict[str, str]] = {
    "en": {
        "api.content_required": "content is required",
        "api.invalid_channels_config": "Invalid channels config",
        "api.partner_already_exists": "Partner '{name}' already exists",
        "api.partner_not_found": "Partner not found",
        "api.partner_not_found_or_not_running": "Partner not found or not running",
        "api.partner_not_running": "Partner not running",
        "api.partner_stopped_start_required": "Partner is stopped. Start it before chatting.",
        "api.persona_already_exists": "Persona already exists: {name}",
        "api.persona_name_required": "Persona name is required",
        "api.persona_not_found": "Persona not found: {name}",
        "api.soul_already_exists": "Soul '{name}' already exists",
        "api.soul_content_empty": "Custom soul content is empty",
        "api.soul_library_not_found": "Soul '{name}' not found in library",
        "api.soul_not_found": "Soul not found",
        "api.tool_not_found": "Tool '{name}' not found",
        "mcp.configure_command_or_url": "Server {name!r}: configure either a command (stdio) or a url.",
        "mcp.configure_before_testing": "Configure either a command (stdio) or a url before testing.",
        "mcp.server_error": "Server {name!r}: {error}",
        "sandbox.command_blocked": "Error: command blocked by safety guard (dangerous pattern).",
        "sandbox.disabled_for_account": "Code execution is disabled for your account.",
        "sandbox.no_backend": "no sandbox backend available",
        "chat.searching_knowledge_base": "Searching knowledge base: {name}...",
        "chat.searching_web": "Searching the web...",
        "chat.generating_response": "Generating response...",
    },
    "zh": {
        "api.content_required": "content 不能为空",
        "api.invalid_channels_config": "渠道配置无效",
        "api.partner_already_exists": "伙伴 '{name}' 已存在",
        "api.partner_not_found": "未找到伙伴",
        "api.partner_not_found_or_not_running": "未找到伙伴或伙伴未运行",
        "api.partner_not_running": "伙伴未运行",
        "api.partner_stopped_start_required": "伙伴已停止。请先启动后再聊天。",
        "api.persona_already_exists": "Persona 已存在：{name}",
        "api.persona_name_required": "Persona 名称不能为空",
        "api.persona_not_found": "未找到 Persona：{name}",
        "api.soul_already_exists": "Soul '{name}' 已存在",
        "api.soul_content_empty": "自定义 soul 内容为空",
        "api.soul_library_not_found": "素材库中未找到 soul '{name}'",
        "api.soul_not_found": "未找到 soul",
        "api.tool_not_found": "未找到工具 '{name}'",
        "mcp.configure_command_or_url": "服务器 {name!r}：请配置 command（stdio）或 url。",
        "mcp.configure_before_testing": "测试前请先配置 command（stdio）或 url。",
        "mcp.server_error": "服务器 {name!r}：{error}",
        "sandbox.command_blocked": "错误：命令被安全防护拦截（匹配危险模式）。",
        "sandbox.disabled_for_account": "你的账号已禁用代码执行。",
        "sandbox.no_backend": "没有可用的沙箱后端",
        "chat.searching_knowledge_base": "正在搜索知识库：{name}...",
        "chat.searching_web": "正在搜索网络...",
        "chat.generating_response": "正在生成回复...",
    },
    "zh-TW": {
        "api.content_required": "content 不能為空",
        "api.invalid_channels_config": "頻道設定無效",
        "api.partner_already_exists": "夥伴「{name}」已存在",
        "api.partner_not_found": "找不到夥伴",
        "api.partner_not_found_or_not_running": "找不到夥伴，或夥伴尚未執行",
        "api.partner_not_running": "夥伴尚未執行",
        "api.partner_stopped_start_required": "夥伴已停止，請先啟動後再聊天。",
        "api.persona_already_exists": "Persona 已存在：{name}",
        "api.persona_name_required": "Persona 名稱不能為空",
        "api.persona_not_found": "找不到 Persona：{name}",
        "api.soul_already_exists": "Soul「{name}」已存在",
        "api.soul_content_empty": "自訂 soul 內容不能為空",
        "api.soul_library_not_found": "素材庫中找不到 soul「{name}」",
        "api.soul_not_found": "找不到 soul",
        "api.tool_not_found": "找不到工具「{name}」",
        "mcp.configure_command_or_url": "伺服器 {name!r}：請設定 command（stdio）或 url。",
        "mcp.configure_before_testing": "測試前請先設定 command（stdio）或 url。",
        "mcp.server_error": "伺服器 {name!r}：{error}",
        "sandbox.command_blocked": "錯誤：命令遭安全防護攔截（符合危險模式）。",
        "sandbox.disabled_for_account": "你的帳號已停用程式碼執行。",
        "sandbox.no_backend": "沒有可用的沙箱後端",
        "chat.searching_knowledge_base": "正在搜尋知識庫：{name}...",
        "chat.searching_web": "正在搜尋網路...",
        "chat.generating_response": "正在產生回覆...",
    },
}


parse_language = _parse_language


def current_language(default: str = "en") -> str:
    try:
        from deeptutor.services.settings.interface_settings import get_ui_language

        return _parse_language(get_ui_language(default=default))
    except Exception:
        return _parse_language(default)


def t(key: str, default: str = "", *, language: str | None = None, **kwargs: Any) -> str:
    lang = _parse_language(language) if language else current_language()
    text = _MESSAGES.get(lang, {}).get(key) or _MESSAGES["en"].get(key) or default
    if kwargs:
        try:
            return text.format(**kwargs)
        except (KeyError, IndexError, ValueError):
            return text
    return text


__all__ = ["current_language", "parse_language", "t"]
