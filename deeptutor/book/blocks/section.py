"""
Section block generator
=======================

Long-form section block (1500-2500 words) introduced in BookEngine v2.

Generation is a *two-pass* pipeline:

1. **Outline pass** — single LLM call returns a JSON ``{intro, subsections,
   key_takeaway}`` plan. ``subsections`` is a list of
   ``{heading, role, focus, target_words}`` items. The pass is grounded by
   ``ExplorationReport`` chunks (no extra RAG round-trip when chunks are
   already cached).
2. **Fill pass** — every subsection is materialised in parallel with
   ``asyncio.gather`` using ``llm_text``. Each subsection LLM call sees only
   its own slot prompt + the relevant local chunks.

The final payload combines intro + filled subsections + key takeaway, ready
for ``SectionBlock.tsx`` on the frontend (see Phase 4.d).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from deeptutor.core.i18n import parse_language

from ..models import BlockType, SourceAnchor, SourceChunk
from ._llm_writer import llm_json, llm_text
from ._prompts import book_text, get_book_prompt, load_book_prompts
from ._rag_helpers import optional_rag_lookup
from .base import BlockContext, BlockGenerator, GenerationFailure

logger = logging.getLogger(__name__)


_DEFAULT_SUBSECTION_WORDS = 320


def _clip(text: str, limit: int) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "…"


def _int_or_default(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _none_label(language: str) -> str:
    return book_text(language, en="(none)", zh="(无)", zh_tw="(無)")


# ─────────────────────────────────────────────────────────────────────────────
# Generator
# ─────────────────────────────────────────────────────────────────────────────


class SectionGenerator(BlockGenerator):
    block_type = BlockType.SECTION

    async def _generate(
        self, ctx: BlockContext
    ) -> tuple[dict[str, Any], list[SourceAnchor], dict[str, Any]]:
        params = ctx.block.params
        chapter_title = params.get("chapter_title", ctx.chapter.title)
        chapter_summary = params.get("chapter_summary", ctx.chapter.summary)
        objectives: list[str] = params.get("objectives") or ctx.chapter.learning_objectives or []
        focus_topic: str = str(params.get("focus") or chapter_title)
        section_role: str = str(params.get("role") or "core")
        target_words = _int_or_default(params.get("target_words") or 1800, 1800)

        # Pull local evidence first; fall back to a single live RAG call only
        # when the cached sweep returned nothing.
        rag = await optional_rag_lookup(
            query=f"{chapter_title}: {focus_topic}",
            ctx=ctx,
        )

        # ── Pass 1: outline ───────────────────────────────────────────
        outline = await self._make_outline(
            ctx=ctx,
            chapter_title=chapter_title,
            chapter_summary=chapter_summary,
            objectives=objectives,
            focus_topic=focus_topic,
            section_role=section_role,
            target_words=target_words,
            rag_context=rag.text,
        )
        if not outline.get("subsections"):
            raise GenerationFailure("SectionArchitect produced no subsections in outline pass.")

        # ── Pass 2: fill subsections in parallel ─────────────────────
        relevant_chunks: list[SourceChunk] = []
        try:
            relevant_chunks = ctx.relevant_chunks(focus_topic, limit=8)
        except Exception:  # noqa: BLE001
            relevant_chunks = []

        subs = outline["subsections"]
        coros = [
            self._fill_subsection(
                ctx=ctx,
                chapter_title=chapter_title,
                section_focus=focus_topic,
                outline_intro=outline.get("intro", ""),
                sub=sub,
                chunks=relevant_chunks,
            )
            for sub in subs
        ]
        bodies = await asyncio.gather(*coros, return_exceptions=False)

        filled: list[dict[str, Any]] = []
        for sub, body in zip(subs, bodies):
            filled.append(
                {
                    "heading": sub.get("heading") or "",
                    "role": sub.get("role") or "core",
                    "focus": sub.get("focus") or "",
                    "body": body or "",
                    "target_words": sub.get("target_words") or _DEFAULT_SUBSECTION_WORDS,
                }
            )

        payload = {
            "format": "section",
            "intro": outline.get("intro") or "",
            "subsections": filled,
            "key_takeaway": outline.get("key_takeaway") or "",
            "focus": focus_topic,
            "role": section_role,
        }

        anchors = list(rag.anchors)
        # Add anchors for any per-subsection chunks not yet covered.
        seen_refs = {(a.kind, a.ref) for a in anchors}
        for ch in relevant_chunks:
            key = (ch.source or "kb", str(ch.ref or ch.chunk_id or ""))
            if key in seen_refs:
                continue
            seen_refs.add(key)
            anchors.append(
                SourceAnchor(
                    kind=ch.source or "kb",
                    ref=str(ch.ref or ch.chunk_id or "")[:200],
                    snippet=_clip(ch.text or "", 300),
                )
            )

        metadata = {
            "subsection_count": len(filled),
            "outline_target_words": target_words,
            "used_rag": rag.used,
            "kb": ctx.primary_kb,
        }
        return payload, anchors[:8], metadata

    # ------------------------------------------------------------------ #
    # Pass 1
    # ------------------------------------------------------------------ #

    async def _make_outline(
        self,
        *,
        ctx: BlockContext,
        chapter_title: str,
        chapter_summary: str,
        objectives: list[str],
        focus_topic: str,
        section_role: str,
        target_words: int,
        rag_context: str,
    ) -> dict[str, Any]:
        prompts = load_book_prompts("section", ctx.language)
        none_label = _none_label(ctx.language)
        obj_block = "\n".join(f"- {o}" for o in objectives) or none_label
        rag_section = (
            f"\n[Relevant source evidence]\n{_clip(rag_context, 1800)}\n" if rag_context else ""
        )
        user_prompt = get_book_prompt(prompts, "outline_user").format(
            chapter_title=chapter_title,
            chapter_summary=chapter_summary or none_label,
            objectives_block=obj_block,
            focus_topic=focus_topic,
            section_role=section_role,
            target_words=target_words,
            rag_section=rag_section,
        )
        try:
            payload = await llm_json(
                user_prompt=user_prompt,
                system_prompt=get_book_prompt(prompts, "outline_system"),
                max_tokens=900,
                temperature=0.4,
                language=ctx.language,
                expected_key="subsections",
            )
        except Exception as exc:
            logger.warning(f"SectionGenerator outline LLM failed: {exc}")
            return _fallback_outline(focus_topic, objectives, target_words, ctx.language)

        if not isinstance(payload, dict):
            return _fallback_outline(focus_topic, objectives, target_words, ctx.language)

        subs_raw = payload.get("subsections")
        if not isinstance(subs_raw, list) or not subs_raw:
            return _fallback_outline(focus_topic, objectives, target_words, ctx.language)

        subs: list[dict[str, Any]] = []
        for item in subs_raw[:6]:
            if not isinstance(item, dict):
                continue
            heading = _clip(str(item.get("heading") or ""), 80)
            if not heading:
                continue
            role = str(item.get("role") or "core").strip().lower()
            try:
                tw = int(item.get("target_words") or _DEFAULT_SUBSECTION_WORDS)
            except (TypeError, ValueError):
                tw = _DEFAULT_SUBSECTION_WORDS
            tw = max(160, min(520, tw))
            subs.append(
                {
                    "heading": heading,
                    "role": role,
                    "focus": _clip(str(item.get("focus") or ""), 240),
                    "target_words": tw,
                }
            )
        if not subs:
            return _fallback_outline(focus_topic, objectives, target_words, ctx.language)

        return {
            "intro": _clip(str(payload.get("intro") or ""), 600),
            "subsections": subs,
            "key_takeaway": _clip(str(payload.get("key_takeaway") or ""), 400),
        }

    # ------------------------------------------------------------------ #
    # Pass 2
    # ------------------------------------------------------------------ #

    async def _fill_subsection(
        self,
        *,
        ctx: BlockContext,
        chapter_title: str,
        section_focus: str,
        outline_intro: str,
        sub: dict[str, Any],
        chunks: list[SourceChunk],
    ) -> str:
        heading = sub.get("heading") or ""
        role = sub.get("role") or "core"
        focus = sub.get("focus") or ""
        target_words = _int_or_default(
            sub.get("target_words") or _DEFAULT_SUBSECTION_WORDS,
            _DEFAULT_SUBSECTION_WORDS,
        )

        # Pick chunks whose query / text overlaps the heading or focus.
        haystack = f"{heading} {focus}".lower()
        slice_chunks: list[SourceChunk] = []
        for ch in chunks:
            text = (ch.text or "").lower()
            tokens_match = sum(1 for tok in haystack.split() if len(tok) > 3 and tok in text)
            if tokens_match:
                slice_chunks.append(ch)
            if len(slice_chunks) >= 3:
                break
        if not slice_chunks:
            slice_chunks = chunks[:2]

        evidence_block = ""
        if slice_chunks:
            evidence_block = "\n".join(f"- {_clip(c.text or '', 320)}" for c in slice_chunks)

        prompts = load_book_prompts("section", ctx.language)
        none_label = _none_label(ctx.language)
        same_as_heading = book_text(
            ctx.language,
            en="(same as heading)",
            zh="(同标题)",
            zh_tw="(同標題)",
        )
        evidence_label = book_text(
            ctx.language,
            en="Reference evidence",
            zh="参考资料",
            zh_tw="參考資料",
        )
        evidence_section = f"\n{evidence_label}:\n{evidence_block}\n" if evidence_block else ""
        user_prompt = get_book_prompt(prompts, "subsection_user").format(
            chapter_title=chapter_title,
            section_focus=section_focus,
            outline_intro=outline_intro or none_label,
            heading=heading,
            role=role,
            focus=focus or same_as_heading,
            target_words=target_words,
            evidence_section=evidence_section,
        )
        try:
            body = await llm_text(
                user_prompt=user_prompt,
                system_prompt=get_book_prompt(prompts, "subsection_system"),
                max_tokens=1200,
                temperature=0.5,
                language=ctx.language,
            )
        except Exception as exc:
            logger.warning(f"SectionGenerator subsection LLM failed: {exc}")
            return f"### {heading}\n\n_(generation failed: {exc})_"
        body = body.strip()
        if not body.startswith("###"):
            body = f"### {heading}\n\n{body}"
        return body


# ─────────────────────────────────────────────────────────────────────────────
# Fallback outline when the LLM call fails
# ─────────────────────────────────────────────────────────────────────────────


def _fallback_outline(
    focus_topic: str,
    objectives: list[str],
    target_words: int,
    language: str,
) -> dict[str, Any]:
    if parse_language(language).startswith("zh"):
        traditional = parse_language(language) == "zh-TW"
        roles = (
            [
                ("核心定義", "core"),
                ("典型範例", "example"),
                ("應用／比較", "application"),
            ]
            if traditional
            else [
                ("核心定义", "core"),
                ("典型例子", "example"),
                ("应用 / 比较", "application"),
            ]
        )
        intro = f"本節圍繞「{focus_topic}」展開。" if traditional else f"本节围绕“{focus_topic}”展开。"
        takeaway = (
            "記住核心定義，並能在範例中辨識其應用。"
            if traditional
            else "记住核心定义，并能在例子中识别其应用。"
        )
    else:
        roles = [
            ("Core idea", "core"),
            ("Worked example", "example"),
            ("Applications & contrasts", "application"),
        ]
        intro = f"This section unpacks **{focus_topic}** in three steps."
        takeaway = "Hold on to the definition, then recognise it in real cases."

    per = max(220, target_words // len(roles))
    subs = [
        {
            "heading": h,
            "role": r,
            "focus": (objectives[i] if i < len(objectives) else focus_topic),
            "target_words": per,
        }
        for i, (h, r) in enumerate(roles)
    ]
    return {
        "intro": intro,
        "subsections": subs,
        "key_takeaway": takeaway,
    }


__all__ = ["SectionGenerator"]
