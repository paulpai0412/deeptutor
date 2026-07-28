from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import types


def _load_question_extractor_module():
    module_path = (
        Path(__file__).resolve().parents[2]
        / "deeptutor"
        / "tools"
        / "question"
        / "question_extractor.py"
    )

    def prepare_multimodal_messages(messages, attachments, **_kwargs):
        content = messages[-1].get("content", "")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for attachment in attachments:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{attachment.mime_type};base64,{attachment.base64}"
                    },
                }
            )
        messages[-1] = {**messages[-1], "content": content}
        return types.SimpleNamespace(messages=messages, url_images_dropped=0)

    stubbed_modules = {
        "deeptutor.services.config": {
            "get_agent_params": lambda *_args, **_kwargs: {
                "temperature": 0,
                "max_tokens": 100,
            }
        },
        "deeptutor.services.llm": {"complete": lambda *_args, **_kwargs: None},
        "deeptutor.services.llm.capabilities": {
            "supports_response_format": lambda *_args, **_kwargs: False,
            "supports_vision": lambda *_args, **_kwargs: False,
        },
        "deeptutor.services.llm.config": {"get_llm_config": lambda: None},
        "deeptutor.services.llm.multimodal": {
            "prepare_multimodal_messages": prepare_multimodal_messages
        },
        "deeptutor.utils.json_parser": {"parse_json_response": lambda *_args, **_kwargs: {}},
    }

    original_modules: dict[str, types.ModuleType | None] = {}
    for module_name, attributes in stubbed_modules.items():
        original_modules[module_name] = sys.modules.get(module_name)
        module = types.ModuleType(module_name)
        for attr_name, value in attributes.items():
            setattr(module, attr_name, value)
        sys.modules[module_name] = module

    try:
        spec = importlib.util.spec_from_file_location("question_extractor_under_test", module_path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        for module_name, original_module in original_modules.items():
            if original_module is None:
                sys.modules.pop(module_name, None)
            else:
                sys.modules[module_name] = original_module


def test_vision_primary_receives_all_persisted_images(tmp_path: Path) -> None:
    question_extractor = _load_question_extractor_module()
    question_extractor.supports_vision = lambda *_args, **_kwargs: True
    question_extractor.parse_json_response = lambda value, **_kwargs: json.loads(value)
    images_dir = tmp_path / "images"
    images_dir.mkdir()
    (images_dir / "figure.png").write_bytes(b"fixture-image")
    captured: dict = {}

    async def fake_llm(**kwargs):
        captured.update(kwargs)
        return '{"questions": [{"question_number": "1", "question_text": "See figure"}]}'

    result = question_extractor.extract_questions_with_llm(
        markdown_content="Question 1: See figure",
        content_list=[{"type": "image", "img_path": "/private/cache/images/figure.png"}],
        images_dir=images_dir,
        api_key="test-key",
        base_url="https://example.test/v1",
        model="gpt-4o",
        binding="openai",
        return_metadata=True,
        llm_callable=fake_llm,
    )

    assert "messages" in captured
    image_parts = [
        item
        for item in captured["messages"][-1]["content"]
        if item.get("type") == "image_url"
    ]
    assert len(image_parts) == 1
    assert "Zml4dHVyZS1pbWFnZQ==" in image_parts[0]["image_url"]["url"]
    assert result["questions"][0]["question_number"] == "1"


def test_load_parsed_paper_supports_nested_hybrid_auto_output(tmp_path: Path) -> None:
    question_extractor = _load_question_extractor_module()
    paper_dir = tmp_path / "mimic_exam"
    parsed_dir = paper_dir / "hybrid_auto"
    images_dir = parsed_dir / "images"
    images_dir.mkdir(parents=True)

    markdown_path = parsed_dir / "exam.md"
    markdown_path.write_text("# Exam content", encoding="utf-8")

    content_list_path = parsed_dir / "exam_content_list.json"
    content_list_path.write_text(
        json.dumps([{"type": "text", "text": "Question 1"}], ensure_ascii=False),
        encoding="utf-8",
    )

    (images_dir / "figure.png").write_text("image-bytes", encoding="utf-8")

    markdown_content, content_list, discovered_images_dir = question_extractor.load_parsed_paper(
        paper_dir
    )

    assert markdown_content == "# Exam content"
    assert content_list == [{"type": "text", "text": "Question 1"}]
    assert discovered_images_dir == images_dir
