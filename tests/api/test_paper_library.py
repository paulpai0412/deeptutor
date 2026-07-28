from __future__ import annotations

import asyncio
from io import BytesIO
from pathlib import Path

from pypdf import PdfWriter
import pytest

FastAPI = pytest.importorskip("fastapi").FastAPI
TestClient = pytest.importorskip("fastapi.testclient").TestClient

from deeptutor.api.routers import paper_library
from deeptutor.services.paper_library import PaperLibraryService


def _make_pdf(*, width: float = 612) -> bytes:
    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=width, height=792)
    writer.write(output)
    return output.getvalue()


PDF_BYTES = _make_pdf()


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    service = PaperLibraryService(tmp_path / "papers")
    monkeypatch.setattr(paper_library, "get_paper_library_service", lambda: service)
    monkeypatch.setattr(paper_library, "_run_paper_extraction_task", lambda *args: None)
    app = FastAPI()
    app.include_router(paper_library.router, prefix="/api/v1/papers")
    return TestClient(app)


def test_library_scoped_upload_and_listing(client: TestClient) -> None:
    created = client.post(
        "/api/v1/papers/libraries",
        json={"name": "Physics", "description": "Midterms"},
    )
    assert created.status_code == 201
    library = created.json()
    library_id = library["library_id"]
    assert library["name"] == "Physics"
    assert library["paper_count"] == 0

    options = client.get("/api/v1/papers/libraries/options")
    assert options.status_code == 200
    assert options.json()["llm_required"] is True
    assert any(item["id"] == "text_only" for item in options.json()["parsers"])

    configured = client.patch(
        f"/api/v1/papers/libraries/{library_id}",
        json={"settings": {"parser_engine": "text_only", "failure_policy": "keep_partial"}},
    )
    assert configured.status_code == 200

    uploaded = client.post(
        f"/api/v1/papers/libraries/{library_id}/upload",
        files={"files": ("practice.pdf", BytesIO(PDF_BYTES), "application/pdf")},
    )
    assert uploaded.status_code == 200
    paper = uploaded.json()["papers"][0]
    assert paper["library_id"] == library_id
    assert paper["extraction_config"]["parser_engine"] == "text_only"
    assert paper["extraction_config"]["failure_policy"] == "keep_partial"

    listed = client.get(f"/api/v1/papers/libraries/{library_id}/papers")
    assert listed.status_code == 200
    assert [item["paper_id"] for item in listed.json()["papers"]] == [paper["paper_id"]]
    assert client.get("/api/v1/papers/libraries").json()["libraries"][0]["paper_count"] == 1

    duplicate = client.post(
        f"/api/v1/papers/libraries/{library_id}/upload",
        files={"files": ("copy.pdf", BytesIO(PDF_BYTES), "application/pdf")},
    )
    assert duplicate.status_code == 200
    assert duplicate.json()["papers"][0]["paper_id"] == paper["paper_id"]


def test_library_names_are_unique_and_papers_are_private_to_library(client: TestClient) -> None:
    first = client.post("/api/v1/papers/libraries", json={"name": "Science"}).json()
    duplicate = client.post("/api/v1/papers/libraries", json={"name": " science "})
    assert duplicate.status_code == 409

    missing = client.get("/api/v1/papers/libraries/not-a-library/papers")
    assert missing.status_code == 404


