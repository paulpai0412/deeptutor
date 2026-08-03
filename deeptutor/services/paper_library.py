"""File-backed Paper Library resources.

The Paper Library is deliberately separate from Knowledge Base storage and
from the SQLite-backed Question Bank records. It owns private paper resources,
validated extraction results, staged lifecycle commits, and secure source/asset
reads; later quiz features consume this boundary without sharing storage.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
from pathlib import PurePosixPath
import re
import shutil
import tempfile
import threading
from typing import Any
import uuid

from pypdf import PdfReader  # type: ignore[import-not-found]

from deeptutor.services.file_io import atomic_write_json
from deeptutor.services.path_service import get_path_service
from deeptutor.utils.document_extractor import DocumentExtractionError, extract_text_from_bytes
from deeptutor.utils.document_validator import DocumentValidator

PAPER_SCHEMA_VERSION = 1
PAPER_LIBRARY_SCHEMA_VERSION = 1
LEGACY_LIBRARY_ID = "legacy"
PAPER_STATUS_PENDING = "pending"
PAPER_STATUS_PROCESSING = "processing"
PAPER_STATUS_READY = "ready"
PAPER_STATUS_READY_WITH_WARNINGS = "ready_with_warnings"
PAPER_STATUS_PARTIAL = "partial"
PAPER_STATUS_FAILED = "failed"

_METADATA_FILENAME = "metadata.json"
_LIBRARIES_FILENAME = "libraries.json"
_QUESTIONS_FILENAME = "questions.json"
_SOURCE_FILENAME = "source.pdf"
_ASSETS_DIRNAME = "assets"
_STAGING_DIRNAME = ".staging"
_TRANSACTION_FILENAME = "transaction.json"
_ASSET_SUFFIXES = frozenset(
    {".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"}
)
_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")


class PaperLibraryError(RuntimeError):
    """Base error for Paper Library operations."""


class PaperValidationError(PaperLibraryError, ValueError):
    """Raised when an uploaded paper is not a safe, valid document."""


class PaperBusyError(PaperLibraryError):
    """Raised when an operation conflicts with active extraction."""


@dataclass(frozen=True)
class PaperLibrary:
    """A private, first-class container for paper resources."""

    library_id: str
    name: str
    description: str = ""
    settings: dict[str, Any] = field(default_factory=dict)
    folders: list[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class PaperRecord:
    """Public metadata for one Paper Library resource."""

    paper_id: str
    display_name: str
    original_filename: str
    source_hash: str
    status: str
    question_count: int
    warning_count: int
    created_at: str
    updated_at: str
    error: str = ""
    warnings: list[str] = field(default_factory=list)
    progress: dict[str, Any] = field(default_factory=dict)
    task_id: str = ""
    parser_engine: str = ""
    library_id: str = LEGACY_LIBRARY_ID
    folder_path: str = ""
    extraction_config: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class PaperLibraryService:
    """Manage private, file-backed paper resources for one workspace."""

    _active_task_ids: set[str] = set()

    def __init__(self, root: Path | None = None) -> None:
        default_root = get_path_service().get_paper_library_dir()
        self.root = (root or default_root).resolve()
        self._lock = threading.RLock()

    # ------------------------------------------------------------------
    # Paper Library containers
    # ------------------------------------------------------------------

    def create_library(
        self,
        name: str,
        *,
        description: str = "",
        settings: dict[str, Any] | None = None,
    ) -> PaperLibrary:
        """Create one user-owned Paper Library container with an empty folder registry."""
        safe_name = _safe_library_name(name)
        safe_description = _safe_description(description)
        with self._lock:
            libraries = self._read_libraries_locked()
            if any(item.name.casefold() == safe_name.casefold() for item in libraries):
                raise PaperValidationError("Paper Library name already exists.")
            now = _utc_now()
            library = PaperLibrary(
                library_id=str(uuid.uuid4()),
                name=safe_name,
                description=safe_description,
                settings=dict(settings or {}),
                created_at=now,
                updated_at=now,
            )
            self._write_libraries_locked([*libraries, library])
            return library

    def list_libraries(self) -> list[PaperLibrary]:
        """Return explicitly-created libraries; legacy papers are not a library."""
        with self._lock:
            return sorted(
                self._read_libraries_locked(),
                key=lambda item: (item.name.casefold(), item.created_at),
            )

    def get_library(self, library_id: str) -> PaperLibrary:
        """Return one library or raise ``FileNotFoundError``."""
        with self._lock:
            for library in self._read_libraries_locked():
                if library.library_id == str(library_id):
                    return library
        raise FileNotFoundError(f"Paper Library not found: {library_id}")

    def update_library(
        self,
        library_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        settings: dict[str, Any] | None = None,
    ) -> PaperLibrary:
        """Update library metadata without changing contained papers."""
        with self._lock:
            libraries = self._read_libraries_locked()
            current = next(
                (item for item in libraries if item.library_id == str(library_id)),
                None,
            )
            if current is None:
                raise FileNotFoundError(f"Paper Library not found: {library_id}")
            next_name = _safe_library_name(name) if name is not None else current.name
            if any(
                item.library_id != current.library_id
                and item.name.casefold() == next_name.casefold()
                for item in libraries
            ):
                raise PaperValidationError("Paper Library name already exists.")
            updated = replace(
                current,
                name=next_name,
                description=(
                    _safe_description(description)
                    if description is not None
                    else current.description
                ),
                settings=dict(settings) if settings is not None else current.settings,
                updated_at=_utc_now(),
            )
            self._write_libraries_locked(
                [updated if item.library_id == current.library_id else item for item in libraries]
            )
            return updated

    def delete_library(self, library_id: str) -> None:
        """Delete a library and its live papers, preserving external history."""
        with self._lock:
            libraries = self._read_libraries_locked()
            if not any(item.library_id == str(library_id) for item in libraries):
                raise FileNotFoundError(f"Paper Library not found: {library_id}")
            records = self._iter_records(library_id=str(library_id))
            if any(record.status == PAPER_STATUS_PROCESSING for record in records):
                raise PaperBusyError("A paper in this library is still processing.")
            for record in records:
                _remove_path(self._paper_dir(record.paper_id))
            self._write_libraries_locked(
                [item for item in libraries if item.library_id != str(library_id)]
            )

    def list_folders(self, library_id: str) -> list[str]:
        """Return explicit normalized folder paths, including empty folders."""
        with self._lock:
            library = self.get_library(library_id)
            return sorted(library.folders, key=lambda path: (path.casefold(), path))

    def create_folder(
        self,
        library_id: str,
        name: str,
        *,
        parent_path: str = "",
    ) -> str:
        """Create one folder below an existing parent and return its path."""
        safe_name = _normalize_folder_name(name)
        safe_parent = normalize_folder_path(parent_path)
        with self._lock:
            library = self.get_library(library_id)
            folders = list(library.folders)
            if safe_parent:
                canonical_parent = _canonical_folder_path(folders, safe_parent)
                if canonical_parent is None:
                    raise FileNotFoundError(f"Paper Folder not found: {safe_parent}")
                safe_parent = canonical_parent
            candidate = "/".join(filter(None, (safe_parent, safe_name)))
            if any(
                _same_folder_path(path, candidate)
                or (
                    _parent_folder(path) == _parent_folder(candidate)
                    and _folder_name(path).casefold() == safe_name.casefold()
                )
                for path in folders
            ):
                raise PaperValidationError("Paper Folder name already exists in this folder.")
            folders.append(candidate)
            updated = replace(library, folders=_normalized_folder_paths(folders), updated_at=_utc_now())
            self._write_libraries_locked(
                [updated if item.library_id == library.library_id else item for item in self._read_libraries_locked()]
            )
            return candidate

    def ensure_folder_path(self, library_id: str, folder_path: str) -> str:
        """Create missing folder ancestors for a validated upload path."""
        safe_path = normalize_folder_path(folder_path)
        if not safe_path:
            return ""
        with self._lock:
            library = self.get_library(library_id)
            folders = list(library.folders)
            current = ""
            changed = False
            for segment in safe_path.split("/"):
                candidate = "/".join(filter(None, (current, segment)))
                existing = _canonical_folder_path(folders, candidate)
                if existing is not None:
                    current = existing
                    continue
                folders.append(candidate)
                current = candidate
                changed = True
            if changed:
                updated = replace(
                    library,
                    folders=_normalized_folder_paths(folders),
                    updated_at=_utc_now(),
                )
                self._write_libraries_locked(
                    [
                        updated if item.library_id == library.library_id else item
                        for item in self._read_libraries_locked()
                    ]
                )
            return current

    def move_paper(
        self,
        paper_id: str,
        target_library_id: str,
        target_folder_path: str = "",
    ) -> PaperRecord:
        """Move a paper to a library folder without copying its source files."""
        safe_folder = normalize_folder_path(target_folder_path)
        with self._lock:
            target = self.get_library(target_library_id)
            if safe_folder:
                canonical_folder = _canonical_folder_path(target.folders, safe_folder)
                if canonical_folder is None:
                    raise FileNotFoundError(f"Paper Folder not found: {safe_folder}")
                safe_folder = canonical_folder
            record = self._read_record_for_id(paper_id)
            if record.status == PAPER_STATUS_PROCESSING:
                raise PaperBusyError("Paper extraction is still processing.")
            if record.library_id == target.library_id and record.folder_path == safe_folder:
                return record
            if record.library_id != target.library_id:
                duplicate = next(
                    (
                        item
                        for item in self._iter_records(library_id=target.library_id)
                        if item.source_hash == record.source_hash
                        and item.paper_id != record.paper_id
                    ),
                    None,
                )
                if duplicate is not None:
                    raise PaperLibraryError(
                        "The destination Paper Library already contains this PDF."
                    )
            updated = replace(
                record,
                library_id=target.library_id,
                folder_path=safe_folder,
                updated_at=_utc_now(),
            )
            self._write_record(updated)
            return updated

    def add_pdf(
        self,
        filename: str,
        content: bytes,
        *,
        library_id: str | None = None,
        folder_path: str = "",
        extraction_config: dict[str, Any] | None = None,
    ) -> PaperRecord:
        """Store a validated paper, deduplicated within one library."""
        safe_filename = self._validate_paper(filename, content)
        digest = hashlib.sha256(content).hexdigest()
        scope = str(library_id or LEGACY_LIBRARY_ID).strip() or LEGACY_LIBRARY_ID
        safe_folder = normalize_folder_path(folder_path)

        with self._lock:
            self._recover_staging_locked()
            self._recover_interrupted_processing_locked()
            if scope != LEGACY_LIBRARY_ID:
                if safe_folder:
                    safe_folder = self.ensure_folder_path(scope, safe_folder)
            for existing in self._iter_records(library_id=scope):
                if existing.source_hash == digest:
                    return existing

            record = PaperRecord(
                paper_id=str(uuid.uuid4()),
                display_name=safe_filename,
                original_filename=safe_filename,
                source_hash=digest,
                status=PAPER_STATUS_PENDING,
                question_count=0,
                warning_count=0,
                created_at=_utc_now(),
                updated_at=_utc_now(),
                progress={
                    "stage": "pending",
                    "message": "Waiting for extraction.",
                    "percent": 0,
                    "current": 0,
                    "total": 0,
                },
                library_id=scope,
                folder_path=safe_folder,
                extraction_config=dict(extraction_config or {}),
            )
            paper_dir = self._paper_dir(record.paper_id)
            paper_dir.mkdir(parents=True, exist_ok=False)
            try:
                _atomic_write_bytes(
                    paper_dir / f"source{Path(safe_filename).suffix.lower()}", content
                )
                atomic_write_json(paper_dir / _QUESTIONS_FILENAME, {"questions": []})
                atomic_write_json(paper_dir / _METADATA_FILENAME, record.to_dict())
            except Exception:
                shutil.rmtree(paper_dir, ignore_errors=True)
                raise
            return record

    def list_papers(
        self,
        *,
        library_id: str | None = None,
        search: str | None = None,
        status: str | None = None,
        folder_path: str | None = None,
    ) -> list[PaperRecord]:
        """List paper metadata, optionally filtered by metadata fields."""
        normalized_search = (search or "").strip().casefold()
        normalized_status = (status or "").strip()
        normalized_folder = normalize_folder_path(folder_path) if folder_path is not None else None
        with self._lock:
            self._recover_staging_locked()
            self._recover_interrupted_processing_locked()
            records = []
            if library_id is not None and str(library_id) != LEGACY_LIBRARY_ID:
                self.get_library(str(library_id))
            for record in self._iter_records(library_id=library_id):
                if normalized_status and record.status != normalized_status:
                    continue
                if normalized_folder is not None and record.folder_path != normalized_folder:
                    continue
                if normalized_search:
                    searchable = " ".join(
                        (
                            record.display_name,
                            record.original_filename,
                            record.source_hash,
                            record.status,
                            record.parser_engine,
                            record.error,
                            *record.warnings,
                        )
                    ).casefold()
                    if normalized_search not in searchable:
                        continue
                records.append(record)
        return sorted(records, key=lambda item: item.updated_at, reverse=True)

    def get_paper(self, paper_id: str) -> PaperRecord:
        """Return one paper or raise ``FileNotFoundError``."""
        with self._lock:
            self._recover_staging_locked()
            self._recover_interrupted_processing_locked()
            return self._read_record_for_id(paper_id)

    def prepare_retry(self, paper_id: str) -> PaperRecord:
        """Put a terminal paper back into ``pending`` without deleting its source.

        Existing questions/assets remain readable while the new extraction runs;
        a later commit replaces them only after the new result is validated.
        """
        with self._lock:
            self._recover_staging_locked()
            self._recover_interrupted_processing_locked()
            record = self._read_record_for_id(paper_id)
            if record.status == PAPER_STATUS_PROCESSING:
                raise PaperBusyError("Paper extraction is still processing.")
            self._active_task_ids.discard(record.task_id)
            if record.status == PAPER_STATUS_PENDING:
                return record
            if record.status not in {
                PAPER_STATUS_READY,
                PAPER_STATUS_READY_WITH_WARNINGS,
                PAPER_STATUS_PARTIAL,
                PAPER_STATUS_FAILED,
            }:
                raise PaperLibraryError(f"Paper cannot be retried from status: {record.status}")
            updated = replace(
                record,
                status=PAPER_STATUS_PENDING,
                error="",
                warnings=[],
                warning_count=0,
                task_id="",
                progress={
                    "stage": "pending",
                    "message": "Waiting for extraction retry.",
                    "percent": 0,
                    "current": 0,
                    "total": 0,
                },
                updated_at=_utc_now(),
            )
            self._write_record(updated)
            return updated

    def delete_paper(self, paper_id: str) -> None:
        """Delete a paper and all of its source, question, and asset files."""
        with self._lock:
            self._recover_staging_locked()
            self._recover_interrupted_processing_locked()
            record = self._read_record_for_id(paper_id)
            if record.status == PAPER_STATUS_PROCESSING:
                raise PaperBusyError("Paper extraction is still processing.")
            paper_dir = self._paper_dir(paper_id)
            try:
                shutil.rmtree(paper_dir)
            except OSError as exc:
                raise PaperLibraryError(f"Failed to delete paper: {paper_id}") from exc

    def rename_paper(self, paper_id: str, display_name: str) -> PaperRecord:
        """Update only a paper's user-facing display name."""
        safe_display_name = _safe_display_name(display_name)
        with self._lock:
            record = self.get_paper(paper_id)
            updated = replace(
                record,
                display_name=safe_display_name,
                updated_at=_utc_now(),
            )
            self._write_record(updated)
            return updated

    def source_path(self, paper_id: str) -> Path:
        """Return the source document path after validating paper ownership."""
        record = self.get_paper(paper_id)
        suffix = Path(record.original_filename).suffix.lower()
        path = self._paper_dir(paper_id) / f"source{suffix}"
        if not path.is_file():
            path = self._paper_dir(paper_id) / _SOURCE_FILENAME
        if not path.is_file():
            raise FileNotFoundError(f"Paper source not found: {paper_id}")
        return path

    def read_source(self, paper_id: str) -> bytes:
        """Read the source PDF for a paper in this service's workspace."""
        return self.source_path(paper_id).read_bytes()

    def asset_dir(self, paper_id: str) -> Path:
        """Return the private extracted-image directory for *paper_id*."""
        self.get_paper(paper_id)
        return self._paper_dir(paper_id) / _ASSETS_DIRNAME

    def list_assets(self, paper_id: str) -> list[str]:
        """List extracted images, including images not assigned to a question."""
        root = self.asset_dir(paper_id)
        if not root.exists():
            return []
        return sorted(
            path.relative_to(root).as_posix()
            for path in root.rglob("*")
            if path.is_file() and path.suffix.lower() in _ASSET_SUFFIXES
        )

    def persist_assets(self, paper_id: str, source_dir: Path | None) -> list[str]:
        """Copy parser image assets into the paper's private asset directory.

        The returned names are POSIX paths relative to that directory. Parser
        cache paths are never exposed to callers or persisted in question JSON.
        Only image files inside *source_dir* are copied.
        """
        with self._lock:
            self.get_paper(paper_id)
            return self._copy_assets(source_dir, self.asset_dir(paper_id))

    def stage_assets(
        self,
        paper_id: str,
        source_dir: Path | None,
        task_id: str,
    ) -> tuple[Path, list[str]]:
        """Copy parser assets into a private extraction staging directory."""
        with self._lock:
            self.get_paper(paper_id)
            stage_root = self._staging_dir(paper_id, task_id)
            if stage_root.exists():
                try:
                    shutil.rmtree(stage_root)
                except OSError as exc:
                    raise PaperLibraryError("Failed to replace extraction staging data.") from exc
            stage_root.mkdir(parents=True, exist_ok=True)
            names = self._copy_assets(source_dir, stage_root / _ASSETS_DIRNAME)
            return stage_root, names

    def cleanup_staging(self, staging_dir: Path | None) -> None:
        """Best-effort removal of one unfinished extraction transaction."""
        if staging_dir is None:
            return
        try:
            path = Path(staging_dir)
            if path.is_dir():
                shutil.rmtree(path)
        except OSError:
            pass

    def asset_path(self, paper_id: str, filename: str) -> Path:
        """Resolve one private extracted image without allowing traversal."""
        asset_root = self.asset_dir(paper_id).resolve()
        relative = str(filename or "").replace("\\", "/")
        candidate = Path(relative)
        if candidate.is_absolute() or ".." in candidate.parts:
            raise FileNotFoundError(f"Paper asset not found: {paper_id}/{filename}")
        target = (asset_root / candidate).resolve()
        try:
            target.relative_to(asset_root)
        except ValueError as exc:
            raise FileNotFoundError(f"Paper asset not found: {paper_id}/{filename}") from exc
        if not target.is_file() or target.suffix.lower() not in _ASSET_SUFFIXES:
            raise FileNotFoundError(f"Paper asset not found: {paper_id}/{filename}")
        return target

    def get_questions(self, paper_id: str) -> list[dict[str, Any]]:
        """Return the persisted structured questions for one paper."""
        self.get_paper(paper_id)
        path = self._paper_dir(paper_id) / _QUESTIONS_FILENAME
        if not path.is_file():
            return []
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise PaperLibraryError("Paper questions could not be read.") from exc
        questions = payload.get("questions", []) if isinstance(payload, dict) else []
        if not isinstance(questions, list):
            raise ValueError("paper questions must be a list")
        return [question for question in questions if isinstance(question, dict)]

    def assign_task(self, paper_id: str, task_id: str) -> PaperRecord:
        """Attach a task ID to a pending paper before background dispatch."""
        with self._lock:
            record = self.get_paper(paper_id)
            if record.status != PAPER_STATUS_PENDING or record.task_id:
                return record
            self._active_task_ids.add(task_id)
            updated = replace(
                record,
                task_id=task_id,
                progress={**record.progress, "task_id": task_id},
                updated_at=_utc_now(),
            )
            self._write_record(updated)
            return updated

    def claim_extraction(self, paper_id: str, task_id: str) -> PaperRecord | None:
        """Move a pending paper to processing exactly once."""
        with self._lock:
            record = self.get_paper(paper_id)
            if record.status != PAPER_STATUS_PENDING:
                return None
            self._active_task_ids.add(task_id)
            updated = replace(
                record,
                status=PAPER_STATUS_PROCESSING,
                task_id=task_id,
                progress={
                    "stage": "processing",
                    "message": "Extracting questions.",
                    "percent": 5,
                    "current": 0,
                    "total": 1,
                    "task_id": task_id,
                },
                updated_at=_utc_now(),
            )
            self._write_record(updated)
            return updated

    def update_progress(
        self,
        paper_id: str,
        *,
        stage: str,
        message: str,
        percent: int,
        task_id: str | None = None,
    ) -> PaperRecord:
        """Persist extraction progress without touching question data."""
        with self._lock:
            record = self.get_paper(paper_id)
            progress = {
                "stage": stage,
                "message": message,
                "percent": max(0, min(100, percent)),
                "current": 1 if percent >= 100 else 0,
                "total": 1,
                "task_id": task_id or record.task_id,
            }
            updated = replace(
                record,
                progress=progress,
                task_id=task_id or record.task_id,
                updated_at=_utc_now(),
            )
            self._write_record(updated)
            return updated

    def save_questions(
        self,
        paper_id: str,
        questions: list[dict[str, Any]],
        *,
        status: str,
        warnings: list[str] | None = None,
        error: str = "",
        parser_engine: str = "",
        task_id: str | None = None,
    ) -> PaperRecord:
        """Persist an extraction result and its public paper state."""
        if status not in {
            PAPER_STATUS_READY,
            PAPER_STATUS_READY_WITH_WARNINGS,
            PAPER_STATUS_PARTIAL,
            PAPER_STATUS_FAILED,
        }:
            raise ValueError(f"Unsupported extraction status: {status}")
        warning_list = [str(warning) for warning in (warnings or []) if str(warning).strip()]
        persisted_questions = [
            {
                **question,
                "images": _sanitize_asset_references(question.get("images", [])),
            }
            for question in questions
            if isinstance(question, dict)
        ]
        with self._lock:
            record = self.get_paper(paper_id)
            atomic_write_json(
                self._paper_dir(paper_id) / _QUESTIONS_FILENAME,
                {"schema_version": PAPER_SCHEMA_VERSION, "questions": persisted_questions},
            )
            updated = replace(
                record,
                status=status,
                question_count=len(persisted_questions),
                warning_count=len(warning_list),
                warnings=warning_list,
                error=str(error or ""),
                parser_engine=parser_engine or record.parser_engine,
                task_id=task_id or record.task_id,
                progress={
                    "stage": "failed" if status == PAPER_STATUS_FAILED else "completed",
                    "message": str(error or "Extraction completed."),
                    "percent": 100,
                    "current": 1,
                    "total": 1,
                    "task_id": task_id or record.task_id,
                },
                updated_at=_utc_now(),
            )
            self._write_record(updated)
            return updated

    def commit_extraction(
        self,
        paper_id: str,
        questions: list[dict[str, Any]],
        *,
        status: str,
        warnings: list[str] | None = None,
        parser_engine: str = "",
        task_id: str | None = None,
        staging_dir: Path,
    ) -> PaperRecord:
        """Atomically publish a validated staged extraction result."""
        if status not in {
            PAPER_STATUS_READY,
            PAPER_STATUS_READY_WITH_WARNINGS,
            PAPER_STATUS_PARTIAL,
        }:
            raise ValueError(f"Unsupported extraction status: {status}")
        persisted_questions = [
            {
                **question,
                "images": _sanitize_asset_references(question.get("images", [])),
            }
            for question in questions
            if isinstance(question, dict)
        ]
        warning_list = [str(warning) for warning in (warnings or []) if str(warning).strip()]

        with self._lock:
            record = self._read_record_for_id(paper_id)
            if record.status != PAPER_STATUS_PROCESSING:
                raise PaperBusyError("Paper extraction is no longer active.")
            if task_id and record.task_id and record.task_id != task_id:
                raise PaperBusyError("Paper extraction task is no longer current.")

            paper_dir = self._paper_dir(paper_id)
            stage_root = Path(staging_dir).resolve()
            expected_root = (paper_dir / _STAGING_DIRNAME).resolve()
            try:
                stage_root.relative_to(expected_root)
            except ValueError as exc:
                raise PaperLibraryError("Extraction staging directory is outside the paper workspace.") from exc
            if not stage_root.is_dir() or not (stage_root / _ASSETS_DIRNAME).is_dir():
                raise PaperLibraryError("Extraction staging data is incomplete.")

            staged_questions = stage_root / _QUESTIONS_FILENAME
            staged_metadata = stage_root / _METADATA_FILENAME
            atomic_write_json(
                staged_questions,
                {"schema_version": PAPER_SCHEMA_VERSION, "questions": persisted_questions},
            )
            updated = replace(
                record,
                status=status,
                question_count=len(persisted_questions),
                warning_count=len(warning_list),
                warnings=warning_list,
                error="",
                parser_engine=parser_engine or record.parser_engine,
                task_id=task_id or record.task_id,
                progress={
                    "stage": "completed",
                    "message": "Extraction completed.",
                    "percent": 100,
                    "current": 1,
                    "total": 1,
                    "task_id": task_id or record.task_id,
                },
                updated_at=_utc_now(),
            )
            atomic_write_json(staged_metadata, updated.to_dict())

            formal_paths = {
                "assets": paper_dir / _ASSETS_DIRNAME,
                "questions": paper_dir / _QUESTIONS_FILENAME,
                "metadata": paper_dir / _METADATA_FILENAME,
            }
            backup_root = stage_root / ".previous"
            backup_root.mkdir(parents=True, exist_ok=True)
            backup_paths = {
                name: backup_root / path.name for name, path in formal_paths.items()
            }
            journal = {
                "paper_id": paper_id,
                "task_id": task_id or record.task_id,
                "phase": "prepared",
                "old_exists": {name: path.exists() for name, path in formal_paths.items()},
            }
            transaction_path = stage_root / _TRANSACTION_FILENAME
            atomic_write_json(transaction_path, journal)
            moved_old: list[str] = []
            moved_new: list[str] = []
            committed = False
            try:
                _write_transaction_phase(transaction_path, journal, "moving_old")
                for name, formal_path in formal_paths.items():
                    if formal_path.exists():
                        os.replace(formal_path, backup_paths[name])
                        moved_old.append(name)
                _write_transaction_phase(transaction_path, journal, "old_moved")
                for name in ("assets", "questions"):
                    staged_path = stage_root / (name if name == "assets" else _QUESTIONS_FILENAME)
                    os.replace(staged_path, formal_paths[name])
                    moved_new.append(name)
                _write_transaction_phase(transaction_path, journal, "new_data")
                os.replace(staged_metadata, formal_paths["metadata"])
                moved_new.append("metadata")
                committed = True
                _write_transaction_phase(transaction_path, journal, "committed")
                return updated
            except Exception:
                if not committed:
                    for name in reversed(moved_new):
                        _remove_path(formal_paths[name])
                    for name in reversed(moved_old):
                        if backup_paths[name].exists():
                            os.replace(backup_paths[name], formal_paths[name])
                raise
            finally:
                self._active_task_ids.discard(task_id or record.task_id)
                self.cleanup_staging(stage_root)

    def mark_failed(
        self,
        paper_id: str,
        error: str,
        *,
        warnings: list[str] | None = None,
        task_id: str | None = None,
    ) -> PaperRecord:
        """Record a failed extraction while retaining the source PDF."""
        with self._lock:
            record = self.get_paper(paper_id)
            warning_list = [str(warning) for warning in (warnings or []) if str(warning).strip()]
            self._active_task_ids.discard(record.task_id)
            self._active_task_ids.discard(task_id or "")
            updated = replace(
                record,
                status=PAPER_STATUS_FAILED,
                error=str(error),
                warnings=warning_list,
                warning_count=len(warning_list),
                task_id=task_id or record.task_id,
                progress={
                    "stage": "failed",
                    "message": str(error),
                    "percent": 100,
                    "current": 1,
                    "total": 1,
                    "task_id": task_id or record.task_id,
                },
                updated_at=_utc_now(),
            )
            self._write_record(updated)
            return updated

    def update_question(
        self,
        paper_id: str,
        question_id: str,
        *,
        question_number: str,
        answer: str | None,
        images: list[str] | None = None,
    ) -> dict[str, Any]:
        """Save manual corrections and keep each image assigned to at most one question."""
        normalized_number = str(question_number or "").strip()
        if not normalized_number:
            raise PaperValidationError("Question number cannot be empty.")
        normalized_images: list[str] | None = None
        if images is not None:
            normalized_images = _sanitize_asset_references(images)
            for image in normalized_images:
                try:
                    self.asset_path(paper_id, image)
                except FileNotFoundError as exc:
                    raise PaperValidationError(
                        f"Question image asset was not found: {image}"
                    ) from exc
        with self._lock:
            record = self.get_paper(paper_id)
            questions = self.get_questions(paper_id)
            for index, question in enumerate(questions):
                if str(question.get("question_id", "")) != str(question_id):
                    continue
                updated_question = {
                    **question,
                    "question_number": normalized_number,
                    "answer": str(answer or ""),
                }
                if normalized_images is not None:
                    updated_question["images"] = normalized_images
                    claimed = set(normalized_images)
                    for other_index, other_question in enumerate(questions):
                        if other_index == index:
                            continue
                        current_images = _sanitize_asset_references(
                            other_question.get("images", [])
                        )
                        remaining_images = [
                            image for image in current_images if image not in claimed
                        ]
                        if remaining_images != current_images:
                            questions[other_index] = {
                                **other_question,
                                "images": remaining_images,
                            }
                questions[index] = updated_question
                atomic_write_json(
                    self._paper_dir(paper_id) / _QUESTIONS_FILENAME,
                    {"schema_version": PAPER_SCHEMA_VERSION, "questions": questions},
                )
                self._write_record(replace(record, updated_at=_utc_now()))
                return updated_question
        raise FileNotFoundError(f"Question not found: {question_id}")

    def _write_record(self, record: PaperRecord) -> None:
        atomic_write_json(self._paper_dir(record.paper_id) / _METADATA_FILENAME, record.to_dict())

    def _read_libraries_locked(self) -> list[PaperLibrary]:
        path = self.root / _LIBRARIES_FILENAME
        if not path.is_file():
            return []
        payload = _read_json_object(path)
        raw_libraries = payload.get("libraries", []) if payload else []
        if not isinstance(raw_libraries, list):
            return []
        libraries: list[PaperLibrary] = []
        for raw in raw_libraries:
            if not isinstance(raw, dict):
                continue
            library_id = str(raw.get("library_id", "")).strip()
            name = str(raw.get("name", "")).strip()
            if not library_id or not name:
                continue
            settings = raw.get("settings", {})
            raw_folders = raw.get("folders", [])
            folders = _normalized_folder_paths(
                raw_folders if isinstance(raw_folders, list) else []
            )
            libraries.append(
                PaperLibrary(
                    library_id=library_id,
                    name=name,
                    description=str(raw.get("description", "")),
                    settings=dict(settings) if isinstance(settings, dict) else {},
                    folders=folders,
                    created_at=str(raw.get("created_at", "")),
                    updated_at=str(raw.get("updated_at", "")),
                )
            )
        return libraries

    def _write_libraries_locked(self, libraries: list[PaperLibrary]) -> None:
        atomic_write_json(
            self.root / _LIBRARIES_FILENAME,
            {
                "schema_version": PAPER_LIBRARY_SCHEMA_VERSION,
                "libraries": [library.to_dict() for library in libraries],
            },
        )

    def _read_record_for_id(self, paper_id: str) -> PaperRecord:
        paper_dir = self._paper_dir(paper_id)
        metadata_path = paper_dir / _METADATA_FILENAME
        if not metadata_path.is_file():
            raise FileNotFoundError(f"Paper not found: {paper_id}")
        record = self._read_record(metadata_path)
        if record.paper_id != paper_id:
            raise FileNotFoundError(f"Paper not found: {paper_id}")
        return record

    def _recover_interrupted_processing_locked(self) -> None:
        if not self.root.is_dir():
            return
        from deeptutor.api.utils.task_id_manager import TaskIDManager

        manager = TaskIDManager.get_instance()
        for metadata_path in self.root.glob(f"*/{_METADATA_FILENAME}"):
            try:
                record = self._read_record(metadata_path)
            except (OSError, ValueError, KeyError, json.JSONDecodeError):
                continue
            if record.status not in {PAPER_STATUS_PROCESSING, PAPER_STATUS_PENDING}:
                continue
            if record.status == PAPER_STATUS_PENDING and not record.task_id:
                continue
            task_metadata = manager.get_task_metadata(record.task_id) if record.task_id else None
            if record.task_id in self._active_task_ids or (
                task_metadata and task_metadata.get("status") == "running"
            ):
                continue
            updated = replace(
                record,
                status=PAPER_STATUS_FAILED,
                error="Extraction was interrupted; retry this paper to start again.",
                warnings=["The previous extraction was interrupted and was not resumed."],
                warning_count=1,
                progress={
                    "stage": "failed",
                    "message": "Extraction was interrupted; retry this paper to start again.",
                    "percent": 100,
                    "current": 1,
                    "total": 1,
                    "task_id": record.task_id,
                },
                updated_at=_utc_now(),
            )
            self._active_task_ids.discard(record.task_id)
            atomic_write_json(metadata_path, updated.to_dict())

    def _recover_staging_locked(self) -> None:
        if not self.root.is_dir():
            return
        from deeptutor.api.utils.task_id_manager import TaskIDManager

        manager = TaskIDManager.get_instance()
        for paper_dir in self.root.iterdir():
            if not paper_dir.is_dir() or not _UUID_RE.fullmatch(paper_dir.name):
                continue
            staging_root = paper_dir / _STAGING_DIRNAME
            if not staging_root.is_dir():
                continue
            for transaction_dir in list(staging_root.iterdir()):
                if not transaction_dir.is_dir():
                    continue
                transaction_path = transaction_dir / _TRANSACTION_FILENAME
                journal = _read_json_object(transaction_path)
                task_id = str(journal.get("task_id", "")) if journal else transaction_dir.name
                task_metadata = manager.get_task_metadata(task_id) if task_id else None
                if task_id in self._active_task_ids or (
                    task_metadata and task_metadata.get("status") == "running"
                ):
                    continue
                if journal and journal.get("phase") == "committed":
                    _remove_path(transaction_dir)
                elif journal:
                    _rollback_transaction(paper_dir, transaction_dir, journal)
                else:
                    _remove_path(transaction_dir)
            try:
                if not any(staging_root.iterdir()):
                    staging_root.rmdir()
            except OSError:
                pass

    def _staging_dir(self, paper_id: str, task_id: str) -> Path:
        paper_dir = self._paper_dir(paper_id)
        safe_task_id = re.sub(r"[^A-Za-z0-9_.-]", "_", str(task_id or "task"))
        staging_root = (paper_dir / _STAGING_DIRNAME).resolve()
        candidate = (staging_root / safe_task_id).resolve()
        try:
            candidate.relative_to(staging_root)
        except ValueError as exc:
            raise PaperLibraryError("Invalid extraction staging task ID.") from exc
        return candidate

    def _copy_assets(self, source_dir: Path | None, target_root: Path) -> list[str]:
        target_root = Path(target_root).resolve()
        source_root = Path(source_dir).resolve() if source_dir is not None else None
        if source_root is not None and source_root == target_root:
            return sorted(
                path.relative_to(target_root).as_posix()
                for path in target_root.rglob("*")
                if path.is_file() and path.suffix.lower() in _ASSET_SUFFIXES
            )
        if target_root.exists():
            _remove_path(target_root)
        target_root.mkdir(parents=True, exist_ok=True)
        if source_root is None or not source_root.is_dir():
            return []

        names: list[str] = []
        for source in sorted(source_root.rglob("*")):
            if not source.is_file() or source.suffix.lower() not in _ASSET_SUFFIXES:
                continue
            resolved_source = source.resolve()
            try:
                relative = resolved_source.relative_to(source_root)
            except ValueError:
                # Do not follow a parser-cache symlink outside its asset dir.
                continue
            if relative.is_absolute() or ".." in relative.parts:
                continue
            target = (target_root / relative).resolve()
            try:
                target.relative_to(target_root)
            except ValueError:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(resolved_source, target)
            names.append(relative.as_posix())
        return names

    def _iter_records(self, *, library_id: str | None = None) -> list[PaperRecord]:
        if not self.root.is_dir():
            return []
        records: list[PaperRecord] = []
        for metadata_path in self.root.glob(f"*/{_METADATA_FILENAME}"):
            try:
                record = self._read_record(metadata_path)
                if library_id is not None and record.library_id != str(library_id):
                    continue
                records.append(record)
            except (OSError, ValueError, KeyError, json.JSONDecodeError):
                # A malformed resource should not hide every other paper from
                # the library. Later lifecycle tickets will expose corruption
                # diagnostics and repair behavior.
                continue
        return records

    @staticmethod
    def _read_record(metadata_path: Path) -> PaperRecord:
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("paper metadata must be an object")
            return PaperRecord(
                paper_id=str(payload["paper_id"]),
                display_name=str(payload["display_name"]),
                original_filename=str(payload["original_filename"]),
                source_hash=str(payload["source_hash"]),
                status=str(payload["status"]),
                question_count=int(payload.get("question_count", 0)),
                warning_count=int(payload.get("warning_count", 0)),
                created_at=str(payload["created_at"]),
                updated_at=str(payload["updated_at"]),
                error=str(payload.get("error", "")),
                warnings=[str(item) for item in payload.get("warnings", []) if str(item).strip()],
                progress=(
                    dict(payload.get("progress", {}))
                    if isinstance(payload.get("progress", {}), dict)
                    else {}
                ),
                task_id=str(payload.get("task_id", "")),
                parser_engine=str(payload.get("parser_engine", "")),
                library_id=str(payload.get("library_id", LEGACY_LIBRARY_ID)),
                folder_path=normalize_folder_path(payload.get("folder_path", "")),
                extraction_config=(
                    dict(payload.get("extraction_config", {}))
                    if isinstance(payload.get("extraction_config", {}), dict)
                    else {}
                ),
            )
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise PaperLibraryError(f"Paper metadata could not be read: {metadata_path}") from exc

    def _paper_dir(self, paper_id: str) -> Path:
        if not _UUID_RE.fullmatch(str(paper_id)):
            raise FileNotFoundError(f"Paper not found: {paper_id}")
        root = self.root.resolve()
        candidate = (root / paper_id).resolve()
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise FileNotFoundError(f"Paper not found: {paper_id}") from exc
        return candidate

    @staticmethod
    def _validate_paper(filename: str, content: bytes) -> str:
        if not isinstance(content, bytes) or not content:
            raise PaperValidationError("Paper file is empty.")
        try:
            safe_filename = DocumentValidator.validate_upload_safety(
                filename,
                len(content),
                allowed_extensions={".doc", ".pdf"},
            )
        except ValueError as exc:
            raise PaperValidationError(str(exc)) from exc

        if Path(safe_filename).suffix == ".doc":
            try:
                extract_text_from_bytes(safe_filename, content, max_chars=None)
            except DocumentExtractionError as exc:
                raise PaperValidationError("Uploaded file is not a readable Word document.") from exc
            return safe_filename

        if not content.startswith(b"%PDF-"):
            raise PaperValidationError("Uploaded file is not a valid PDF.")
        try:
            PdfReader(BytesIO(content), strict=False)
        except Exception as exc:
            raise PaperValidationError("Uploaded file is not a readable PDF.") from exc
        return safe_filename


