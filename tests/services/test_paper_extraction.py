from __future__ import annotations

import asyncio
from io import BytesIO
import os
from pathlib import Path
from types import SimpleNamespace

from pypdf import PdfWriter
import pytest
from reportlab.pdfgen import canvas

from deeptutor.services.paper_extraction import extract_paper
from deeptutor.services.paper_library import PaperLibraryService, PaperValidationError
from deeptutor.services.parsing.types import ParsedDocument


def _pdf_bytes() -> bytes:
    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.write(output)
    return output.getvalue()


def _text_pdf_bytes() -> bytes:
    output = BytesIO()
    document = canvas.Canvas(output)
    document.drawString(72, 720, "Question 1: What is two plus two?")
    document.drawString(72, 700, "Answer: 4")
    document.save()
    return output.getvalue()


class FakeParser:
    def __init__(self, document: ParsedDocument) -> None:
        self.document = document
        self.calls: list[tuple[Path, dict]] = []

    def parse(self, source_path: Path, **kwargs) -> ParsedDocument:
        self.calls.append((source_path, kwargs))
        return self.document


def _config() -> SimpleNamespace:
    return SimpleNamespace(
        model="codex-test",
        api_key="test-key",
        base_url="https://example.test/v1",
        api_version=None,
        binding="openai",
        context_window=None,
    )


def test_extract_paper_persists_structured_questions_and_full_document(
    tmp_path: Path,
) -> None:
    service = PaperLibraryService(tmp_path / "papers")
    paper = service.add_pdf("practice.pdf", _pdf_bytes())
    markdown = "START\n" + ("document text " * 1400) + "\nEND"
    parser = FakeParser(
        ParsedDocument(
            markdown=markdown,
            blocks=[{"type": "text", "text": "Question 1", "page_idx": 1}],
            engine="text_only",
        )
    )
    calls: list[dict] = []

    async def fake_llm(**kwargs) -> str:
        calls.append(kwargs)
        return (
            '{"complete": true, "warnings": [], "questions": ['
            '{"question_number": "1", "question_text": "Choose one", '
            '"question_type": "choice", "difficulty": "hard", '
            '"options": {"A": "One", "B": "Two"}, "answer": "B", "page": 2}, '
            '{"question_number": "1", "question_text": "Explain why", '
            '"question_type": "short_answer", "difficulty": "medium", '
            '"answer": "", "page": 3}'
            "]}"
        )

    from deeptutor.services.paper_extraction import extract_paper

    record = asyncio.run(
        extract_paper(
            service,
            paper.paper_id,
            parser=parser,
            llm_call=fake_llm,
            llm_config=_config(),
        )
    )

    assert record.status == "ready_with_warnings"
    assert record.question_count == 2
    assert record.warning_count == 1
    assert record.parser_engine == "text_only"
    assert record.progress["stage"] == "completed"
    assert record.task_id
    assert len(calls) == 1
    assert calls[0]["model"] == "codex-test"
    assert calls[0]["binding"] == "openai"
    assert "START" in calls[0]["prompt"]
    assert "END" in calls[0]["prompt"]
    assert '"page_idx": 1' in calls[0]["prompt"]
    assert parser.calls[0][0] == service.source_path(paper.paper_id)

    questions = service.get_questions(paper.paper_id)
    assert len({question["question_id"] for question in questions}) == 2
    assert questions[0]["question_number"] == "1"
    assert questions[0]["options"] == {"A": "One", "B": "Two"}
    assert questions[0]["page"] == 2
    assert questions[1]["answer"] == ""
    assert questions[1]["warnings"] == ["Reference answer is unavailable"]


def test_paper_extraction_uses_snapshotted_parser_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service = PaperLibraryService(tmp_path / "papers")
    paper = service.add_pdf(
        "configured.pdf",
        _pdf_bytes(),
        extraction_config={"parser_engine": "text_only", "failure_policy": "keep_partial"},
    )
    parser = FakeParser(ParsedDocument(markdown="Question 1", engine="text_only"))
    monkeypatch.setattr("deeptutor.services.paper_extraction.get_parse_service", lambda: parser)

    async def fake_llm(**_) -> str:
        return '{"complete": true, "questions": [{"question_number": "1", "question_text": "Configured", "question_type": "written"}]}'

    record = asyncio.run(
        extract_paper(service, paper.paper_id, llm_call=fake_llm, llm_config=_config())
    )

    assert record.status == "ready_with_warnings"
    assert parser.calls[0][1]["engine"] == "text_only"
    assert service.get_paper(paper.paper_id).extraction_config["parser_engine"] == "text_only"


