from __future__ import annotations

from io import BytesIO
from pathlib import Path

from pypdf import PdfWriter
import pytest

from deeptutor.api.utils.task_id_manager import TaskIDManager
from deeptutor.multi_user.models import CurrentUser, UserScope
from deeptutor.multi_user.paths import user_context
from deeptutor.services.paper_library import (
    PaperBusyError,
    PaperLibraryError,
    PaperLibraryService,
    PaperValidationError,
)
from deeptutor.utils.document_validator import DocumentValidator


def _make_pdf(*, width: float = 612) -> bytes:
    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=width, height=792)
    writer.write(output)
    return output.getvalue()


PDF_BYTES = _make_pdf()


@pytest.fixture
def paper_library(tmp_path: Path) -> PaperLibraryService:
    return PaperLibraryService(root=tmp_path / "papers")


def test_upload_creates_pending_private_paper(paper_library: PaperLibraryService) -> None:
    paper = paper_library.add_pdf("practice.pdf", PDF_BYTES)

    assert paper.status == "pending"
    assert paper.display_name == "practice.pdf"
    assert paper.original_filename == "practice.pdf"
    assert paper.source_hash
    assert paper.question_count == 0
    assert paper_library.list_papers() == [paper]
    assert paper_library.read_source(paper.paper_id) == PDF_BYTES


def test_same_pdf_content_is_deduplicated(paper_library: PaperLibraryService) -> None:
    first = paper_library.add_pdf("first.pdf", PDF_BYTES)
    duplicate = paper_library.add_pdf("renamed.pdf", PDF_BYTES)

    assert duplicate.paper_id == first.paper_id
    assert duplicate.source_hash == first.source_hash
    assert len(paper_library.list_papers()) == 1


def test_same_filename_with_different_content_creates_new_paper(
    paper_library: PaperLibraryService,
) -> None:
    first = paper_library.add_pdf("practice.pdf", PDF_BYTES)
    second = paper_library.add_pdf("practice.pdf", _make_pdf(width=600))

    assert second.paper_id != first.paper_id
    assert len(paper_library.list_papers()) == 2


def test_upload_sanitizes_filename_without_accepting_a_path(
    paper_library: PaperLibraryService,
) -> None:
    paper = paper_library.add_pdf("../../exam:week-one.pdf", PDF_BYTES)

    assert paper.original_filename == "exam_week-one.pdf"
    assert paper.display_name == "exam_week-one.pdf"


def test_non_pdf_content_is_rejected(paper_library: PaperLibraryService) -> None:
    with pytest.raises(PaperValidationError, match="valid PDF"):
        paper_library.add_pdf("notes.pdf", b"plain text")


def test_unreadable_pdf_content_is_rejected(paper_library: PaperLibraryService) -> None:
    with pytest.raises(PaperValidationError, match="readable PDF"):
        paper_library.add_pdf("broken.pdf", b"%PDF-1.7\nnot a PDF")