def test_upload_list_rename_and_read_source(client: TestClient) -> None:
    response = client.post(
        "/api/v1/papers/upload",
        files={"files": ("practice.pdf", BytesIO(PDF_BYTES), "application/pdf")},
    )
    assert response.status_code == 200
    paper = response.json()["papers"][0]
    paper_id = paper["paper_id"]
    assert paper["status"] == "pending"
    assert paper["task_id"]

    listed = client.get("/api/v1/papers").json()["papers"]
    assert listed[0]["paper_id"] == paper_id

    renamed = client.patch(
        f"/api/v1/papers/{paper_id}",
        json={"display_name": "第一次段考"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["display_name"] == "第一次段考"

    detail = client.get(f"/api/v1/papers/{paper_id}")
    assert detail.status_code == 200
    assert detail.json()["questions"] == []

    source = client.get(f"/api/v1/papers/{paper_id}/source")
    assert source.status_code == 200
    assert source.content == PDF_BYTES


def test_library_paper_rename_move_and_delete_api(client: TestClient) -> None:
    first = client.post("/api/v1/papers/libraries", json={"name": "First"}).json()
    second = client.post("/api/v1/papers/libraries", json={"name": "Second"}).json()
    first_id = first["library_id"]
    second_id = second["library_id"]
    uploaded = client.post(
        f"/api/v1/papers/libraries/{first_id}/upload",
        files={"files": ("paper.pdf", BytesIO(PDF_BYTES), "application/pdf")},
    ).json()["papers"][0]
    paper_id = uploaded["paper_id"]

    renamed = client.patch(
        f"/api/v1/papers/libraries/{first_id}/papers/{paper_id}",
        json={"display_name": "Renamed"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["display_name"] == "Renamed"

    moved = client.post(
        f"/api/v1/papers/libraries/{first_id}/papers/{paper_id}/move",
        json={"target_library_id": second_id},
    )
    assert moved.status_code == 200
    assert moved.json()["paper_id"] == paper_id
    assert moved.json()["library_id"] == second_id

    wrong_source = client.delete(f"/api/v1/papers/libraries/{first_id}/papers/{paper_id}")
    assert wrong_source.status_code == 404
    deleted = client.delete(f"/api/v1/papers/libraries/{second_id}/papers/{paper_id}")
    assert deleted.status_code == 200
    assert client.get(f"/api/v1/papers/{paper_id}").status_code == 404


def test_upload_reports_duplicates_and_rejects_non_pdf(client: TestClient) -> None:
    first = client.post(
        "/api/v1/papers/upload",
        files={"files": ("first.pdf", BytesIO(PDF_BYTES), "application/pdf")},
    )
    first_id = first.json()["papers"][0]["paper_id"]

    response = client.post(
        "/api/v1/papers/upload",
        files=[
            ("files", ("copy.pdf", BytesIO(PDF_BYTES), "application/pdf")),
            ("files", ("notes.txt", BytesIO(b"notes"), "text/plain")),
            (
                "files",
                ("spoof.pdf", BytesIO(b"%PDF-1.7\nnot a PDF"), "application/pdf"),
            ),
        ],
    )
    assert response.status_code == 200
    assert response.json()["papers"][0]["paper_id"] == first_id
    assert response.json()["rejected"] == [
        {"filename": "notes.txt", "error": "Unsupported file type: .txt. Allowed types: .pdf"},
        {"filename": "spoof.pdf", "error": "Uploaded file is not a readable PDF."},
    ]


def test_upload_creates_one_serial_batch_with_independent_tasks(client: TestClient) -> None:
    response = client.post(
        "/api/v1/papers/upload",
        files=[
            ("files", ("first.pdf", BytesIO(PDF_BYTES), "application/pdf")),
            ("files", ("second.pdf", BytesIO(_make_pdf(width=600)), "application/pdf")),
        ],
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["batch_id"].startswith("paper_batch_")
    assert len(payload["papers"]) == 2
    assert len({paper["task_id"] for paper in payload["papers"]}) == 2


def test_batch_continues_after_one_paper_failure(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    service = paper_library.get_paper_library_service()
    first = service.add_pdf("batch-one.pdf", PDF_BYTES)
    second = service.add_pdf("batch-two.pdf", _make_pdf(width=600))
    jobs = [(first.paper_id, "batch-task-1"), (second.paper_id, "batch-task-2")]
    seen: list[str] = []

    async def fake_task(root: str, paper_id: str, task_id: str, user) -> None:
        seen.append(paper_id)
        if paper_id == first.paper_id:
            raise RuntimeError("first paper failed")

    monkeypatch.setattr(paper_library, "_run_paper_extraction_task", fake_task)
    asyncio.run(
        paper_library._run_paper_extraction_batch(
            str(service.root), jobs, paper_library.get_current_user()
        )
    )

    assert seen == [first.paper_id, second.paper_id]
    assert service.get_paper(first.paper_id).status == "failed"
    assert service.get_paper(second.paper_id).status == "pending"


def test_retry_and_delete_api_lifecycle(client: TestClient) -> None:
    uploaded = client.post(
        "/api/v1/papers/upload",
        files={"files": ("retry.pdf", BytesIO(PDF_BYTES), "application/pdf")},
    ).json()["papers"][0]
    service = paper_library.get_paper_library_service()
    service.mark_failed(uploaded["paper_id"], "temporary")

    retried = client.post(f"/api/v1/papers/{uploaded['paper_id']}/retry")
    assert retried.status_code == 200
    assert retried.json()["status"] == "pending"
    assert retried.json()["task_id"]

    deleted = client.delete(f"/api/v1/papers/{uploaded['paper_id']}")
    assert deleted.status_code == 200
    assert client.get(f"/api/v1/papers/{uploaded['paper_id']}").status_code == 404


def test_detail_and_question_correction_api(client: TestClient) -> None:
    uploaded = client.post(
        "/api/v1/papers/upload",
        files={"files": ("review.pdf", BytesIO(PDF_BYTES), "application/pdf")},
    ).json()["papers"][0]
    service = paper_library.get_paper_library_service()
    service.save_questions(
        uploaded["paper_id"],
        [
            {
                "question_id": "q-1",
                "question_number": "1",
                "question_text": "Review me",
                "question_type": "written",
                "answer": "old",
            }
        ],
        status="ready",
        parser_engine="text_only",
    )

    detail = client.get(f"/api/v1/papers/{uploaded['paper_id']}")
    assert detail.status_code == 200
    assert detail.json()["questions"][0]["question_text"] == "Review me"

    updated = client.patch(
        f"/api/v1/papers/{uploaded['paper_id']}/questions/q-1",
        json={"question_number": "2", "answer": ""},
    )
    assert updated.status_code == 200
    assert updated.json()["question_number"] == "2"
    assert updated.json()["answer"] == ""


def test_library_question_image_unlink_api(client: TestClient, tmp_path: Path) -> None:
    library = client.post("/api/v1/papers/libraries", json={"name": "Review"}).json()
    library_id = library["library_id"]
    uploaded = client.post(
        f"/api/v1/papers/libraries/{library_id}/upload",
        files={"files": ("review.pdf", BytesIO(PDF_BYTES), "application/pdf")},
    ).json()["papers"][0]
    service = paper_library.get_paper_library_service()
    source_dir = tmp_path / "assets"
    source_dir.mkdir()
    (source_dir / "keep.png").write_bytes(b"keep")
    (source_dir / "wrong.png").write_bytes(b"wrong")
    service.persist_assets(uploaded["paper_id"], source_dir)
    service.save_questions(
        uploaded["paper_id"],
        [{
            "question_id": "q-1",
            "question_number": "1",
            "question_text": "Figure",
            "question_type": "written",
            "images": ["keep.png", "wrong.png"],
        }],
        status="ready",
    )

    updated = client.patch(
        f"/api/v1/papers/libraries/{library_id}/papers/{uploaded['paper_id']}/questions/q-1",
        json={"question_number": "1", "answer": "", "images": ["keep.png"]},
    )
    assert updated.status_code == 200
    assert updated.json()["images"] == ["keep.png"]
    assert client.get(
        f"/api/v1/papers/{uploaded['paper_id']}/assets/wrong.png"
    ).status_code == 404


def test_upload_rejects_oversized_pdf(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(paper_library.DocumentValidator, "MAX_FILE_SIZE", len(PDF_BYTES) - 1)

    response = client.post(
        "/api/v1/papers/upload",
        files={"files": ("large.pdf", BytesIO(PDF_BYTES), "application/pdf")},
    )

    assert response.status_code == 200
    assert response.json()["papers"] == []
    assert response.json()["rejected"][0]["filename"] == "large.pdf"
    assert response.json()["rejected"][0]["error"].startswith("File too large:")


def test_paper_asset_endpoint_is_scoped_and_path_safe(client: TestClient) -> None:
    uploaded = client.post(
        "/api/v1/papers/upload",
        files={"files": ("figure.pdf", BytesIO(PDF_BYTES), "application/pdf")},
    ).json()["papers"][0]
    service = paper_library.get_paper_library_service()
    source_dir = service.root / "parse-cache" / "images"
    source_dir.mkdir(parents=True)
    (source_dir / "figure.png").write_bytes(b"PNG-FIXTURE")
    service.persist_assets(uploaded["paper_id"], source_dir)

    asset = client.get(f"/api/v1/papers/{uploaded['paper_id']}/assets/figure.png")
    assert asset.status_code == 200
    assert asset.content == b"PNG-FIXTURE"
    assert asset.headers["content-type"].startswith("image/png")

    traversal = client.get(f"/api/v1/papers/{uploaded['paper_id']}/assets/../source.pdf")
    assert traversal.status_code in {404, 307}
    missing = client.get(f"/api/v1/papers/{uploaded['paper_id']}/assets/missing.png")
    assert missing.status_code == 404


def test_unknown_paper_source_returns_not_found(client: TestClient) -> None:
    response = client.get("/api/v1/papers/not-a-paper/source")

    assert response.status_code == 404
    assert response.json() == {"detail": "Paper not found"}
