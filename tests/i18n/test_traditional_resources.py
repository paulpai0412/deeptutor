from pathlib import Path
from typing import Any

import yaml

from deeptutor.capabilities.mastery.loop import _load_system_prompt as load_mastery_prompt
from deeptutor.capabilities.obsidian.capability import _load_system_prompt as load_obsidian_prompt
from deeptutor.capabilities.solve.loop import _load_system_prompt as load_solve_prompt

_SIMPLIFIED_ONLY = set(
    "这为个们来时对发后从过还将与无关开实问题学书当现应论进选体记录网线边门长业务动处报错别数据类条达转"
)


def _shape(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _shape(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_shape(item) for item in value]
    return type(value)


def test_traditional_resources_do_not_contain_simplified_characters() -> None:
    repository = Path(__file__).resolve().parents[2]
    resources = list((repository / "deeptutor").glob("**/zh-TW/*"))
    resources.extend((repository / "web" / "locales" / "zh-TW").glob("*.json"))

    for resource in resources:
        if resource.suffix not in {".json", ".md", ".yaml", ".yml"}:
            continue
        found = _SIMPLIFIED_ONLY.intersection(resource.read_text(encoding="utf-8"))
        assert not found, f"{resource} contains Simplified Chinese characters: {sorted(found)}"


def test_traditional_chinese_prompt_resources_match_simplified_structure() -> None:
    root = Path(__file__).resolve().parents[2] / "deeptutor"
    simplified = sorted(
        path
        for path in root.glob("**/prompts/zh/*")
        if path.suffix in {".md", ".yaml", ".yml"}
    )
    assert simplified

    for source in simplified:
        target = source.parent.parent / "zh-TW" / source.name
        assert target.is_file(), f"missing Traditional Chinese prompt: {target}"
        if source.suffix in {".yaml", ".yml"}:
            assert _shape(yaml.safe_load(target.read_text(encoding="utf-8"))) == _shape(
                yaml.safe_load(source.read_text(encoding="utf-8"))
            )

    learning_zh = root / "learning" / "prompts" / "zh.yaml"
    learning_tw = root / "learning" / "prompts" / "zh-TW.yaml"
    assert _shape(yaml.safe_load(learning_tw.read_text(encoding="utf-8"))) == _shape(
        yaml.safe_load(learning_zh.read_text(encoding="utf-8"))
    )


def test_markdown_prompt_loaders_select_traditional_resources() -> None:
    for loader in (load_mastery_prompt, load_obsidian_prompt, load_solve_prompt):
        traditional = loader("zh-TW")
        simplified = loader("zh")

        assert traditional != simplified
        assert any(char in traditional for char in "體學書讀寫連線")
