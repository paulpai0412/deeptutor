"""Background extraction for Paper Library resources."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
import uuid

from deeptutor.api.utils.task_id_manager import TaskIDManager
from deeptutor.api.utils.task_log_stream import capture_task_logs, get_task_stream_manager
from deeptutor.services.config import get_agent_params
from deeptutor.services.llm.capabilities import supports_vision
from deeptutor.services.llm.config import LLMConfig, get_llm_config
from deeptutor.services.config import resolve_llm_runtime_config
from deeptutor.services.parsing import get_parse_service
from deeptutor.services.parsing.types import ParsedDocument, ParserError
from deeptutor.tools.question.question_extractor import extract_questions_with_llm

from .paper_library import (
    PAPER_STATUS_PARTIAL,
    PAPER_STATUS_READY,
    PAPER_STATUS_READY_WITH_WARNINGS,
    PaperLibraryService,
    PaperRecord,
)

_CANONICAL_TYPES = frozenset(
    {"choice", "concept", "fill_in_blank", "short_answer", "written", "coding"}
)
_CANONICAL_DIFFICULTIES = frozenset({"easy", "medium", "hard"})
_TYPE_ALIASES = {
    "multiple_choice": "choice",
    "mcq": "choice",
    "single_choice": "choice",
    "true_false": "concept",
    "boolean": "concept",
    "fill_blank": "fill_in_blank",
    "short": "short_answer",
    "essay": "written",
    "programming": "coding",
}
_MULTI_SELECT_TYPES = {"multi_select", "multiple_select", "checkbox", "check_box"}


class PaperExtractionError(RuntimeError):
    """Raised when a paper cannot produce a usable extraction result."""


ProgressCallback = Callable[[str, int, str], None]
LLMCallable = Callable[..., Awaitable[str]]


async def extract_paper(
    service: PaperLibraryService,
    paper_id: str,
    *,
    parser: Any | None = None,
    llm_call: LLMCallable | None = None,
    llm_config: LLMConfig | Any | None = None,
    task_id: str | None = None,
    progress_callback: ProgressCallback | None = None,
) -> PaperRecord:
    """Parse and extract one pending paper using the active primary LLM.

    The public service boundary owns durable state; this function only wires the
    existing parser, LLM factory, task registry, and task stream together.
    """
    task_manager = TaskIDManager.get_instance()
    task_id = task_id or task_manager.generate_task_id(
        "paper_extract", f"paper_extract:{service.root}:{paper_id}:{uuid.uuid4().hex}"
    )
    task_stream = get_task_stream_manager()
    task_stream.ensure_task(task_id)
    claimed = service.claim_extraction(paper_id, task_id)
    if claimed is None:
        return service.get_paper(paper_id)
    extraction_config = dict(claimed.extraction_config or {})

    def progress(stage: str, percent: int, message: str) -> None:
        service.update_progress(
            paper_id,
            stage=stage,
            message=message,
            percent=percent,
            task_id=task_id,
        )
        task_stream.emit(
            task_id,
            "progress",
            {
                "paper_id": paper_id,
                "task_id": task_id,
                "stage": stage,
                "percent": percent,
                "message": message,
            },
        )
        if progress_callback is not None:
            progress_callback(stage, percent, message)

    staging_dir = None
    try:
        with capture_task_logs(task_id):
            progress("processing", 10, "Parsing paper document.")
            parser_instance = parser or get_parse_service()
            parse_kwargs: dict[str, Any] = {
                "on_output": lambda line: progress("processing", 20, str(line)),
            }
            parser_engine = str(extraction_config.get("parser_engine") or "").strip()
            if parser is None and parser_engine:
                parse_kwargs["engine"] = parser_engine
            parsed = await asyncio.to_thread(
                parser_instance.parse,
                service.source_path(paper_id),
                **parse_kwargs,
            )
            if not isinstance(parsed, ParsedDocument):
                raise PaperExtractionError("Document parser returned an invalid result.")
            # Parse assets live in the content-addressed cache. Copy them into
            # a paper-local staging directory so a failed retry leaves the
            # previous questions/assets untouched.
            staging_dir, asset_names = service.stage_assets(
                paper_id, parsed.asset_dir, task_id
            )
            if not parsed.markdown.strip():
                raise PaperExtractionError(
                    "This paper has no usable text; scanned documents are not supported."
                )

            progress("processing", 35, "Sending the complete parsed document to the primary LLM.")
            config = llm_config or _llm_config_from_snapshot(extraction_config)
            params = get_agent_params("question")
            _ensure_context_fits(parsed, config, int(params.get("max_tokens", 4096)))
            raw_result = await asyncio.to_thread(
                extract_questions_with_llm,
                parsed.markdown,
                parsed.blocks,
                parsed.asset_dir,
                str(getattr(config, "api_key", "")),
                str(getattr(config, "base_url", "") or ""),
                str(config.model),
                getattr(config, "api_version", None),
                getattr(config, "binding", None),
                max_document_chars=None,
                return_metadata=True,
                llm_callable=llm_call,
            )
            if not isinstance(raw_result, dict):
                raise PaperExtractionError("The extraction response was not an object.")

            progress("processing", 75, "Validating extracted question structure.")
            questions, warnings, invalid_count = _normalize_result(
                raw_result,
                available_assets=asset_names,
                blocks=parsed.blocks,
                vision_enabled=supports_vision(
                    str(getattr(config, "binding", "") or "openai"),
                    str(getattr(config, "model", "") or ""),
                ),
            )
            if not questions:
                raise PaperExtractionError("No usable questions were extracted from this paper.")
            if not bool(raw_result.get("complete", True)):
                warnings.append("The primary LLM response did not cover the complete document.")
            if invalid_count:
                warnings.append(f"{invalid_count} extracted record(s) were unusable.")

            status = PAPER_STATUS_READY
            if not bool(raw_result.get("complete", True)) or invalid_count:
                status = PAPER_STATUS_PARTIAL
            elif warnings:
                status = PAPER_STATUS_READY_WITH_WARNINGS
            record = service.commit_extraction(
                paper_id,
                questions,
                status=status,
                warnings=warnings,
                parser_engine=parsed.engine,
                task_id=task_id,
                staging_dir=staging_dir,
            )
            staging_dir = None
            task_manager.update_task_status(task_id, "completed", paper_id=paper_id)
            task_stream.emit_complete(task_id, "Paper extraction completed.")
            return record
    except Exception as exc:
        service.cleanup_staging(staging_dir)
        error = _user_error(exc)
        record = service.mark_failed(paper_id, error, task_id=task_id)
        task_manager.update_task_status(task_id, "error", paper_id=paper_id, error=error)
        task_stream.emit_failed(task_id, error)
        return record


def _llm_config_from_snapshot(extraction_config: dict[str, Any]) -> LLMConfig:
    """Resolve a paper's snapshotted LLM selection without mutating globals."""
    selection = extraction_config.get("llm_selection")
    if not selection:
        return get_llm_config()
    resolved = resolve_llm_runtime_config(llm_selection=selection)
    return LLMConfig(
        model=resolved.model,
        api_key=resolved.api_key,
        base_url=resolved.base_url,
        effective_url=resolved.effective_url,
        binding=resolved.binding,
        provider_name=resolved.provider_name,
        provider_mode=resolved.provider_mode,
        api_version=resolved.api_version,
        extra_headers=resolved.extra_headers,
        reasoning_effort=resolved.reasoning_effort,
        context_window=resolved.context_window,
    )


