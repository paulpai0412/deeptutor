from __future__ import annotations

from pathlib import Path

import pytest

from deeptutor.services.paper_library import PaperLibraryService
from deeptutor.services.session.quiz_snapshot import (
    QuizSnapshotError,
    create_original_paper_snapshot,
)
from deeptutor.services.session.sqlite_store import SQLiteSessionStore
from deeptutor.services.storage.attachment_store import LocalDiskAttachmentStore

from tests.services.test_paper_library import PDF_BYTES


def _ready_paper(tmp_path: Path) -> tuple[PaperLibraryService, str]:
    service = PaperLibraryService(root=tmp_path / "papers")
    paper = service.add_pdf("history.pdf", PDF_BYTES)
    assets = tmp_path / "parser-assets"
    assets.mkdir()
    (assets / "figure.png").write_bytes(b"real-image-fixture")
    service.persist_assets(paper.paper_id, assets)
    service.save_questions(
        paper.paper_id,
        [
            {
                "question_id": "q-1",
                "question_number": "1",
                "question_text": "What changed?",
                "options": {"A": "A change"},
                "answer": "A",
                "question_type": "choice",
                "difficulty": "medium",
                "page": 2,
                "is_multi_select": False,
                "images": ["figure.png"],
                "warnings": [],
            }
        ],
        status="ready",
    )
    return service, paper.paper_id


@pytest.mark.asyncio
async def test_snapshot_copies_question_images_and_survives_paper_delete(tmp_path: Path) -> None:
    service, paper_id = _ready_paper(tmp_path)
    paper = service.get_paper(paper_id)
    store = SQLiteSessionStore(db_path=tmp_path / "session.db")
    await store.create_session(session_id="session-1")
    attachments = LocalDiskAttachmentStore(root=tmp_path / "attachments")

    snapshot = await create_original_paper_snapshot(
        store=store,
        attachment_store=attachments,
        paper_service=service,
        paper=paper,
        session_id="session-1",
        turn_id="turn-1",
        questions=service.get_questions(paper_id),
    )

    assert snapshot["snapshot_id"]
    assert snapshot["source"]["source_type"] == "original_paper"
    assert snapshot["source"]["paper_id"] == paper_id
    assert snapshot["source"]["paper_library_id"] == "legacy"
    assert snapshot["source"]["paper_library_name"] == ""
    assert snapshot["questions"][0]["question_number"] == "1"
    assert snapshot["questions"][0]["options"] == {"A": "A change"}
    assert snapshot["questions"][0]["page"] == 2
    image = snapshot["questions"][0]["images"][0]
    assert image["url"].startswith("/api/attachments/")
    assert image["source_name"] == "figure.png"
    stored_path = attachments.resolve_path(
        session_id="session-1",
        attachment_id=image["attachment_id"],
        filename=image["filename"],
    )
    assert stored_path is not None and stored_path.read_bytes() == b"real-image-fixture"

    service.delete_paper(paper_id)
    replacement = service.add_pdf("history.pdf", PDF_BYTES)
    assert replacement.paper_id != paper_id
    historical = await store.get_quiz_snapshot("session-1", "turn-1")
    assert historical is not None
    assert historical["questions"][0]["question_text"] == "What changed?"
    assert historical["questions"][0]["images"][0]["url"] == image["url"]
    assert "base64" not in str(historical)
    assert stored_path.exists()


@pytest.mark.asyncio
async def test_snapshot_failure_cleans_written_images_and_creates_no_row(tmp_path: Path) -> None:
    service = PaperLibraryService(root=tmp_path / "papers")
    paper = service.add_pdf("history.pdf", PDF_BYTES)
    store = SQLiteSessionStore(db_path=tmp_path / "session.db")
    await store.create_session(session_id="session-1")
    attachments = LocalDiskAttachmentStore(root=tmp_path / "attachments")

    with pytest.raises(QuizSnapshotError, match="Could not copy image"):
        await create_original_paper_snapshot(
            store=store,
            attachment_store=attachments,
            paper_service=service,
            paper=paper,
            session_id="session-1",
            turn_id="turn-1",
            questions=[
                {
                    "question_id": "q-1",
                    "question_number": "1",
                    "question_text": "Missing figure",
                    "options": {},
                    "answer": "",
                    "question_type": "written",
                    "images": ["missing.png"],
                }
            ],
        )

    assert await store.get_quiz_snapshot("session-1", "turn-1") is None
    assert not list((tmp_path / "attachments").rglob("*"))