def normalize_folder_path(value: str | None) -> str:
    """Normalize a user-supplied relative Paper Folder path."""
    raw = str(value or "").strip().replace("\\", "/")
    if not raw:
        return ""
    if raw.startswith("/") or _CONTROL_CHARS_RE.search(raw):
        raise PaperValidationError("Paper Folder path must be a safe relative path.")
    parts: list[str] = []
    for raw_part in raw.split("/"):
        part = raw_part.strip()
        if not part:
            continue
        if part in {".", ".."} or _CONTROL_CHARS_RE.search(part):
            raise PaperValidationError("Paper Folder path contains an invalid segment.")
        parts.append(part[:120])
    return "/".join(parts)


def _normalize_folder_name(value: str) -> str:
    name = str(value or "").strip()
    if (
        not name
        or name in {".", ".."}
        or "/" in name
        or "\\" in name
        or _CONTROL_CHARS_RE.search(name)
    ):
        raise PaperValidationError("Paper Folder name is invalid.")
    return name[:120]


def _same_folder_path(left: str, right: str) -> bool:
    return str(left).casefold() == str(right).casefold()


def _folder_exists(folders: list[str], path: str) -> bool:
    return any(_same_folder_path(folder, path) for folder in folders)


def _canonical_folder_path(folders: list[str], path: str) -> str | None:
    return next((folder for folder in folders if _same_folder_path(folder, path)), None)