def _ensure_context_fits(parsed: ParsedDocument, config: Any, max_tokens: int) -> None:
    context_window = getattr(config, "context_window", None)
    if not context_window:
        return
    block_text = str(parsed.blocks or [])
    estimated_input_tokens = (len(parsed.markdown) + len(block_text)) // 4 + 512
    try:
        context_limit = int(context_window)
    except (TypeError, ValueError) as exc:
        raise PaperExtractionError("The active primary LLM context window is invalid.") from exc
    if estimated_input_tokens + max_tokens >= context_limit:
        raise PaperExtractionError(
            "The parsed paper exceeds the active primary LLM context window; "
            "the document was not truncated or split."
        )


def _normalize_result(
    payload: dict[str, Any],
    *,
    available_assets: list[str] | None = None,
    blocks: list[dict[str, Any]] | None = None,
    vision_enabled: bool = False,
) -> tuple[list[dict[str, Any]], list[str], int]:
    raw_questions = payload.get("questions", [])
    if not isinstance(raw_questions, list):
        raise PaperExtractionError("The extraction response field 'questions' is not a list.")
    raw_warnings = payload.get("warnings", [])
    warnings = [str(item) for item in raw_warnings] if isinstance(raw_warnings, list) else []
    questions: list[dict[str, Any]] = []
    invalid_count = 0
    for raw_question in raw_questions:
        normalized, question_warnings = _normalize_question(
            raw_question,
            available_assets=available_assets,
            blocks=blocks,
        )
        if normalized is None:
            invalid_count += 1
            continue
        normalized["warnings"] = question_warnings
        questions.append(normalized)
        warnings.extend(
            f"Question {normalized['question_number']}: {warning}" for warning in question_warnings
        )

    if available_assets is not None:
        missing_block_images = _missing_block_image_references(blocks, available_assets)
        warnings.extend(
            f"Image asset '{reference}' referenced by the parser was not found."
            for reference in missing_block_images
        )
        has_image_information = bool(available_assets or missing_block_images)
        used_assets: set[str] = set()
        if has_image_information and not vision_enabled:
            warnings.append(
                "Vision is unavailable; image associations were not inferred and require manual review."
            )

        for question in questions:
            if question.get("images"):
                used_assets.update(str(name) for name in question["images"])
            elif has_image_information:
                question["warnings"].append(
                    "No image asset could be confidently associated with this question."
                )

        for name in available_assets:
            if name not in used_assets:
                warnings.append(f"Image asset '{name}' could not be confidently associated with a question.")

        if has_image_information and not questions:
            warnings.append("Extracted image assets could not be associated because no questions were returned.")
    elif any(isinstance(question, dict) and question.get("images") for question in raw_questions):
        warnings.append("The extraction referenced images, but no persisted image assets were available.")

    for question in questions:
        warnings.extend(
            f"Question {question['question_number']}: {warning}"
            for warning in question["warnings"]
            if f"Question {question['question_number']}: {warning}" not in warnings
        )
    return questions, _dedupe(warnings), invalid_count