@pytest.mark.asyncio
async def test_snapshot_is_atomic_when_a_later_required_image_is_missing(tmp_path: Path) -> None:
    service, paper_id = _ready_paper(tmp_path)
    paper = service.get_paper(paper_id)
    store = SQLiteSessionStore(db_path=tmp_path / "session.db")
    await store.create_session(session_id="session-1")
    attachments = LocalDiskAttachmentStore(root=tmp_path / "attachments")

    with pytest.raises(QuizSnapshotError, match="Could not copy image"):
        await create_original_paper_snapshot(
            store=store,
            attachment_store=attachments,
            paper_service=service,
            paper=paper,
            session_id="session-1",
            turn_id="turn-1",
            questions=[
                {
                    "question_id": "q-1",
                    "question_number": "1",
                    "question_text": "Two images",
                    "question_type": "written",
                    "images": ["figure.png", "missing.png"],
                }
            ],
        )

    assert await store.get_quiz_snapshot("session-1", "turn-1") is None
    assert not list((tmp_path / "attachments").rglob("*"))


@pytest.mark.asyncio
async def test_snapshot_and_question_bank_keep_library_provenance_after_library_delete(
    tmp_path: Path,
) -> None:
    service = PaperLibraryService(root=tmp_path / "papers")
    library = service.create_library("History exams")
    paper = service.add_pdf("history.pdf", PDF_BYTES, library_id=library.library_id)
    assets = tmp_path / "parser-assets"
    assets.mkdir()
    (assets / "figure.png").write_bytes(b"library-image")
    service.persist_assets(paper.paper_id, assets)
    questions = [
        {
            "question_id": "q-1",
            "question_number": "1",
            "question_text": "What changed?",
            "options": {"A": "A change"},
            "answer": "A",
            "question_type": "choice",
            "images": ["figure.png"],
        }
    ]
    service.save_questions(paper.paper_id, questions, status="ready")
    store = SQLiteSessionStore(db_path=tmp_path / "session.db")
    await store.create_session(session_id="session-1")
    attachments = LocalDiskAttachmentStore(root=tmp_path / "attachments")

    snapshot = await create_original_paper_snapshot(
        store=store,
        attachment_store=attachments,
        paper_service=service,
        paper=paper,
        session_id="session-1",
        turn_id="turn-1",
        questions=questions,
    )
    await store.upsert_notebook_entries(
        "session-1",
        [
            {
                "turn_id": "turn-1",
                "question_id": "q-1",
                "question": "What changed?",
                "source_type": "original_paper",
                "paper_library_id": library.library_id,
                "paper_library_name": library.name,
                "paper_id": paper.paper_id,
                "paper_display_name": paper.display_name,
                "source_question_number": "1",
                "source_snapshot_id": snapshot["snapshot_id"],
                "user_answer": "A",
            }
        ],
    )
    image = snapshot["questions"][0]["images"][0]
    image_url = image["url"]
    stored_path = attachments.resolve_path(
        session_id="session-1",
        attachment_id=image["attachment_id"],
        filename=image["filename"],
    )

    service.delete_library(library.library_id)

    historical = await store.get_quiz_snapshot("session-1", "turn-1")
    entry = await store.find_notebook_entry("session-1", "q-1", "turn-1")
    assert historical is not None
    assert historical["source"]["paper_library_id"] == library.library_id
    assert historical["source"]["paper_library_name"] == library.name
    assert historical["questions"][0]["images"][0]["url"] == image_url
    assert entry is not None
    assert entry["paper_library_id"] == library.library_id
    assert entry["paper_library_name"] == library.name
    assert entry["paper_id"] == paper.paper_id
    assert entry["source_snapshot_id"] == snapshot["snapshot_id"]
    assert stored_path is not None and stored_path.exists()
