"""HTTP API for private Paper Library source resources."""

from __future__ import annotations

import mimetypes
from pathlib import Path, PurePosixPath
from typing import Any
import uuid

from fastapi import (  # type: ignore[import-not-found]
    APIRouter,
    BackgroundTasks,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.responses import FileResponse, StreamingResponse  # type: ignore[import-not-found]
from pydantic import BaseModel, Field

from deeptutor.api.utils.task_id_manager import TaskIDManager
from deeptutor.api.utils.task_log_stream import get_task_stream_manager
from deeptutor.multi_user.context import get_current_user
from deeptutor.multi_user.models import CurrentUser
from deeptutor.multi_user.paths import user_context
from deeptutor.services.config import get_model_catalog_service
from deeptutor.services.model_selection.llm import LLMSelection, list_llm_options
from deeptutor.services.paper_extraction import extract_paper
from deeptutor.services.parsing.engines.factory import KNOWN_ENGINES, is_engine_available, list_engines
from deeptutor.services.paper_library import (
    PaperBusyError,
    PaperLibrary,
    PaperLibraryError,
    PaperLibraryService,
    PaperValidationError,
    normalize_folder_path,
)
from deeptutor.utils.document_validator import DocumentValidator

router = APIRouter()


class PaperLibraryCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    settings: dict[str, Any] = Field(default_factory=dict)


class PaperLibraryUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    settings: dict[str, Any] | None = None


class PaperLibrarySummary(BaseModel):
    library_id: str
    name: str
    description: str = ""
    settings: dict[str, Any] = Field(default_factory=dict)
    folders: list[str] = Field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
    paper_count: int = 0


class PaperLibraryListResponse(BaseModel):
    libraries: list[PaperLibrarySummary]


class PaperQuestion(BaseModel):
    question_id: str
    question_number: str
    question_text: str
    options: dict[str, str] = Field(default_factory=dict)
    question_type: str
    difficulty: str | None = None
    answer: str = ""
    images: list[str] = Field(default_factory=list)
    page: int | None = None
    is_multi_select: bool = False
    source_question_type: str | None = None
    warnings: list[str] = Field(default_factory=list)
    source_question_id: str | None = None


class PaperSummary(BaseModel):
    paper_id: str
    display_name: str
    original_filename: str
    source_hash: str
    status: str
    question_count: int
    warning_count: int
    created_at: str
    updated_at: str
    folder_path: str = ""
    error: str = ""
    warnings: list[str] = Field(default_factory=list)
    progress: dict = Field(default_factory=dict)
    task_id: str = ""
    parser_engine: str = ""
    library_id: str = "legacy"
    extraction_config: dict[str, Any] = Field(default_factory=dict)


class PaperDetail(PaperSummary):
    questions: list[PaperQuestion] = Field(default_factory=list)
    assets: list[str] = Field(default_factory=list)


class PaperListResponse(BaseModel):
    papers: list[PaperSummary]
    folders: list[str] = Field(default_factory=list)


class PaperFolderCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    parent_path: str = Field(default="", max_length=2000)


class PaperFolderResponse(BaseModel):
    path: str


class PaperFolderListResponse(BaseModel):
    folders: list[str] = Field(default_factory=list)


class PaperUploadResponse(BaseModel):
    papers: list[PaperSummary]
    rejected: list[dict[str, str]]
    batch_id: str = ""


class PaperRenameRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=200)


class PaperMoveRequest(BaseModel):
    target_library_id: str = Field(min_length=1)
    target_folder_path: str = Field(default="", max_length=2000)


class PaperQuestionUpdate(BaseModel):
    question_number: str = Field(min_length=1, max_length=200)
    answer: str = ""
    images: list[str] | None = None


def get_paper_library_service() -> PaperLibraryService:
    """Resolve the current user's Paper Library service per request."""
    return PaperLibraryService()


def _summary(record) -> PaperSummary:
    return PaperSummary(**record.to_dict())


def _detail(service: PaperLibraryService, record) -> PaperDetail:
    return PaperDetail(
        **record.to_dict(),
        questions=[
            PaperQuestion(**question) for question in service.get_questions(record.paper_id)
        ],
        assets=service.list_assets(record.paper_id),
    )