def test_oversized_pdf_is_rejected(
    paper_library: PaperLibraryService,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(DocumentValidator, "MAX_FILE_SIZE", len(PDF_BYTES) - 1)

    with pytest.raises(PaperValidationError, match="File too large"):
        paper_library.add_pdf("large.pdf", PDF_BYTES)


def test_display_name_can_be_renamed_without_changing_identity(
    paper_library: PaperLibraryService,
) -> None:
    paper = paper_library.add_pdf("practice.pdf", PDF_BYTES)

    renamed = paper_library.rename_paper(paper.paper_id, "第一回段考")

    assert renamed.paper_id == paper.paper_id
    assert renamed.display_name == "第一回段考"
    assert renamed.original_filename == "practice.pdf"
    assert paper_library.get_paper(paper.paper_id) == renamed


def test_list_can_filter_every_lifecycle_status(paper_library: PaperLibraryService) -> None:
    ready = paper_library.add_pdf("ready.pdf", PDF_BYTES)
    failed = paper_library.add_pdf("failed.pdf", _make_pdf(width=600))
    paper_library.save_questions(ready.paper_id, [], status="ready")
    paper_library.mark_failed(failed.paper_id, "temporary")

    assert [item.paper_id for item in paper_library.list_papers(status="ready")] == [ready.paper_id]
    assert [item.paper_id for item in paper_library.list_papers(status="failed")] == [failed.paper_id]


def test_search_matches_display_name_and_original_filename(
    paper_library: PaperLibraryService,
) -> None:
    history = paper_library.add_pdf("history.pdf", PDF_BYTES)
    renamed = paper_library.add_pdf("science.pdf", _make_pdf(width=600))
    paper_library.rename_paper(renamed.paper_id, "自然科學第一次測驗")

    assert [p.paper_id for p in paper_library.list_papers(search="history")] == [history.paper_id]
    assert [p.display_name for p in paper_library.list_papers(search="自然科學")] == [
        "自然科學第一次測驗"
    ]


def test_question_image_references_cannot_persist_paths_or_base64(
    paper_library: PaperLibraryService,
) -> None:
    paper = paper_library.add_pdf("question-images.pdf", PDF_BYTES)
    paper_library.save_questions(
        paper.paper_id,
        [
            {
                "question_id": "q-1",
                "question_number": "1",
                "question_text": "See figure",
                "question_type": "written",
                "images": ["/private/cache/figure.png", "data:image/png;base64,AAAA", "figure.png"],
            }
        ],
        status="ready",
    )

    assert paper_library.get_questions(paper.paper_id)[0]["images"] == ["figure.png"]


def test_persisted_assets_are_relative_and_path_safe(paper_library: PaperLibraryService, tmp_path: Path) -> None:
    paper = paper_library.add_pdf("figure.pdf", PDF_BYTES)
    source_dir = tmp_path / "parse-cache" / "images"
    source_dir.mkdir(parents=True)
    (source_dir / "figure.png").write_bytes(b"PNG-FIXTURE")
    (source_dir / "notes.txt").write_text("not an image", encoding="utf-8")

    assert paper_library.persist_assets(paper.paper_id, source_dir) == ["figure.png"]
    assert paper_library.asset_dir(paper.paper_id).joinpath("figure.png").read_bytes() == b"PNG-FIXTURE"
    assert paper_library.asset_path(paper.paper_id, "figure.png").name == "figure.png"
    with pytest.raises(FileNotFoundError):
        paper_library.asset_path(paper.paper_id, "../source.pdf")
    with pytest.raises(FileNotFoundError):
        paper_library.asset_path(paper.paper_id, "missing.png")


def test_question_image_unlink_persists_and_cleans_orphaned_asset(
    paper_library: PaperLibraryService, tmp_path: Path
) -> None:
    paper = paper_library.add_pdf("review-images.pdf", PDF_BYTES)
    source_dir = tmp_path / "images"
    source_dir.mkdir()
    (source_dir / "keep.png").write_bytes(b"keep")
    (source_dir / "remove.png").write_bytes(b"remove")
    paper_library.persist_assets(paper.paper_id, source_dir)
    paper_library.save_questions(
        paper.paper_id,
        [
            {
                "question_id": "q-1",
                "question_number": "1",
                "question_text": "See figure",
                "question_type": "written",
                "images": ["keep.png", "remove.png"],
            }
        ],
        status="ready",
    )

    updated = paper_library.update_question(
        paper.paper_id,
        "q-1",
        question_number="1",
        answer="",
        images=["keep.png"],
    )

    assert updated["images"] == ["keep.png"]
    assert paper_library.asset_path(paper.paper_id, "keep.png").is_file()
    with pytest.raises(FileNotFoundError):
        paper_library.asset_path(paper.paper_id, "remove.png")


def test_processing_paper_cannot_be_deleted(paper_library: PaperLibraryService) -> None:
    paper = paper_library.add_pdf("busy.pdf", PDF_BYTES)
    task_id = TaskIDManager.get_instance().generate_task_id(
        "paper_extract", f"busy:{paper_library.root}:{paper.paper_id}"
    )
    assert paper_library.claim_extraction(paper.paper_id, task_id) is not None

    with pytest.raises(PaperBusyError):
        paper_library.delete_paper(paper.paper_id)
    assert paper_library.get_paper(paper.paper_id).status == "processing"


def test_orphaned_processing_paper_becomes_retryable_failed(paper_library: PaperLibraryService) -> None:
    paper = paper_library.add_pdf("orphaned.pdf", PDF_BYTES)
    assert paper_library.claim_extraction(paper.paper_id, "orphan-task") is not None
    PaperLibraryService._active_task_ids.discard("orphan-task")

    recovered = paper_library.get_paper(paper.paper_id)
    assert recovered.status == "failed"
    assert "interrupted" in recovered.error.lower()
    retry = paper_library.prepare_retry(paper.paper_id)
    assert retry.status == "pending"
    assert retry.task_id == ""


def test_delete_allows_same_pdf_to_be_uploaded_again(paper_library: PaperLibraryService) -> None:
    paper = paper_library.add_pdf("reupload.pdf", PDF_BYTES)
    paper_library.delete_paper(paper.paper_id)
    replacement = paper_library.add_pdf("reupload.pdf", PDF_BYTES)

    assert replacement.paper_id != paper.paper_id
    assert paper_library.list_papers()[0].paper_id == replacement.paper_id


def test_unknown_paper_cannot_be_read(paper_library: PaperLibraryService) -> None:
    with pytest.raises(FileNotFoundError):
        paper_library.read_source("not-a-paper")


def test_library_containers_are_persisted_and_names_are_case_insensitive(
    paper_library: PaperLibraryService,
) -> None:
    first = paper_library.create_library("  Physics  ", description="Mock exams")

    assert first.name == "Physics"
    assert paper_library.list_libraries() == [first]
    assert paper_library.get_library(first.library_id) == first
    with pytest.raises(PaperValidationError, match="already exists"):
        paper_library.create_library("physics")

    renamed = paper_library.update_library(first.library_id, name="Physics I")
    assert renamed.name == "Physics I"
    assert paper_library.get_library(first.library_id) == renamed


def test_same_pdf_is_deduplicated_per_library_but_allowed_across_libraries(
    paper_library: PaperLibraryService,
) -> None:
    first_library = paper_library.create_library("First")
    second_library = paper_library.create_library("Second")

    first = paper_library.add_pdf("paper.pdf", PDF_BYTES, library_id=first_library.library_id)
    duplicate = paper_library.add_pdf(
        "renamed.pdf", PDF_BYTES, library_id=first_library.library_id
    )
    second = paper_library.add_pdf("paper.pdf", PDF_BYTES, library_id=second_library.library_id)

    assert duplicate.paper_id == first.paper_id
    assert second.paper_id != first.paper_id
    assert [p.paper_id for p in paper_library.list_papers(library_id=first_library.library_id)] == [
        first.paper_id
    ]
    assert [p.paper_id for p in paper_library.list_papers(library_id=second_library.library_id)] == [
        second.paper_id
    ]


def test_paper_can_move_between_libraries_and_conflicts_are_rejected(
    paper_library: PaperLibraryService,
) -> None:
    first_library = paper_library.create_library("First")
    second_library = paper_library.create_library("Second")
    paper = paper_library.add_pdf("paper.pdf", PDF_BYTES, library_id=first_library.library_id)

    moved = paper_library.move_paper(paper.paper_id, second_library.library_id)
    assert moved.paper_id == paper.paper_id
    assert moved.library_id == second_library.library_id

    other = paper_library.add_pdf(
        "other.pdf", _make_pdf(width=600), library_id=first_library.library_id
    )
    paper_library.add_pdf("copy.pdf", _make_pdf(width=600), library_id=second_library.library_id)
    with pytest.raises(PaperLibraryError, match="destination.*contains"):
        paper_library.move_paper(other.paper_id, second_library.library_id)


def test_deleting_library_removes_live_papers_but_not_other_library(
    paper_library: PaperLibraryService,
) -> None:
    first_library = paper_library.create_library("First")
    second_library = paper_library.create_library("Second")
    first = paper_library.add_pdf("first.pdf", PDF_BYTES, library_id=first_library.library_id)
    second = paper_library.add_pdf(
        "second.pdf", _make_pdf(width=600), library_id=second_library.library_id
    )

    paper_library.delete_library(first_library.library_id)

    with pytest.raises(FileNotFoundError):
        paper_library.get_paper(first.paper_id)
    assert paper_library.get_paper(second.paper_id).library_id == second_library.library_id
    assert paper_library.list_libraries() == [second_library]


def test_papers_are_scoped_to_the_current_user(tmp_path: Path) -> None:
    def user(user_id: str) -> CurrentUser:
        return CurrentUser(
            id=user_id,
            username=user_id,
            role="user",
            scope=UserScope(kind="user", user_id=user_id, root=tmp_path / user_id),
        )

    with user_context(user("alice")):
        alice_service = PaperLibraryService()
        alice_paper = alice_service.add_pdf("private.pdf", PDF_BYTES)

    with user_context(user("bob")):
        bob_service = PaperLibraryService()
        assert bob_service.list_papers() == []
        with pytest.raises(FileNotFoundError):
            bob_service.read_source(alice_paper.paper_id)
        with pytest.raises(FileNotFoundError):
            bob_service.asset_path(alice_paper.paper_id, "figure.png")
