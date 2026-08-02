"""Deep Question Capability.

Routes one user turn through the right quiz-generation path:

* followup — single-call ``FollowupAgent`` reply about one prior question.
* custom mode — new ``QuestionPipeline`` (explore → plan → per-question loop).
* mimic mode  — same pipeline, but PDF parsing produces the templates
  and ``templates_override`` skips explore + plan.
"""

from __future__ import annotations

from dataclasses import replace
import asyncio
import base64
import tempfile
from typing import Any

from deeptutor.agents._shared.capability_result import emit_capability_result
from deeptutor.core.agentic.usage import UsageTracker
from deeptutor.core.capability_protocol import BaseCapability, CapabilityManifest
from deeptutor.core.context import UnifiedContext
from deeptutor.core.stream_bus import StreamBus
from deeptutor.core.trace import merge_trace_metadata
from deeptutor.i18n import StatusI18n
from deeptutor.runtime.request_contracts import get_capability_request_schema


_ORIGINAL_PAPER_STATUSES = frozenset({"ready", "ready_with_warnings", "partial"})
_ORIGINAL_QUESTION_TYPES = frozenset(
    {"choice", "concept", "fill_in_blank", "short_answer", "written", "coding"}
)


class DeepQuestionCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="deep_question",
        description="Fast question generation (Template batches -> Generate).",
        stages=["ideation", "generation"],
        tools_used=["rag", "web_search", "code_execution"],
        cli_aliases=["quiz"],
        request_schema=get_capability_request_schema("deep_question"),
    )

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        from deeptutor.services.llm.config import get_llm_config
        from deeptutor.services.path_service import get_path_service

        llm_config = get_llm_config()
        kb_name = context.knowledge_bases[0] if context.knowledge_bases else None
        turn_id = str(context.metadata.get("turn_id", "") or context.session_id or "deep-question")
        output_dir = get_path_service().get_task_workspace("deep_question", turn_id)
        i18n = StatusI18n(self.name, context.language, module="question")

        overrides = context.config_overrides
        followup_question_context = context.metadata.get("question_followup_context", {}) or {}
        if isinstance(followup_question_context, dict) and followup_question_context.get(
            "question"
        ):
            from deeptutor.agents.question.agents.followup_agent import FollowupAgent

            usage = UsageTracker(model=getattr(llm_config, "model", None))
            agent = FollowupAgent(
                language=context.language,
                api_key=llm_config.api_key,
                base_url=llm_config.base_url,
                api_version=llm_config.api_version,
                token_tracker=usage,
            )
            agent.set_trace_callback(self._build_trace_bridge(stream, i18n=i18n))
            async with stream.stage("generation", source=self.name):
                answer = await agent.process(
                    user_message=context.user_message,
                    question_context=followup_question_context,
                    history_context=str(
                        context.metadata.get("conversation_context_text", "") or ""
                    ).strip(),
                    attachments=context.attachments,
                )
                if answer:
                    await stream.content(answer, source=self.name, stage="generation")
                followup_payload: dict[str, Any] = {
                    "response": answer or "",
                    "mode": "followup",
                    "question_id": followup_question_context.get("question_id", ""),
                }
                await emit_capability_result(
                    stream, followup_payload, source=self.name, usage=usage
                )
            return

        mode = str(overrides.get("mode", "custom") or "custom").strip().lower()
        if mode == "proctor":
            await self._run_proctor_mode(
                context=context,
                stream=stream,
                i18n=i18n,
            )
            return

        if mode == "original_paper":
            await self._run_original_paper_mode(
                context=context,
                stream=stream,
                overrides=overrides,
            )
            return

        topic = str(overrides.get("topic") or context.user_message or "").strip()
        num_questions = int(overrides.get("num_questions", 1) or 1)
        difficulty = str(overrides.get("difficulty", "") or "")
        raw_types = overrides.get("question_types") or []
        question_types = list(raw_types) if isinstance(raw_types, list) else []
        raw_counts = overrides.get("per_type_counts") or {}
        per_type_counts = (
            {str(k): int(v) for k, v in raw_counts.items() if isinstance(v, int) and v > 0}
            if isinstance(raw_counts, dict)
            else {}
        )
        history_context = str(context.metadata.get("conversation_context_text", "") or "").strip()

        if mode != "mimic":
            # New custom-mode pipeline: explore → plan → per-question quiz loop.
            # The pipeline owns its own stream.content / stream.result emission;
            # nothing here to render afterwards.
            from deeptutor.agents.question.history import load_session_quiz_history
            from deeptutor.agents.question.pipeline import QuestionPipeline
            from deeptutor.agents.question.request_config import (
                build_question_runtime_config,
            )
            from deeptutor.services.config import load_config_with_main

            if not topic:
                await stream.error(
                    i18n.t(
                        "topic_required",
                        "Topic is required for custom question generation.",
                    ),
                    source=self.name,
                )
                return

            quiz_history = await load_session_quiz_history(context.session_id or "")
            runtime_config = build_question_runtime_config(
                base_config=load_config_with_main("main.yaml"),
            )
            pipeline = QuestionPipeline(
                language=context.language,
                kb_name=kb_name,
                enabled_tools=list(context.enabled_tools or []),
                runtime_config=runtime_config,
            )
            await pipeline.run(
                context=context,
                user_message=topic,
                num_questions=num_questions,
                difficulty=difficulty,
                question_types=question_types,
                per_type_counts=per_type_counts,
                conversation_context=history_context,
                attachments=context.attachments,
                quiz_history=quiz_history,
                stream=stream,
            )
            return

        # Mimic mode — also runs through QuestionPipeline, but parses the
        # exam paper into templates first and passes them via
        # ``templates_override`` so explore + plan are skipped.
        await self._run_mimic_mode(
            context=context,
            stream=stream,
            kb_name=kb_name,
            output_dir=output_dir,
            overrides=overrides,
            history_context=history_context,
            num_questions=num_questions,
            i18n=i18n,
        )

    async def _run_proctor_mode(
        self,
        *,
        context: UnifiedContext,
        stream: StreamBus,
        i18n: StatusI18n,
    ) -> None:
        """Interactive exam turn: judge the utterance against the derived
        current question and reply. Progress is never stored as a counter —
        it derives from the session's latest snapshot plus the judgment
        events this path records."""
        from deeptutor.agents.question.agents.proctor_agent import ProctorAgent
        from deeptutor.agents.question.exam_progress import (
            derive_exam_state,
            resolve_latest_question_set,
        )
        from deeptutor.services.session import get_sqlite_session_store

        session_id = str(context.session_id or "").strip()
        store = get_sqlite_session_store() if session_id else None
        question_set = await resolve_latest_question_set(store, session_id) if store else None
        if question_set is None:
            await stream.error(
                "No exam or quiz is in progress for this session. Start one first.",
                source=self.name,
                stage="quizzing",
            )
            return

        judgments = await store.list_exam_judgments(session_id)
        state = derive_exam_state(
            question_set.questions,
            judgments,
            question_set_id=question_set.set_id,
        )

        from deeptutor.services.llm.config import get_llm_config

        llm_config = get_llm_config()
        usage = UsageTracker(model=getattr(llm_config, "model", None))
        source_metadata = {
            "source_type": question_set.source,
            "question_set_id": question_set.set_id,
            "paper_id": question_set.paper_id,
            "paper_display_name": question_set.paper_display_name,
        }

        async with stream.stage("quizzing", source=self.name, metadata=source_metadata):
            if state.complete:
                content = (
                    f"考試完成，{state.total} 題全部作答完畢。"
                    if str(context.language or "").startswith("zh")
                    else f"Exam complete — all {state.total} questions handled."
                )
                await stream.content(
                    content,
                    source=self.name,
                    stage="quizzing",
                    metadata={
                        "call_kind": "exam_proctor_reply",
                        "exam_complete": True,
                        "total_questions": state.total,
                        **source_metadata,
                    },
                )
                await emit_capability_result(
                    stream,
                    {
                        "response": content,
                        "mode": "proctor",
                        "exam_complete": True,
                        **source_metadata,
                    },
                    source=self.name,
                    usage=usage,
                )
                return

            assert state.current_question is not None and state.current_index is not None
            agent = ProctorAgent(
                language=context.language,
                api_key=llm_config.api_key,
                base_url=llm_config.base_url,
                api_version=llm_config.api_version,
                token_tracker=usage,
            )
            agent.set_trace_callback(self._build_trace_bridge(stream, i18n=i18n))
            verdict, reply = await agent.process(
                user_message=context.user_message,
                current_question=state.current_question,
                next_question=state.next_question,
                progress_context=(
                    f"Question {state.current_index + 1} of {state.total}; "
                    f"{state.answered} already handled."
                ),
                history_context=str(
                    context.metadata.get("conversation_context_text", "") or ""
                ).strip(),
            )
            question_id = str(state.current_question.get("question_id") or "")
            if verdict in {"correct", "wrong", "skip"}:
                await stream.progress(
                    "",
                    source=self.name,
                    stage="quizzing",
                    metadata={
                        "call_kind": "exam_judgment",
                        "question_id": question_id,
                        "verdict": verdict,
                        "utterance": str(context.user_message or "")[:200],
                        **source_metadata,
                    },
                )
            await stream.content(
                reply,
                source=self.name,
                stage="quizzing",
                metadata={
                    "call_kind": "exam_proctor_reply",
                    "question_id": question_id,
                    "verdict": verdict,
                    "question_index": state.current_index,
                    "total_questions": state.total,
                    **source_metadata,
                },
            )
            await emit_capability_result(
                stream,
                {
                    "response": reply,
                    "mode": "proctor",
                    "verdict": verdict,
                    "question_id": question_id,
                    "question_index": state.current_index,
                    "total_questions": state.total,
                    "exam_complete": False,
                    **source_metadata,
                },
                source=self.name,
                usage=usage,
            )

    async def _run_original_paper_mode(
        self,
        *,
        context: UnifiedContext,
        stream: StreamBus,
        overrides: dict[str, Any],
    ) -> None:
        """Render a user's extracted paper as a quiz without an LLM call.

        Original Paper is intentionally a separate path from both custom and
        mimic mode: the paper ID is resolved through the current user's
        PaperLibraryService, and the persisted question list is copied into
        the StreamBus envelope in its stored order. No file path, KB lookup,
        prompt, or generation pipeline is involved.
        """
        from deeptutor.services.paper_library import PaperLibraryService

        paper_id = str(overrides.get("paper_id") or "").strip()
        if not paper_id:
            await stream.error(
                "Original Paper mode requires a paper_id.",
                source=self.name,
                stage="quizzing",
            )
            return

        service = PaperLibraryService()
        try:
            paper = service.get_paper(paper_id)
            questions = service.get_questions(paper_id)
        except FileNotFoundError:
            await stream.error(
                "The selected paper was not found in your Paper Library.",
                source=self.name,
                stage="quizzing",
            )
            return
        except Exception as exc:
            await stream.error(
                f"Unable to load the selected paper: {exc}",
                source=self.name,
                stage="quizzing",
            )
            return

        if paper.status not in _ORIGINAL_PAPER_STATUSES:
            await stream.error(
                "Original Paper requires a ready, partially ready, or ready-with-warnings paper.",
                source=self.name,
                stage="quizzing",
                metadata={"paper_id": paper.paper_id, "paper_status": paper.status},
            )
            return

        library_name = ""
        library_id = str(getattr(paper, "library_id", "") or "")
        if library_id and library_id != "legacy":
            try:
                library_name = str(service.get_library(library_id).name)
            except (AttributeError, FileNotFoundError):
                library_name = ""
        source_metadata = {
            "source_type": "original_paper",
            "paper_library_id": library_id,
            "paper_library_name": library_name,
            "paper_id": paper.paper_id,
            "paper_display_name": paper.display_name,
            "paper_original_filename": paper.original_filename,
            "paper_source_hash": paper.source_hash,
        }
        pairs: list[dict[str, Any]] = []
        invalid_questions: list[str] = []
        for index, raw_question in enumerate(questions):
            ordinal = index + 1
            if not isinstance(raw_question, dict):
                invalid_questions.append(f"#{ordinal}: record is not an object")
                continue

            question_id = raw_question.get("question_id")
            question_number = raw_question.get("question_number")
            question_text = raw_question.get("question_text")
            raw_type = raw_question.get("question_type")
            answer = raw_question.get("answer", "")
            options = raw_question.get("options")
            images = raw_question.get("images")
            missing = [
                name
                for name, value in (
                    ("question_id", question_id),
                    ("question_number", question_number),
                    ("question_text", question_text),
                    ("question_type", raw_type),
                )
                if not isinstance(value, str) or not value.strip()
            ]
            if missing:
                invalid_questions.append(f"#{ordinal}: missing {', '.join(missing)}")
                continue
            if str(raw_type).strip().lower() not in _ORIGINAL_QUESTION_TYPES:
                invalid_questions.append(
                    f"#{ordinal}: unsupported stored question_type {raw_type!r}"
                )
                continue
            if not isinstance(options, dict) or any(
                not isinstance(key, str) or not isinstance(value, str)
                for key, value in options.items()
            ):
                invalid_questions.append(f"#{ordinal}: options are not a string map")
                continue
            if not isinstance(images, list) or any(not isinstance(image, str) for image in images):
                invalid_questions.append(f"#{ordinal}: images are not a string list")
                continue
            if not isinstance(answer, str):
                invalid_questions.append(f"#{ordinal}: answer is not text")
                continue
            difficulty = raw_question.get("difficulty")
            if difficulty is not None and not isinstance(difficulty, str):
                invalid_questions.append(f"#{ordinal}: difficulty is not text")
                continue

            question_number = question_number.strip()
            question_id = question_id.strip()
            question_text = question_text.strip()
            question_type = raw_type.strip().lower()
            images = list(images)
            question_source = {
                **source_metadata,
                "question_number": question_number,
                "page": raw_question.get("page"),
                "images": images,
                "source_question_id": raw_question.get("source_question_id"),
            }
            pairs.append(
                {
                    "question_id": question_id,
                    "question": question_text,
                    "question_type": question_type,
                    "options": dict(options) or None,
                    "correct_answer": answer.strip(),
                    "explanation": "",
                    "difficulty": (difficulty or "").strip(),
                    "concentration": "",
                    "source_type": "original_paper",
                    "paper_library_id": library_id,
                    "paper_library_name": library_name,
                    "paper_id": paper.paper_id,
                    "paper_display_name": paper.display_name,
                    "source_question_number": question_number,
                    "source_page": raw_question.get("page"),
                    "source_images": images,
                    "source": question_source,
                }
            )

        if invalid_questions:
            await stream.error(
                "The selected paper contains invalid extracted question records; "
                "the Original Paper quiz was not started.",
                source=self.name,
                stage="quizzing",
                metadata={**source_metadata, "invalid_questions": invalid_questions},
            )
            return

        if not pairs:
            await stream.error(
                "The selected paper has no successfully extracted questions.",
                source=self.name,
                stage="quizzing",
                metadata=source_metadata,
            )
            return

        from deeptutor.services.session.quiz_snapshot import (
            QuizSnapshotError,
            create_current_original_paper_snapshot,
        )

        try:
            snapshot = await create_current_original_paper_snapshot(
                paper_service=service,
                paper=paper,
                session_id=context.session_id,
                turn_id=str(context.metadata.get("turn_id", "") or ""),
                questions=questions,
            )
        except QuizSnapshotError as exc:
            await stream.error(
                f"Original Paper snapshot failed; the quiz was not started: {exc}",
                source=self.name,
                stage="quizzing",
                metadata=source_metadata,
            )
            return
        except Exception as exc:
            await stream.error(
                f"Original Paper snapshot failed; the quiz was not started: {exc}",
                source=self.name,
                stage="quizzing",
                metadata=source_metadata,
            )
            return

        snapshot_questions = snapshot["questions"]
        for pair, snapshot_question in zip(pairs, snapshot_questions, strict=True):
            image_records = snapshot_question["images"]
            pair["snapshot_id"] = snapshot["snapshot_id"]
            pair["is_multi_select"] = snapshot_question["is_multi_select"]
            pair["source_images"] = [record["url"] for record in image_records]
            pair["source_image_attachments"] = image_records
            pair["source"]["images"] = image_records
            pair["source"]["snapshot_id"] = snapshot["snapshot_id"]

        source_metadata = {
            **source_metadata,
            "snapshot_id": snapshot["snapshot_id"],
        }
        async with stream.stage("quizzing", source=self.name, metadata=source_metadata):
            for index, pair in enumerate(pairs):
                await stream.content(
                    "",
                    source=self.name,
                    stage="quizzing",
                    metadata={
                        "call_kind": "quiz_question_emitted",
                        "trace_role": "quiz_question",
                        "trace_group": "quiz",
                        "question_index": index,
                        "total_questions": len(pairs),
                        "qa_pair": pair,
                        **source_metadata,
                    },
                )

        summary = {
            "success": True,
            "source": "original_paper",
            "requested": len(pairs),
            "template_count": len(pairs),
            "completed": len(pairs),
            "failed": 0,
            "paper": source_metadata,
            "templates": [
                {
                    "question_id": pair["question_id"],
                    "topic": pair["question"],
                    "question_type": pair["question_type"],
                    "difficulty": pair["difficulty"],
                    "source": "original_paper",
                    "question_number": pair["source_question_number"],
                }
                for pair in pairs
            ],
            "results": [
                {
                    "qa_pair": pair,
                    "metadata": {
                        **source_metadata,
                        "question_id": pair["question_id"],
                        "question_number": pair["source_question_number"],
                    },
                }
                for pair in pairs
            ],
            "analysis": "",
        }
        await emit_capability_result(
            stream,
            {
                "response": f"Original Paper: {paper.display_name}",
                "mode": "original_paper",
                "source_type": "original_paper",
                "paper_id": paper.paper_id,
                "paper": source_metadata,
                "summary": summary,
                "metadata": source_metadata,
            },
            source=self.name,
        )

    async def _run_mimic_mode(
        self,
        *,
        context: UnifiedContext,
        stream: StreamBus,
        kb_name: str | None,
        output_dir,
        overrides: dict[str, Any],
        history_context: str,
        num_questions: int,
        i18n: StatusI18n | None = None,
    ) -> None:
        """Resolve an exam paper → templates → ``QuestionPipeline.run`` with
        ``templates_override``. No legacy AgentCoordinator involvement.

        Three input shapes:

        * Uploaded PDF attachment      → write to tmpfile, parse with MinerU
        * Server-side parsed directory → skip parsing, just extract questions
        * ``[Attached Documents]`` in  → no paper available; fall back to
          the user_message text          custom-mode pipeline with a
                                         "mimic the attached source" hint
                                         prefixed onto the user_message
        """
        from deeptutor.agents.question.history import load_session_quiz_history
        from deeptutor.agents.question.mimic_source import (
            parse_exam_paper_to_templates,
        )
        from deeptutor.agents.question.pipeline import QuestionPipeline
        from deeptutor.agents.question.request_config import (
            build_question_runtime_config,
        )
        from deeptutor.services.config import load_config_with_main
        from deeptutor.services.parsing.engines.mineru.config import MinerUError

        if i18n is None:
            i18n = StatusI18n(self.name, context.language, module="question")
        paper_path = str(overrides.get("paper_path", "") or "").strip()
        max_questions = int(overrides.get("max_questions", 10) or 10)
        pdf_attachment = next(
            (
                attachment
                for attachment in context.attachments
                if attachment.filename.lower().endswith(".pdf")
                or attachment.type == "pdf"
                or attachment.mime_type == "application/pdf"
            ),
            None,
        )

        runtime_config = build_question_runtime_config(
            base_config=load_config_with_main("main.yaml"),
        )
        pipeline = QuestionPipeline(
            language=context.language,
            kb_name=kb_name,
            enabled_tools=list(context.enabled_tools or []),
            runtime_config=runtime_config,
        )
        quiz_history = await load_session_quiz_history(context.session_id or "")

        async def _emit_parse_notice(message: str) -> None:
            async with stream.stage("exploring", source=self.name):
                await stream.thinking(message, source=self.name, stage="exploring")

        if pdf_attachment and pdf_attachment.base64:
            # Bridge MinerU's progress lines (emitted from the parser worker
            # thread) back onto the event loop so the trace panel streams them
            # live — model downloads and per-page parsing would otherwise look
            # like a silent multi-minute hang.
            loop = asyncio.get_running_loop()

            def _parse_progress(line: str) -> None:
                asyncio.run_coroutine_threadsafe(
                    stream.thinking(line, source=self.name, stage="exploring"),
                    loop,
                )

            try:
                async with stream.stage("exploring", source=self.name):
                    await stream.thinking(
                        i18n.t(
                            "parsing_uploaded",
                            "Parsing uploaded exam paper and extracting templates...",
                        ),
                        source=self.name,
                        stage="exploring",
                    )
                    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as temp_pdf:
                        temp_pdf.write(base64.b64decode(pdf_attachment.base64))
                        temp_pdf.flush()
                        templates, _ = await parse_exam_paper_to_templates(
                            temp_pdf.name,
                            max_questions=max_questions,
                            paper_mode="upload",
                            output_dir=output_dir,
                            progress_callback=_parse_progress,
                        )
            except MinerUError as exc:
                await stream.error(str(exc), source=self.name)
                return
            await pipeline.run(
                context=context,
                user_message=context.user_message,
                num_questions=len(templates) or num_questions,
                difficulty="",
                conversation_context=history_context,
                attachments=context.attachments,
                quiz_history=quiz_history,
                templates_override=templates,
                stream=stream,
            )
            return

        if paper_path:
            await _emit_parse_notice(
                i18n.t(
                    "parsing_directory",
                    "Loading parsed exam paper and extracting templates...",
                )
            )
            try:
                templates, _ = await parse_exam_paper_to_templates(
                    paper_path,
                    max_questions=max_questions,
                    paper_mode="parsed",
                    output_dir=output_dir,
                )
            except MinerUError as exc:
                await stream.error(str(exc), source=self.name)
                return
            await pipeline.run(
                context=context,
                user_message=context.user_message,
                num_questions=len(templates) or num_questions,
                difficulty="",
                conversation_context=history_context,
                attachments=context.attachments,
                quiz_history=quiz_history,
                templates_override=templates,
                stream=stream,
            )
            return

        if "[Attached Documents]" in context.user_message:
            # No paper available — degrade to custom-mode generation but
            # bias the pipeline toward shadowing the attached source by
            # prefixing the user message with an explicit instruction.
            mimic_hint = (
                "[Mimic the attached source document as closely as possible: "
                "style, difficulty, structure, and assessed concepts.]\n\n"
            )
            await pipeline.run(
                context=context,
                user_message=mimic_hint + context.user_message,
                num_questions=max_questions,
                difficulty="",
                conversation_context=history_context,
                attachments=context.attachments,
                quiz_history=quiz_history,
                stream=stream,
            )
            return

        await stream.error(
            i18n.t(
                "mimic_needs_paper",
                "Mimic mode requires either an uploaded PDF or a parsed exam directory.",
            ),
            source=self.name,
        )

    def _build_trace_bridge(self, stream: StreamBus, i18n: StatusI18n | None = None):
        async def _trace_bridge(update: dict[str, Any]) -> None:
            event = str(update.get("event", "") or "")
            stage = str(update.get("phase") or update.get("stage") or "generation")
            base_metadata = {
                key: value
                for key, value in update.items()
                if key
                not in {"event", "state", "response", "chunk", "result", "tool_name", "tool_args"}
            }

            if event == "llm_call":
                state = str(update.get("state", "running"))
                label = str(update.get("label", "") or "")
                if state == "running":
                    await stream.progress(
                        message=label,
                        source=self.name,
                        stage=stage,
                        metadata=merge_trace_metadata(
                            base_metadata,
                            {"trace_kind": "call_status", "call_state": "running"},
                        ),
                    )
                    return
                if state == "streaming":
                    chunk = str(update.get("chunk", "") or "")
                    if chunk:
                        await stream.thinking(
                            chunk,
                            source=self.name,
                            stage=stage,
                            metadata=merge_trace_metadata(
                                base_metadata,
                                {"trace_kind": "llm_chunk"},
                            ),
                        )
                    return
                if state == "complete":
                    was_streaming = update.get("streaming", False)
                    if not was_streaming:
                        response = str(update.get("response", "") or "")
                        if response:
                            await stream.thinking(
                                response,
                                source=self.name,
                                stage=stage,
                                metadata=merge_trace_metadata(
                                    base_metadata,
                                    {"trace_kind": "llm_output"},
                                ),
                            )
                    await stream.progress(
                        message="",
                        source=self.name,
                        stage=stage,
                        metadata=merge_trace_metadata(
                            base_metadata,
                            {"trace_kind": "call_status", "call_state": "complete"},
                        ),
                    )
                    return
                if state == "error":
                    fallback = (
                        i18n.t("llm_call_failed", "LLM call failed.")
                        if i18n is not None
                        else "LLM call failed."
                    )
                    await stream.error(
                        str(update.get("response", "") or fallback),
                        source=self.name,
                        stage=stage,
                        metadata=merge_trace_metadata(
                            base_metadata,
                            {"trace_kind": "call_status", "call_state": "error"},
                        ),
                    )
                    return

            if event == "tool_call":
                await stream.tool_call(
                    tool_name=str(update.get("tool_name", "") or "tool"),
                    args=update.get("tool_args", {}) or {},
                    source=self.name,
                    stage=stage,
                    metadata=merge_trace_metadata(
                        base_metadata,
                        {"trace_kind": "tool_call"},
                    ),
                )
                return

            if event == "tool_result":
                state = str(update.get("state", "complete"))
                result = str(update.get("result", "") or "")
                if state == "error":
                    await stream.error(
                        result,
                        source=self.name,
                        stage=stage,
                        metadata=merge_trace_metadata(
                            base_metadata,
                            {"trace_kind": "tool_result"},
                        ),
                    )
                    return
                await stream.tool_result(
                    tool_name=str(update.get("tool_name", "") or "tool"),
                    result=result,
                    source=self.name,
                    stage=stage,
                    metadata=merge_trace_metadata(
                        base_metadata,
                        {"trace_kind": "tool_result"},
                    ),
                )

        return _trace_bridge


class ExamCapability(DeepQuestionCapability):
    """Exam facade that reuses Deep Question's Original Paper path."""

    manifest = CapabilityManifest(
        name="exam",
        description="Run a selected Paper Library paper as an Exam.",
        stages=["quizzing"],
        tools_used=[],
        cli_aliases=["exam"],
        request_schema=get_capability_request_schema("exam"),
    )

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        # The exam facade only runs paper exams: start a paper run unless the
        # caller explicitly asks for the interactive proctor path — anything
        # else (custom/mimic/absent) collapses to original_paper as before.
        mode = context.config_overrides.get("mode")
        overrides = {
            **context.config_overrides,
            "mode": "proctor" if mode == "proctor" else "original_paper",
        }
        await super().run(
            replace(context, config_overrides=overrides),
            stream,
        )