def _normalize_question(
    raw_question: Any,
    *,
    available_assets: list[str] | None = None,
    blocks: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, Any] | None, list[str]]:
    if not isinstance(raw_question, dict):
        return None, []
    number = str(
        raw_question.get("question_number")
        or raw_question.get("source_question_number")
        or raw_question.get("number")
        or ""
    ).strip()
    text = str(raw_question.get("question_text") or raw_question.get("question") or "").strip()
    if not number or not text:
        return None, []

    warnings: list[str] = []
    raw_type = str(raw_question.get("question_type") or "written").strip().lower()
    is_multi_select = raw_type in _MULTI_SELECT_TYPES or bool(raw_question.get("multi_select"))
    question_type = _TYPE_ALIASES.get(raw_type, raw_type)
    if question_type not in _CANONICAL_TYPES:
        warnings.append(f"Unknown question type '{raw_type}'; stored as written.")
        question_type = "written"
    if is_multi_select:
        warnings.append("Multi-select answer requires manual review.")

    raw_difficulty = str(raw_question.get("difficulty") or "").strip().lower()
    difficulty = raw_difficulty if raw_difficulty in _CANONICAL_DIFFICULTIES else None
    options = _normalize_options(raw_question.get("options"))
    answer = str(raw_question.get("answer") or "").strip()
    if not answer:
        warnings.append("Reference answer is unavailable")

    page = _coerce_page(raw_question.get("page", raw_question.get("page_number")))
    if page is None:
        page = _infer_question_page(number, text, blocks)

    raw_images = raw_question.get("images", [])
    if isinstance(raw_images, str):
        raw_images = [raw_images]
    if not isinstance(raw_images, list):
        raw_images = []
    images: list[str] = []
    for raw_image in raw_images:
        image_name = _resolve_asset_name(raw_image, available_assets)
        if image_name is None:
            warnings.append(f"Image reference '{str(raw_image).strip()}' was not found in paper assets.")
        elif image_name not in images:
            images.append(image_name)

    visual_warnings = raw_question.get("image_warnings", raw_question.get("visual_warnings", []))
    if isinstance(visual_warnings, str):
        visual_warnings = [visual_warnings]
    if isinstance(visual_warnings, list):
        warnings.extend(f"Visual review: {str(item)}" for item in visual_warnings if str(item).strip())
    visual_verified = raw_question.get("visual_verified")
    if (
        raw_question.get("image_uncertain")
        or raw_question.get("visual_uncertain")
        or (isinstance(visual_verified, bool) and not visual_verified)
    ):
        warnings.append("Visual meaning could not be verified automatically; review the image manually.")
    confidence = raw_question.get("image_confidence", raw_question.get("visual_confidence"))
    try:
        if confidence is not None and float(confidence) < 0.7:
            warnings.append("Visual meaning confidence is low; review the image manually.")
    except (TypeError, ValueError):
        pass

    normalized: dict[str, Any] = {
        "question_id": str(uuid.uuid4()),
        "question_number": number,
        "question_text": text,
        "options": options,
        "question_type": question_type,
        "difficulty": difficulty,
        "answer": answer,
        "images": images,
        "page": page,
        "is_multi_select": is_multi_select,
        "source_question_type": raw_type,
    }
    source_id = raw_question.get("source_question_id")
    if source_id is not None and str(source_id).strip():
        normalized["source_question_id"] = str(source_id).strip()
    return normalized, warnings


