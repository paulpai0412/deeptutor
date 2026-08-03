"""Localized display metadata for built-in tools and capabilities."""

from __future__ import annotations

_CAPABILITY_DESCRIPTIONS: dict[str, dict[str, str]] = {
    "chat": {
        "en": "Default agentic chat with tools, retrieval, memory, and attachments.",
        "zh": "默认智能聊天，支持工具、检索、记忆和附件。",
        "zh-TW": "預設智慧聊天，支援工具、檢索、記憶與附件。",
    },
    "deep_solve": {
        "en": "Multi-step problem solving with planning, reasoning, and final writing.",
        "zh": "多步骤解题，包含规划、推理和最终作答。",
        "zh-TW": "多步驟解題，包含規劃、推理與最終作答。",
    },
    "deep_question": {
        "en": "Generate high-quality questions from templates, sources, or learning goals.",
        "zh": "基于模板、资料或学习目标生成高质量题目。",
        "zh-TW": "根據範本、資料或學習目標產生高品質題目。",
    },
    "deep_research": {
        "en": "Iterative deep research that decomposes a topic and writes a report.",
        "zh": "迭代式深度研究，分解主题并生成研究报告。",
        "zh-TW": "迭代式深度研究，分解主題並產生研究報告。",
    },
    "math_animator": {
        "en": "Generate math animations or storyboard images with Manim.",
        "zh": "使用 Manim 生成数学动画或分镜图。",
        "zh-TW": "使用 Manim 產生數學動畫或分鏡圖。",
    },
    "mastery_path": {
        "en": "Structured mastery-based learning with spaced repetition.",
        "zh": "结构化掌握式学习，结合间隔复习。",
        "zh-TW": "結構化精熟學習，結合間隔複習。",
    },
    "visualize": {
        "en": "Create visual explanations such as SVG, charts, Mermaid, HTML, or Manim.",
        "zh": "生成 SVG、图表、Mermaid、HTML 或 Manim 等可视化讲解。",
        "zh-TW": "產生 SVG、圖表、Mermaid、HTML 或 Manim 等視覺化說明。",
    },
}

_TOOL_DESCRIPTIONS: dict[str, dict[str, str]] = {
    "brainstorm": {
        "en": "Explore ideas broadly and organize them with rationale.",
        "zh": "广泛发散想法，并按理由组织结果。",
        "zh-TW": "廣泛發想，並依理由整理結果。",
    },
    "code_execution": {
        "en": "Run sandboxed Python code for computation and data exploration.",
        "zh": "在沙箱中运行 Python，用于计算和数据探索。",
        "zh-TW": "在沙箱中執行 Python，用於計算與資料探索。",
    },
    "exec": {
        "en": "Run shell commands inside an isolated sandbox workspace.",
        "zh": "在隔离沙箱工作区中运行 shell 命令。",
        "zh-TW": "在隔離的沙箱工作區中執行 shell 指令。",
    },
    "paper_search": {
        "en": "Search arXiv preprints and return paper metadata.",
        "zh": "搜索 arXiv 预印本并返回论文元数据。",
        "zh-TW": "搜尋 arXiv 預印本並傳回論文中繼資料。",
    },
    "reason": {
        "en": "Use a dedicated reasoning model call for hard reasoning tasks.",
        "zh": "调用专门的推理模型处理高难度推理任务。",
        "zh-TW": "呼叫專用推理模型處理高難度推理任務。",
    },
    "web_search": {
        "en": "Search the web and return sourced results.",
        "zh": "联网搜索并返回带来源的结果。",
        "zh-TW": "搜尋網路並傳回附有來源的結果。",
    },
    "imagegen": {
        "en": "Generate images from a text prompt with the configured model.",
        "zh": "用已配置的模型，根据文字描述生成图片。",
        "zh-TW": "使用已設定的模型，依文字描述產生圖片。",
    },
    "videogen": {
        "en": "Generate short videos from a text prompt with the configured model.",
        "zh": "用已配置的模型，根据文字描述生成短视频。",
        "zh-TW": "使用已設定的模型，依文字描述產生短影片。",
    },
}


def capability_description_i18n(name: str, fallback: str = "") -> dict[str, str]:
    values = _CAPABILITY_DESCRIPTIONS.get(name)
    if values:
        return dict(values)
    return {"en": fallback, "zh": fallback, "zh-TW": fallback}


def tool_description_i18n(name: str, fallback: str = "") -> dict[str, str]:
    values = _TOOL_DESCRIPTIONS.get(name)
    if values:
        return dict(values)
    return {"en": fallback, "zh": fallback, "zh-TW": fallback}


def localized_description(values: dict[str, str], language: str) -> str:
    code = (language or "en").lower().replace("_", "-")
    if code in {"zh-tw", "zh-hant", "zh-hk", "tw", "traditional"}:
        return values.get("zh-TW") or values.get("en") or ""
    lang = "zh" if code.startswith("zh") else "en"
    return values.get(lang) or values.get("en") or values.get("zh") or ""


__all__ = [
    "capability_description_i18n",
    "localized_description",
    "tool_description_i18n",
]