def test_fixed_image_pdf_fixture_persists_assets_and_non_vision_fallback(tmp_path: Path) -> None:
    pytest.importorskip("pymupdf4llm")
    fixture = Path(__file__).parents[1] / "fixtures" / "paper_library" / "image-question.pdf"
    service = PaperLibraryService(tmp_path / "papers")
    paper = service.add_pdf(fixture.name, fixture.read_bytes())
    from deeptutor.services.parsing.service import ParseService

    parse_service = ParseService(cache_root=tmp_path / "parse-cache")

    class ImagePdfParser:
        def parse(self, source_path: Path, **kwargs) -> ParsedDocument:
            return parse_service.parse(source_path, engine="pymupdf4llm", **kwargs)

    async def fake_llm(**kwargs) -> str:
        assert "Available image files:" in kwargs["prompt"]
        assert "messages" not in kwargs
        return (
            '{"complete": true, "questions": [{"question_number": "1", '
            '"question_text": "Which shape is shown in the figure?", '
            '"question_type": "choice", "page": 1, "answer": "C"}]}'
        )

    from deeptutor.services.paper_extraction import extract_paper

    record = asyncio.run(
        extract_paper(
            service,
            paper.paper_id,
            parser=ImagePdfParser(),
            llm_call=fake_llm,
            llm_config=SimpleNamespace(
                model="deepseek-chat",
                api_key="test-key",
                base_url="https://example.test/v1",
                api_version=None,
                binding="deepseek",
                context_window=None,
            ),
        )
    )

    assert record.status == "ready_with_warnings"
    image_files = list(service.asset_dir(paper.paper_id).glob("*.png"))
    assert len(image_files) == 1
    questions = service.get_questions(paper.paper_id)
    assert questions[0]["images"] == [image_files[0].name]
    assert questions[0]["page"] == 1
    assert not any("/" in image for image in questions[0]["images"])
    assert any("Vision is unavailable" in warning for warning in record.warnings)


def test_failed_reextraction_preserves_previous_questions_and_assets(tmp_path: Path) -> None:
    service = PaperLibraryService(tmp_path / "papers")
    paper = service.add_pdf("retry.pdf", _pdf_bytes())
    service.save_questions(
        paper.paper_id,
        [
            {
                "question_id": "old-q",
                "question_number": "1",
                "question_text": "Old question",
                "question_type": "written",
                "answer": "manual correction",
                "images": ["old.png"],
            }
        ],
        status="ready",
    )
    old_assets = tmp_path / "old-assets"
    old_assets.mkdir()
    (old_assets / "old.png").write_bytes(b"old-image")
    service.persist_assets(paper.paper_id, old_assets)
    service.prepare_retry(paper.paper_id)

    class Parser:
        def parse(self, source_path: Path, **kwargs) -> ParsedDocument:
            return ParsedDocument(markdown="Question 1", asset_dir=tmp_path / "new-assets", engine="fake")

    async def failing_llm(**kwargs) -> str:
        raise RuntimeError("temporary provider failure")

    record = asyncio.run(
        extract_paper(
            service,
            paper.paper_id,
            parser=Parser(),
            llm_call=failing_llm,
            llm_config=_config(),
        )
    )

    assert record.status == "failed"
    assert service.get_questions(paper.paper_id)[0]["answer"] == "manual correction"
    assert service.asset_dir(paper.paper_id).joinpath("old.png").read_bytes() == b"old-image"
    assert not (service.asset_dir(paper.paper_id).parent / ".staging").exists()