def _coerce_page(value: Any, *, page_index: bool = False) -> int | None:
    if value is None:
        return None
    try:
        page = int(value)
    except (TypeError, ValueError):
        return None
    return page + 1 if page_index else page


def _block_page(block: dict[str, Any]) -> int | None:
    if "page_idx" in block:
        return _coerce_page(block.get("page_idx"), page_index=True)
    for key in ("page", "page_number"):
        page = _coerce_page(block.get(key))
        if page is not None:
            return page
    return None


def _resolve_asset_name(value: Any, available_assets: list[str] | None) -> str | None:
    text = str(value or "").strip().replace("\\", "/")
    if not text or text.lower().startswith("data:"):
        return None
    text = text.split("?", 1)[0].split("#", 1)[0]
    text = text.lstrip("/")
    candidates = [text]
    if text.startswith("images/"):
        candidates.append(text.removeprefix("images/"))
    candidates.append(Path(text).name)
    if available_assets is None:
        for candidate in candidates:
            if candidate and ".." not in Path(candidate).parts:
                return candidate
        return None
    available = set(available_assets)
    for candidate in candidates:
        if candidate in available:
            return candidate
    basename = Path(text).name
    matches = [name for name in available_assets if Path(name).name == basename]
    return matches[0] if len(matches) == 1 else None


def _block_image_refs(block: dict[str, Any]) -> list[Any]:
    refs: list[Any] = []
    for key in ("img_path", "image_path", "asset_path"):
        if block.get(key):
            refs.append(block[key])
    image = block.get("image")
    if isinstance(image, str):
        refs.append(image)
    elif isinstance(image, dict):
        for key in ("path", "img_path", "image_path", "filename", "name"):
            if image.get(key):
                refs.append(image[key])
    return refs


def _missing_block_image_references(
    blocks: list[dict[str, Any]] | None,
    available_assets: list[str],
) -> list[str]:
    missing: list[str] = []
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        for reference in _block_image_refs(block):
            if str(reference).strip() and _resolve_asset_name(reference, available_assets) is None:
                text = str(reference).strip()
                if text not in missing:
                    missing.append(text)
    return missing


def _infer_question_page(
    number: str,
    text: str,
    blocks: list[dict[str, Any]] | None,
) -> int | None:
    needles = [f"question {number}".casefold(), number.casefold(), text[:80].casefold()]
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        block_text = str(block.get("text") or block.get("content") or "").casefold()
        if block_text and any(needle and needle in block_text for needle in needles):
            page = _block_page(block)
            if page is not None:
                return page
    return None


def _normalize_options(raw_options: Any) -> dict[str, str]:
    if isinstance(raw_options, dict):
        return {
            str(key).strip(): str(value).strip()
            for key, value in raw_options.items()
            if str(key).strip()
        }
    if not isinstance(raw_options, list):
        return {}
    options: dict[str, str] = {}
    for index, item in enumerate(raw_options):
        if isinstance(item, dict):
            key = str(item.get("label") or item.get("key") or index + 1).strip()
            value = str(item.get("text") or item.get("value") or "").strip()
        else:
            key = str(index + 1)
            value = str(item).strip()
        if value:
            options[key] = value
    return options


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        normalized = str(item).strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def _user_error(exc: Exception) -> str:
    message = str(exc)
    if isinstance(exc, ParserError) and "no extractable text" in message.lower():
        return "This PDF has no usable text layer; scanned PDFs are not supported."
    if isinstance(exc, (PaperExtractionError, ParserError)):
        return message
    return f"Paper extraction failed: {message}"


__all__ = ["PaperExtractionError", "extract_paper"]
