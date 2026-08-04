"""Docling engine adapter implementing the ``Parser`` protocol.

Docling's structured conversion is exported to Markdown for the canonical IR.
Structured ``content_list`` mapping is intentionally deferred — markdown is a
valid IR (consumers fall back to it), and a faithful block mapping depends on
the Docling document API, which is best pinned when we wire LightRAG.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from typing import Callable, Optional

from ...base import ReadinessReport
from ...signature import ParserSignature
from ...types import ParserError
from .._versions import package_version
from .config import DoclingConfig, resolve_docling_config

_SUPPORTED = frozenset(
    {".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm", ".md", ".png", ".jpg", ".jpeg"}
)

# HF cache dir-name substrings for Docling's layout/table models.
_MODEL_DIR_HINTS = ("docling", "ds4sd")


def _dir_nonempty(path: Path) -> bool:
    try:
        return path.is_dir() and any(path.iterdir())
    except Exception:
        return False


def docling_models_dir() -> Path:
    """Docling's default model cache, where ``docling-tools models download``
    writes (honors the ``DOCLING_CACHE_DIR`` override; default ~/.cache/docling).

    Resolved without importing docling (heavy) so the readiness probe stays
    cheap — it mirrors docling's own ``settings.cache_dir / "models"``."""
    cache = os.environ.get("DOCLING_CACHE_DIR")
    base = Path(cache).expanduser() if cache else Path.home() / ".cache" / "docling"
    return base / "models"


def _docling_models_ready() -> bool:
    """Best-effort, fail-closed check for downloaded Docling models."""
    artifacts = os.environ.get("DOCLING_ARTIFACTS_PATH")
    if artifacts and _dir_nonempty(Path(artifacts).expanduser()):
        return True
    # The location `docling-tools models download` populates (and that docling
    # auto-loads from at parse time).
    if _dir_nonempty(docling_models_dir()):
        return True
    hf_home = os.environ.get("HF_HOME")
    hub = (
        Path(hf_home).expanduser() if hf_home else Path.home() / ".cache" / "huggingface"
    ) / "hub"
    try:
        if hub.is_dir():
            for child in hub.iterdir():
                name = child.name.lower()
                if (
                    child.is_dir()
                    and any(h in name for h in _MODEL_DIR_HINTS)
                    and any(child.iterdir())
                ):
                    return True
    except Exception:
        return False
    return False


class DoclingParser:
    name = "docling"
    needs_local_models = True

    @classmethod
    def is_available(cls) -> bool:
        return importlib.util.find_spec("docling") is not None

    def resolve_config(self) -> DoclingConfig:
        return resolve_docling_config()

    def supported_formats(self) -> frozenset[str]:
        return _SUPPORTED

    def signature(self, config: DoclingConfig) -> ParserSignature:
        return ParserSignature.build(
            "docling",
            package_version("docling"),
            {
                "do_ocr": config.do_ocr,
                "do_table_structure": config.do_table_structure,
                "asset_export": "pictures-pages-v1",
            },
        )

    def is_ready(self, config: DoclingConfig) -> ReadinessReport:
        if not self.is_available():
            return ReadinessReport(
                ready=False,
                reason="not_configured",
                message="Docling isn't installed (pip install deeptutor[parse-docling]).",
            )
        if config.allow_local_model_download or _docling_models_ready():
            return ReadinessReport(ready=True)
        return ReadinessReport(
            ready=False,
            reason="models_missing",
            message=(
                "Docling models aren't downloaded. Enable “Allow automatic model "
                "download” in Settings → Document Parsing (or pre-fetch with "
                "`docling-tools models download`), or switch to text-only / markitdown."
            ),
        )

    def parse(
        self,
        source_path: Path,
        workdir: Path,
        *,
        config: DoclingConfig,
        on_output: Optional[Callable[[str], None]] = None,
    ) -> None:
        if on_output:
            on_output(f"Converting {Path(source_path).name} via Docling…")
        try:
            converter = self._build_converter(config)
            result = converter.convert(str(source_path))
            markdown = result.document.export_to_markdown()
            self._export_assets(result.document, Path(source_path), Path(workdir))
        except Exception as exc:  # noqa: BLE001 - surface as a parser error
            raise ParserError(f"Docling failed to convert {Path(source_path).name}: {exc}")

        stem = Path(source_path).stem
        (workdir / f"{stem}.md").write_text(str(markdown), encoding="utf-8")

    @classmethod
    def _export_assets(cls, document: object, source_path: Path, workdir: Path) -> None:
        images_dir = workdir / "images"
        picture_counts: dict[int, int] = {}

        for picture in getattr(document, "pictures", ()) or ():
            try:
                image = picture.get_image(document)
                provenance = getattr(picture, "prov", ()) or ()
                page_no = int(provenance[0].page_no) if provenance else 1
                page_index = max(page_no - 1, 0)
                image_index = picture_counts.get(page_index, 0)
                target = images_dir / f"{source_path.name}-{page_index}-{image_index}.png"
                if cls._save_image(image, target):
                    picture_counts[page_index] = image_index + 1
            except Exception:  # noqa: BLE001 - one bad figure must not drop the document
                continue

        pages = getattr(document, "pages", {}) or {}
        for page_no, page in pages.items():
            try:
                image = getattr(getattr(page, "image", None), "pil_image", None)
                target = images_dir / f"__page_context_{int(page_no):03d}.png"
                cls._save_image(image, target)
            except Exception:  # noqa: BLE001 - page renders are a best-effort fallback
                continue

        if images_dir.is_dir() and not any(images_dir.iterdir()):
            images_dir.rmdir()

    @staticmethod
    def _save_image(image: object | None, target: Path) -> bool:
        save = getattr(image, "save", None)
        if not callable(save):
            return False
        target.parent.mkdir(parents=True, exist_ok=True)
        save(target)
        return target.is_file() and target.stat().st_size > 0

    @staticmethod
    def _build_converter(config: DoclingConfig):
        """Build a converter, applying OCR/table options best-effort.

        Docling's options API varies across versions; if option wiring fails we
        fall back to the default converter rather than break the parse.
        """
        from docling.document_converter import DocumentConverter  # type: ignore[import-not-found]

        try:
            from docling.datamodel.base_models import InputFormat  # type: ignore[import-not-found]
            from docling.datamodel.pipeline_options import (  # type: ignore[import-not-found]
                PdfPipelineOptions,
            )
            from docling.document_converter import PdfFormatOption  # type: ignore[import-not-found]

            pipeline_options = PdfPipelineOptions()
            pipeline_options.do_ocr = config.do_ocr
            pipeline_options.do_table_structure = config.do_table_structure
            pipeline_options.generate_page_images = True
            pipeline_options.images_scale = 1.5
            return DocumentConverter(
                format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
            )
        except Exception:
            return DocumentConverter()


__all__ = ["DoclingParser"]