def test_successful_reextraction_atomically_replaces_old_result(tmp_path: Path) -> None:
    service = PaperLibraryService(tmp_path / "papers")
    paper = service.add_pdf("replace.pdf", _pdf_bytes())
    service.save_questions(
        paper.paper_id,
        [
            {
                "question_id": "old-q",
                "question_number": "1",
                "question_text": "Old question",
                "question_type": "written",
                "answer": "old answer",
                "images": ["old.png"],
            }
        ],
        status="ready",
    )
    old_assets = tmp_path / "old-assets"
    old_assets.mkdir()
    (old_assets / "old.png").write_bytes(b"old-image")
    service.persist_assets(paper.paper_id, old_assets)
    service.prepare_retry(paper.paper_id)
    new_assets = tmp_path / "new-assets"
    new_assets.mkdir()
    (new_assets / "new.png").write_bytes(b"new-image")

    class Parser:
        def parse(self, source_path: Path, **kwargs) -> ParsedDocument:
            return ParsedDocument(markdown="Question 2", asset_dir=new_assets, engine="fake")

    async def fake_llm(**kwargs) -> str:
        return '{"complete": true, "questions": [{"question_number": "2", "question_text": "New question", "question_type": "written", "answer": "new answer", "images": ["new.png"]}]}'

    record = asyncio.run(
        extract_paper(
            service,
            paper.paper_id,
            parser=Parser(),
            llm_call=fake_llm,
            llm_config=_config(),
        )
    )

    assert record.status == "ready"
    assert service.get_questions(paper.paper_id)[0]["question_text"] == "New question"
    assert service.get_questions(paper.paper_id)[0]["answer"] == "new answer"
    assert service.asset_dir(paper.paper_id).joinpath("new.png").read_bytes() == b"new-image"
    assert not service.asset_dir(paper.paper_id).joinpath("old.png").exists()
    assert not (service.asset_dir(paper.paper_id).parent / ".staging").exists()


def test_text_layer_fixture_uses_parse_service_and_persists_questions(tmp_path: Path) -> None:
    service = PaperLibraryService(tmp_path / "papers")
    paper = service.add_pdf("text-layer.pdf", _text_pdf_bytes())
    from deeptutor.services.parsing.service import ParseService

    parse_service = ParseService(cache_root=tmp_path / "parse-cache")

    async def fake_llm(**kwargs) -> str:
        assert "Question 1" in kwargs["prompt"]
        return '{"complete": true, "questions": [{"question_number": "1", "question_text": "What is two plus two?", "question_type": "short_answer", "answer": "4"}]}'

    class TextLayerParser:
        def parse(self, source_path: Path, **kwargs) -> ParsedDocument:
            return parse_service.parse(source_path, engine="text_only", **kwargs)

    from deeptutor.services.paper_extraction import extract_paper

    record = asyncio.run(
        extract_paper(
            service,
            paper.paper_id,
            parser=TextLayerParser(),
            llm_call=fake_llm,
            llm_config=_config(),
        )
    )

    assert record.status == "ready"
    assert service.get_questions(paper.paper_id)[0]["answer"] == "4"


@pytest.mark.skipif(
    os.environ.get("PAPER_CODEX_INTEGRATION") != "1",
    reason="Set PAPER_CODEX_INTEGRATION=1 to enable the real primary LLM test.",
)
def test_opt_in_real_primary_llm_preserves_structural_invariants(tmp_path: Path) -> None:
    service = PaperLibraryService(tmp_path / "papers")
    paper = service.add_pdf("codex-fixture.pdf", _text_pdf_bytes())
    from deeptutor.services.llm.config import get_llm_config
    from deeptutor.services.parsing.service import ParseService

    parse_service = ParseService(cache_root=tmp_path / "parse-cache")

    class TextLayerParser:
        def parse(self, source_path: Path, **kwargs) -> ParsedDocument:
            return parse_service.parse(source_path, engine="text_only", **kwargs)

    from deeptutor.services.paper_extraction import extract_paper

    record = asyncio.run(
        extract_paper(
            service,
            paper.paper_id,
            parser=TextLayerParser(),
            llm_config=get_llm_config(),
        )
    )

    assert record.status in {"ready", "ready_with_warnings", "partial"}
    questions = service.get_questions(paper.paper_id)
    assert questions
    assert all(question["question_id"] for question in questions)
    assert all(question["question_number"] for question in questions)