def _validate_library_settings(settings: dict[str, Any] | None) -> dict[str, Any]:
    """Validate and redact the small, durable extraction settings contract."""
    raw = dict(settings or {})
    llm_enabled = raw.get("llm_enabled")
    if isinstance(llm_enabled, bool) and not llm_enabled:
        raise PaperValidationError("Structured paper extraction requires an LLM.")

    parser_engine = str(raw.get("parser_engine") or "").strip().lower()
    if parser_engine and parser_engine not in KNOWN_ENGINES:
        raise PaperValidationError(f"Unknown document-parsing engine: {parser_engine}")
    if parser_engine and not is_engine_available(parser_engine):
        raise PaperValidationError(f"The '{parser_engine}' parsing engine is not available.")
    failure_policy = str(raw.get("failure_policy") or "keep_partial").strip().lower()
    if failure_policy not in {"keep_partial"}:
        raise PaperValidationError(f"Unsupported paper failure policy: {failure_policy}")

    selection = raw.get("llm_selection")
    normalized_selection = LLMSelection.from_payload(selection)
    if normalized_selection is not None:
        try:
            # Resolving against the catalog verifies that the IDs exist without
            # exposing provider credentials in the Paper Library record.
            from deeptutor.services.model_selection.llm import apply_llm_selection_to_catalog

            apply_llm_selection_to_catalog(
                get_model_catalog_service().load(), normalized_selection
            )
        except ValueError as exc:
            raise PaperValidationError(str(exc)) from exc

    return {
        "llm_selection": (
            normalized_selection.to_dict() if normalized_selection is not None else None
        ),
        "parser_engine": parser_engine,
        "failure_policy": failure_policy,
    }


def _extraction_config_for_library(library: PaperLibrary) -> dict[str, Any]:
    settings = dict(library.settings or {})
    normalized = _validate_library_settings(settings)
    if normalized["llm_selection"] is None:
        active = list_llm_options(get_model_catalog_service().load()).get("active")
        if isinstance(active, dict) and active.get("profile_id") and active.get("model_id"):
            normalized["llm_selection"] = {
                "profile_id": str(active["profile_id"]),
                "model_id": str(active["model_id"]),
            }
    return {"schema_version": 1, **normalized}


def _library_summary(service: PaperLibraryService, library: PaperLibrary) -> PaperLibrarySummary:
    return PaperLibrarySummary(
        **library.to_dict(),
        paper_count=len(service.list_papers(library_id=library.library_id)),
    )