def _parent_folder(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else ""


def _folder_name(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def _normalized_folder_paths(values: list[Any]) -> list[str]:
    result: list[str] = []
    for value in values:
        try:
            path = normalize_folder_path(str(value))
        except PaperValidationError:
            continue
        if path and not _folder_exists(result, path):
            result.append(path)
    return result


def _sanitize_asset_references(value: Any) -> list[str]:
    """Keep durable question image references relative and non-encoded."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    references: list[str] = []
    for item in value:
        reference = str(item or "").strip().replace("\\", "/")
        if not reference or reference.lower().startswith("data:"):
            continue
        path = PurePosixPath(reference)
        if path.is_absolute() or ".." in path.parts:
            continue
        normalized = reference.lstrip("./")
        if normalized and normalized not in references:
            references.append(normalized)
    return references


def _read_json_object(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _write_transaction_phase(path: Path, journal: dict[str, Any], phase: str) -> None:
    atomic_write_json(path, {**journal, "phase": phase})


def _rollback_transaction(
    paper_dir: Path,
    transaction_dir: Path,
    journal: dict[str, Any],
) -> None:
    formal_paths = {
        "assets": paper_dir / _ASSETS_DIRNAME,
        "questions": paper_dir / _QUESTIONS_FILENAME,
        "metadata": paper_dir / _METADATA_FILENAME,
    }
    backup_root = transaction_dir / ".previous"
    old_exists = journal.get("old_exists", {})
    phase = str(journal.get("phase", "prepared"))
    old_move_started = phase in {"moving_old", "old_moved", "new_data", "metadata"}
    for name, formal_path in formal_paths.items():
        backup_path = backup_root / formal_path.name
        if backup_path.exists():
            _remove_path(formal_path)
            os.replace(backup_path, formal_path)
        elif old_move_started and not bool(old_exists.get(name, False)):
            _remove_path(formal_path)
    _remove_path(transaction_dir)


def _remove_path(path: Path) -> None:
    try:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)
    except OSError:
        pass


def _safe_library_name(value: str) -> str:
    name = _CONTROL_CHARS_RE.sub("", str(value or "")).strip()
    name = name.replace("/", "_").replace("\\", "_")
    if not name or name in {".", ".."}:
        raise PaperValidationError("Paper Library name cannot be empty.")
    return name[:120]


def _safe_description(value: str) -> str:
    return _CONTROL_CHARS_RE.sub("", str(value or "")).strip()[:500]


def _safe_display_name(value: str) -> str:
    name = _CONTROL_CHARS_RE.sub("", str(value or "")).strip()
    name = name.replace("/", "_").replace("\\", "_")
    if not name or name in {".", ".."}:
        raise PaperValidationError("Display name cannot be empty.")
    return name[:200]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=str(path.parent), delete=False) as handle:
            temporary_path = Path(handle.name)
            handle.write(content)
            handle.flush()
            try:
                import os

                os.fsync(handle.fileno())
            except OSError:
                pass
        temporary_path.replace(path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


__all__ = [
    "PAPER_STATUS_FAILED",
    "PAPER_STATUS_PARTIAL",
    "PAPER_STATUS_PENDING",
    "PAPER_STATUS_PROCESSING",
    "PAPER_STATUS_READY",
    "PAPER_STATUS_READY_WITH_WARNINGS",
    "PaperBusyError",
    "PaperLibraryError",
    "PaperLibraryService",
    "PaperRecord",
    "PaperValidationError",
]