def test_context_overflow_fails_without_truncating_or_calling_llm(tmp_path: Path) -> None:
    service = PaperLibraryService(tmp_path / "papers")
    paper = service.add_pdf("large-text.pdf", _pdf_bytes())
    parser = FakeParser(ParsedDocument(markdown="x" * 5000, engine="text_only"))
    calls = 0

    async def fake_llm(**_) -> str:
        nonlocal calls
        calls += 1
        return "{}"

    config = _config()
    config.context_window = 1000

    from deeptutor.services.paper_extraction import extract_paper

    record = asyncio.run(
        extract_paper(
            service,
            paper.paper_id,
            parser=parser,
            llm_call=fake_llm,
            llm_config=config,
        )
    )

    assert record.status == "failed"
    assert "context window" in record.error
    assert calls == 0


def test_scan_pdf_without_text_layer_becomes_failed_and_keeps_source(tmp_path: Path) -> None:
    service = PaperLibraryService(tmp_path / "papers")
    paper = service.add_pdf("scan.pdf", _pdf_bytes())
    parser = FakeParser(ParsedDocument(markdown="", engine="text_only"))

    from deeptutor.services.paper_extraction import extract_paper

    record = asyncio.run(
        extract_paper(
            service,
            paper.paper_id,
            parser=parser,
            llm_call=lambda **_: "never called",
            llm_config=_config(),
        )
    )

    assert record.status == "failed"
    assert "text layer" in record.error.lower()
    assert service.read_source(paper.paper_id) == _pdf_bytes()
    assert service.get_questions(paper.paper_id) == []


def test_partial_extraction_keeps_valid_questions_and_reports_invalid_records(
    tmp_path: Path,
) -> None:
    service = PaperLibraryService(tmp_path / "papers")
    paper = service.add_pdf("partial.pdf", _pdf_bytes())
    parser = FakeParser(ParsedDocument(markdown="Question 1", engine="text_only"))

    async def fake_llm(**_) -> str:
        return (
            '{"complete": false, "warnings": ["LLM response ended early"], '
            '"questions": [{"question_number": "1", "question_text": "Valid", '
            '"question_type": "written", "answer": ""}, '
            '{"question_number": "", "question_text": "Missing number", '
            '"question_type": "written"}]}'
        )

    from deeptutor.services.paper_extraction import extract_paper

    record = asyncio.run(
        extract_paper(
            service,
            paper.paper_id,
            parser=parser,
            llm_call=fake_llm,
            llm_config=_config(),
        )
    )

    assert record.status == "partial"
    assert record.question_count == 1
    assert record.warning_count >= 2
    assert service.get_questions(paper.paper_id)[0]["question_text"] == "Valid"


def test_multi_select_is_preserved_for_manual_review(tmp_path: Path) -> None:
    service = PaperLibraryService(tmp_path / "papers")
    paper = service.add_pdf("multi.pdf", _pdf_bytes())
    parser = FakeParser(ParsedDocument(markdown="Question 1", engine="text_only"))

    async def fake_llm(**_) -> str:
        return '{"complete": true, "questions": [{"question_number": "1", "question_text": "Pick all", "question_type": "multi_select", "answer": "A,C"}]}'

    from deeptutor.services.paper_extraction import extract_paper

    record = asyncio.run(
        extract_paper(
            service,
            paper.paper_id,
            parser=parser,
            llm_call=fake_llm,
            llm_config=_config(),
        )
    )

    question = service.get_questions(paper.paper_id)[0]
    assert record.status == "ready_with_warnings"
    assert question["is_multi_select"] is True
    assert question["answer"] == "A,C"
    assert any("manual review" in warning for warning in question["warnings"])


def test_manual_question_update_allows_clearing_answer_but_not_number(
    tmp_path: Path,
) -> None:
    service = PaperLibraryService(tmp_path / "papers")
    paper = service.add_pdf("review.pdf", _pdf_bytes())
    service.save_questions(
        paper.paper_id,
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

    updated = service.update_question(paper.paper_id, "q-1", question_number=" 2 ", answer="")

    assert updated["question_number"] == "2"
    assert updated["answer"] == ""
    with pytest.raises(PaperValidationError, match="Question number"):
        service.update_question(paper.paper_id, "q-1", question_number=" ", answer="new")