def _require_library_paper(
    service: PaperLibraryService,
    library_id: str,
    paper_id: str,
):
    try:
        service.get_library(library_id)
        paper = service.get_paper(paper_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper or Paper Library not found") from exc
    if paper.library_id != library_id:
        raise HTTPException(status_code=404, detail="Paper not found in this Paper Library")
    return paper


def _task_id_for(
    service: PaperLibraryService,
    paper_id: str,
    *,
    retry: bool = False,
) -> str:
    suffix = f":retry:{uuid.uuid4().hex}" if retry else ""
    return TaskIDManager.get_instance().generate_task_id(
        "paper_extract", f"paper_extract:{service.root}:{paper_id}{suffix}"
    )


async def _run_paper_extraction_task(
    root: str,
    paper_id: str,
    task_id: str,
    user: CurrentUser,
) -> None:
    """Run extraction with the request user's workspace and model settings."""
    with user_context(user):
        service = PaperLibraryService(root=Path(root))
        await extract_paper(service, paper_id, task_id=task_id)


async def _run_paper_extraction_batch(
    root: str,
    jobs: list[tuple[str, str]],
    user: CurrentUser,
) -> None:
    """Process one upload batch serially while isolating per-paper failures."""
    with user_context(user):
        service = PaperLibraryService(root=Path(root))
        for paper_id, task_id in jobs:
            try:
                await _run_paper_extraction_task(root, paper_id, task_id, user)
            except Exception as exc:  # pragma: no cover - defensive task boundary
                try:
                    service.mark_failed(paper_id, f"Paper extraction failed: {exc}", task_id=task_id)
                except Exception:
                    continue


def _upload_path_parts(filename: str, relative_path: str | None) -> tuple[str, str]:
    """Return a safe basename and normalized folder path for one upload."""
    raw = str(relative_path or "").strip().replace("\\", "/")
    if not raw:
        return filename, ""
    path = PurePosixPath(raw)
    if (
        path.is_absolute()
        or ".." in path.parts
        or not path.name
        or any(ord(char) < 32 or ord(char) == 127 for char in path.name)
    ):
        raise PaperValidationError("Upload relative path must stay inside the Paper Library.")
    folder_path = normalize_folder_path(path.parent.as_posix() if str(path.parent) != "." else "")
    return path.name, folder_path


async def _upload_papers(
    background_tasks: BackgroundTasks,
    files: list[UploadFile],
    *,
    library_id: str | None = None,
    rel_paths: list[str] | None = None,
) -> PaperUploadResponse:
    service = get_paper_library_service()
    user = get_current_user()
    extraction_config: dict[str, Any] = {}
    if library_id is not None:
        try:
            extraction_config = _extraction_config_for_library(service.get_library(library_id))
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Paper Library not found") from exc
        except PaperValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    batch_id = f"paper_batch_{uuid.uuid4().hex}"
    papers: list[PaperSummary] = []
    rejected: list[dict[str, str]] = []
    jobs: list[tuple[str, str]] = []
    for index, upload in enumerate(files):
        filename = upload.filename or "paper.pdf"
        relative_path = rel_paths[index] if rel_paths and index < len(rel_paths) else ""
        try:
            safe_filename, folder_path = _upload_path_parts(filename, relative_path)
            content = await upload.read(DocumentValidator.MAX_FILE_SIZE + 1)
            record = service.add_pdf(
                safe_filename,
                content,
                library_id=library_id,
                folder_path=folder_path,
                extraction_config=extraction_config,
            )
            if record.status == "pending":
                existing_task_id = record.task_id
                task_id = existing_task_id or _task_id_for(service, record.paper_id)
                record = service.assign_task(record.paper_id, task_id)
                if not existing_task_id:
                    jobs.append((record.paper_id, task_id))
        except PaperValidationError as exc:
            rejected.append({"filename": filename, "error": str(exc)})
            continue
        except Exception as exc:
            rejected.append({"filename": filename, "error": f"Upload failed: {exc}"})
            continue
        papers.append(_summary(record))
    if jobs:
        background_tasks.add_task(
            _run_paper_extraction_batch,
            str(service.root),
            jobs,
            user,
        )
    return PaperUploadResponse(papers=papers, rejected=rejected, batch_id=batch_id)


@router.post("/upload", response_model=PaperUploadResponse)
async def upload_papers(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    rel_paths: list[str] | None = Form(default=None),
) -> PaperUploadResponse:
    return await _upload_papers(background_tasks, files, rel_paths=rel_paths)


@router.get("/libraries", response_model=PaperLibraryListResponse)
async def list_libraries() -> PaperLibraryListResponse:
    service = get_paper_library_service()
    return PaperLibraryListResponse(
        libraries=[_library_summary(service, item) for item in service.list_libraries()]
    )


@router.post("/libraries", response_model=PaperLibrarySummary, status_code=201)
async def create_library(payload: PaperLibraryCreateRequest) -> PaperLibrarySummary:
    service = get_paper_library_service()
    try:
        settings = _validate_library_settings(payload.settings)
        library = service.create_library(
            payload.name,
            description=payload.description,
            settings=settings,
        )
    except PaperValidationError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _library_summary(service, library)


@router.get("/libraries/options")
async def library_options() -> dict[str, Any]:
    catalog = get_model_catalog_service().load()
    return {
        "llm": list_llm_options(catalog),
        "parsers": list_engines(),
        "failure_policies": [
            {"id": "keep_partial", "label": "Keep usable questions"},
        ],
        "llm_required": True,
    }


@router.get("/libraries/{library_id}", response_model=PaperLibrarySummary)
async def get_library(library_id: str) -> PaperLibrarySummary:
    service = get_paper_library_service()
    try:
        return _library_summary(service, service.get_library(library_id))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper Library not found") from exc


@router.patch("/libraries/{library_id}", response_model=PaperLibrarySummary)
async def update_library(
    library_id: str,
    payload: PaperLibraryUpdateRequest,
) -> PaperLibrarySummary:
    service = get_paper_library_service()
    try:
        settings = (
            _validate_library_settings(payload.settings)
            if payload.settings is not None
            else None
        )
        library = service.update_library(
            library_id,
            name=payload.name,
            description=payload.description,
            settings=settings,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper Library not found") from exc
    except PaperValidationError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _library_summary(service, library)


@router.delete("/libraries/{library_id}")
async def delete_library(library_id: str) -> dict[str, Any]:
    service = get_paper_library_service()
    try:
        service.delete_library(library_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper Library not found") from exc
    except PaperBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"deleted": True, "library_id": library_id}


@router.get("/libraries/{library_id}/papers", response_model=PaperListResponse)
async def list_library_papers(
    library_id: str,
    search: str | None = Query(default=None),
    status: str | None = Query(default=None),
    folder_path: str | None = Query(default=None),
) -> PaperListResponse:
    service = get_paper_library_service()
    try:
        papers = service.list_papers(
            library_id=library_id,
            search=search,
            status=status,
            folder_path=folder_path,
        )
        folders = service.list_folders(library_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper Library not found") from exc
    except PaperValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return PaperListResponse(
        papers=[_summary(record) for record in papers],
        folders=folders,
    )


@router.get("/libraries/{library_id}/folders", response_model=PaperFolderListResponse)
async def list_library_folders(library_id: str) -> PaperFolderListResponse:
    service = get_paper_library_service()
    try:
        return PaperFolderListResponse(folders=service.list_folders(library_id))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper Library not found") from exc


@router.post(
    "/libraries/{library_id}/folders",
    response_model=PaperFolderResponse,
    status_code=201,
)
async def create_library_folder(
    library_id: str,
    payload: PaperFolderCreateRequest,
) -> PaperFolderResponse:
    service = get_paper_library_service()
    try:
        path = service.create_folder(
            library_id,
            payload.name,
            parent_path=payload.parent_path,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper Library or parent folder not found") from exc
    except PaperValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return PaperFolderResponse(path=path)


@router.post("/libraries/{library_id}/upload", response_model=PaperUploadResponse)
async def upload_library_papers(
    library_id: str,
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    rel_paths: list[str] | None = Form(default=None),
) -> PaperUploadResponse:
    return await _upload_papers(
        background_tasks,
        files,
        library_id=library_id,
        rel_paths=rel_paths,
    )


@router.patch(
    "/libraries/{library_id}/papers/{paper_id}",
    response_model=PaperSummary,
)
async def rename_library_paper(
    library_id: str,
    paper_id: str,
    payload: PaperRenameRequest,
) -> PaperSummary:
    service = get_paper_library_service()
    _require_library_paper(service, library_id, paper_id)
    try:
        record = service.rename_paper(paper_id, payload.display_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper not found") from exc
    except PaperValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _summary(record)


@router.post(
    "/libraries/{library_id}/papers/{paper_id}/move",
    response_model=PaperSummary,
)
async def move_library_paper(
    library_id: str,
    paper_id: str,
    payload: PaperMoveRequest,
) -> PaperSummary:
    service = get_paper_library_service()
    _require_library_paper(service, library_id, paper_id)
    try:
        record = service.move_paper(
            paper_id,
            payload.target_library_id,
            payload.target_folder_path,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper Library or destination folder not found") from exc
    except PaperBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PaperValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PaperLibraryError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _summary(record)


@router.delete("/libraries/{library_id}/papers/{paper_id}")
async def delete_library_paper(library_id: str, paper_id: str) -> dict[str, Any]:
    service = get_paper_library_service()
    _require_library_paper(service, library_id, paper_id)
    try:
        service.delete_paper(paper_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper not found") from exc
    except PaperBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"deleted": True, "paper_id": paper_id, "library_id": library_id}


@router.post(
    "/libraries/{library_id}/papers/{paper_id}/retry",
    response_model=PaperSummary,
)
async def retry_library_paper(
    library_id: str,
    paper_id: str,
    background_tasks: BackgroundTasks,
) -> PaperSummary:
    service = get_paper_library_service()
    _require_library_paper(service, library_id, paper_id)
    user = get_current_user()
    try:
        record = service.prepare_retry(paper_id)
        already_queued = record.status == "pending" and bool(record.task_id)
        task_id = record.task_id or _task_id_for(service, paper_id, retry=True)
        record = service.assign_task(paper_id, task_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper not found") from exc
    except PaperBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PaperLibraryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not already_queued:
        background_tasks.add_task(
            _run_paper_extraction_task,
            str(service.root),
            paper_id,
            task_id,
            user,
        )
    return _summary(record)


@router.post("/{paper_id}/retry", response_model=PaperSummary)
async def retry_paper(
    paper_id: str,
    background_tasks: BackgroundTasks,
) -> PaperSummary:
    service = get_paper_library_service()
    user = get_current_user()
    try:
        record = service.prepare_retry(paper_id)
        already_queued = record.status == "pending" and bool(record.task_id)
        task_id = record.task_id or _task_id_for(service, paper_id, retry=True)
        record = service.assign_task(paper_id, task_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper not found") from exc
    except PaperBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PaperLibraryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not already_queued:
        background_tasks.add_task(
            _run_paper_extraction_task,
            str(service.root),
            paper_id,
            task_id,
            user,
        )
    return _summary(record)


@router.delete("/{paper_id}")
async def delete_paper(paper_id: str) -> dict[str, Any]:
    try:
        get_paper_library_service().delete_paper(paper_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper not found") from exc
    except PaperBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"deleted": True, "paper_id": paper_id}


@router.get("", response_model=PaperListResponse)
async def list_papers(
    search: str | None = Query(default=None),
    status: str | None = Query(default=None),
) -> PaperListResponse:
    service = get_paper_library_service()
    return PaperListResponse(
        papers=[_summary(record) for record in service.list_papers(search=search, status=status)]
    )


@router.get("/tasks/{task_id}/stream")
async def stream_paper_task(task_id: str):
    """Stream progress and logs for a Paper Library extraction task."""
    manager = get_task_stream_manager()
    manager.ensure_task(task_id)
    return StreamingResponse(
        manager.stream(task_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/{paper_id}/assets/{filename:path}")
async def open_paper_asset(paper_id: str, filename: str):
    """Serve one extracted image from the current user's paper workspace."""
    service = get_paper_library_service()
    try:
        path = service.asset_path(paper_id, filename)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper asset not found") from exc
    media_type, _ = mimetypes.guess_type(path.name)
    return FileResponse(
        path,
        media_type=media_type or "application/octet-stream",
        headers={"Cache-Control": "private, max-age=0, must-revalidate"},
    )


@router.get("/{paper_id}/source")
async def open_paper_source(paper_id: str):
    service = get_paper_library_service()
    try:
        path = service.source_path(paper_id)
        record = service.get_paper(paper_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper not found") from exc
    return FileResponse(
        path,
        media_type=mimetypes.guess_type(record.original_filename)[0]
        or "application/octet-stream",
        filename=record.original_filename,
        content_disposition_type="inline",
    )


@router.get("/{paper_id}", response_model=PaperDetail)
async def get_paper(paper_id: str) -> PaperDetail:
    service = get_paper_library_service()
    try:
        return _detail(service, service.get_paper(paper_id))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper not found") from exc


@router.patch(
    "/libraries/{library_id}/papers/{paper_id}/questions/{question_id}",
    response_model=PaperQuestion,
)
async def update_library_paper_question(
    library_id: str,
    paper_id: str,
    question_id: str,
    payload: PaperQuestionUpdate,
) -> PaperQuestion:
    service = get_paper_library_service()
    _require_library_paper(service, library_id, paper_id)
    try:
        question = service.update_question(
            paper_id,
            question_id,
            question_number=payload.question_number,
            answer=payload.answer,
            images=payload.images,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper or question not found") from exc
    except PaperValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return PaperQuestion(**question)


@router.patch("/{paper_id}/questions/{question_id}", response_model=PaperQuestion)
async def update_paper_question(
    paper_id: str,
    question_id: str,
    payload: PaperQuestionUpdate,
) -> PaperQuestion:
    try:
        question = get_paper_library_service().update_question(
            paper_id,
            question_id,
            question_number=payload.question_number,
            answer=payload.answer,
            images=payload.images,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper or question not found") from exc
    except PaperValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return PaperQuestion(**question)


@router.patch("/{paper_id}", response_model=PaperSummary)
async def rename_paper(paper_id: str, payload: PaperRenameRequest) -> PaperSummary:
    try:
        record = get_paper_library_service().rename_paper(paper_id, payload.display_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Paper not found") from exc
    except PaperValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _summary(record)


__all__ = ["get_paper_library_service", "router"]
