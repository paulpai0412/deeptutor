"""Immutable snapshots for Original Paper quiz turns.

A snapshot is created before the first question event is emitted. Question
images are copied into the session AttachmentStore; the snapshot contains the
question data and attachment references, never the source PDF or a live Paper
Library path. This keeps completed quizzes readable after paper deletion or
re-extraction.
"""

from __future__ import annotations

import hashlib
import mimetypes
from pathlib import Path
from typing import Any

from deeptutor.services.paper_library import PaperLibraryService, PaperRecord
from deeptutor.services.session.sqlite_store import SQLiteSessionStore
from deeptutor.services.storage import get_attachment_store


class QuizSnapshotError(RuntimeError):
    """Raised when an Original Paper snapshot cannot be completed atomically."""


def _attachment_id(
    *, session_id: str, turn_id: str, paper_id: str, question_id: str, index: int, name: str
) -> str:
    digest = hashlib.sha256(
        "\x00".join((session_id, turn_id, paper_id, question_id, str(index), name)).encode(
            "utf-8"
        )
    ).hexdigest()[:24]
    return f"quiz-snapshot-{digest}"


async def create_original_paper_snapshot(
    *,
    store: SQLiteSessionStore,
    attachment_store: Any,
    paper_service: PaperLibraryService,
    paper: PaperRecord,
    session_id: str,
    turn_id: str,
    questions: list[dict[str, Any]],
) -> dict[str, Any]:
    """Copy all question data/images and persist one immutable snapshot.

    The function performs all attachment writes before the SQLite insert. Any
    failure removes every attachment written by this invocation and raises,
    so callers cannot emit a partially snapshotted quiz.
    """
    if not session_id.strip() or not turn_id.strip():
        raise QuizSnapshotError("Original Paper snapshots require session and turn IDs.")

    library_id = str(getattr(paper, "library_id", "") or "")
    library_name = ""
    if library_id and library_id != "legacy":
        try:
            library_name = str(paper_service.get_library(library_id).name)
        except (AttributeError, FileNotFoundError):
            library_name = ""
    source = {
        "source_type": "original_paper",
        "paper_library_id": library_id,
        "paper_library_name": library_name,
        "paper_id": paper.paper_id,
        "paper_display_name": paper.display_name,
        "paper_original_filename": paper.original_filename,
        "paper_source_hash": paper.source_hash,
    }
    copied_attachment_ids: list[str] = []
    snapshot_questions: list[dict[str, Any]] = []
    try:
        for question_index, question in enumerate(questions):
            question_id = str(question.get("question_id") or "").strip()
            if not question_id:
                raise QuizSnapshotError(
                    f"Question {question_index + 1} has no stable question_id."
                )
            raw_images = question.get("images")
            if not isinstance(raw_images, list) or any(
                not isinstance(name, str) for name in raw_images
            ):
                raise QuizSnapshotError(
                    f"Question {question_id} has invalid image references."
                )
            raw_option_images = question.get("option_images", {})
            if not isinstance(raw_option_images, dict):
                raise QuizSnapshotError(
                    f"Question {question_id} has invalid option-image references."
                )
            option_images: dict[str, list[str]] = {}
            for raw_label, raw_names in raw_option_images.items():
                label = str(raw_label).strip()
                if not label or not isinstance(raw_names, list) or any(
                    not isinstance(name, str) or name not in raw_images for name in raw_names
                ):
                    raise QuizSnapshotError(
                        f"Question {question_id} has invalid option-image references."
                    )
                option_images[label] = list(raw_names)

            image_records: list[dict[str, str]] = []
            for image_index, image_name in enumerate(raw_images):
                image_name = image_name.strip()
                if not image_name:
                    raise QuizSnapshotError(
                        f"Question {question_id} has an empty image reference."
                    )
                try:
                    asset_path = paper_service.asset_path(paper.paper_id, image_name)
                    image_bytes = Path(asset_path).read_bytes()
                except Exception as exc:
                    raise QuizSnapshotError(
                        f"Could not copy image {image_name!r} for question {question_id}."
                    ) from exc
                filename = Path(image_name).name
                attachment_id = _attachment_id(
                    session_id=session_id,
                    turn_id=turn_id,
                    paper_id=paper.paper_id,
                    question_id=question_id,
                    index=image_index,
                    name=image_name,
                )
                try:
                    url = await attachment_store.put(
                        session_id=session_id,
                        attachment_id=attachment_id,
                        filename=filename,
                        data=image_bytes,
                        mime_type=mimetypes.guess_type(filename)[0] or "image/png",
                    )
                except Exception as exc:
                    raise QuizSnapshotError(
                        f"Could not persist image {image_name!r} for question {question_id}."
                    ) from exc
                copied_attachment_ids.append(attachment_id)
                image_records.append(
                    {
                        "attachment_id": attachment_id,
                        "url": str(url),
                        "filename": filename,
                        "mime_type": mimetypes.guess_type(filename)[0] or "image/png",
                        "source_name": image_name,
                    }
                )

            image_records_by_source = {
                record["source_name"]: record for record in image_records
            }
            option_image_records = {
                label: [image_records_by_source[name] for name in names]
                for label, names in option_images.items()
            }
            snapshot_question = {
                "question_id": question_id,
                "question_number": str(question.get("question_number") or ""),
                "question_text": str(question.get("question_text") or ""),
                "options": dict(question.get("options") or {}),
                "answer": str(question.get("answer") or ""),
                "question_type": str(question.get("question_type") or ""),
                "difficulty": question.get("difficulty"),
                "page": question.get("page"),
                "is_multi_select": bool(question.get("is_multi_select", False)),
                "source_question_type": question.get("source_question_type"),
                "source_question_id": question.get("source_question_id"),
                "warnings": list(question.get("warnings") or []),
                "images": image_records,
                "option_images": option_image_records,
            }
            snapshot_questions.append(snapshot_question)

        payload = {
            "schema_version": 1,
            "source": source,
            "questions": snapshot_questions,
        }
        snapshot = await store.create_quiz_snapshot(session_id, turn_id, payload)
        return {
            "snapshot_id": snapshot["snapshot_id"],
            "source": source,
            "questions": snapshot_questions,
        }
    except Exception:
        for attachment_id in reversed(copied_attachment_ids):
            try:
                await attachment_store.delete_attachment(session_id, attachment_id)
            except Exception:
                # Preserve the original snapshot failure; cleanup is best effort
                # because a remote/object store may be temporarily unavailable.
                pass
        raise


async def create_current_original_paper_snapshot(
    *,
    paper_service: PaperLibraryService,
    paper: PaperRecord,
    session_id: str,
    turn_id: str,
    questions: list[dict[str, Any]],
) -> dict[str, Any]:
    """Convenience wrapper using the process-wide SQLite/attachment stores."""
    from deeptutor.services.session import get_sqlite_session_store

    return await create_original_paper_snapshot(
        store=get_sqlite_session_store(),
        attachment_store=get_attachment_store(),
        paper_service=paper_service,
        paper=paper,
        session_id=session_id,
        turn_id=turn_id,
        questions=questions,
    )


__all__ = [
    "QuizSnapshotError",
    "create_current_original_paper_snapshot",
    "create_original_paper_snapshot",
]
