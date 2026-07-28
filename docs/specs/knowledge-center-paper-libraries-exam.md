# Knowledge Center 試卷庫與 Exam 原卷測驗規格

## Problem Statement

DeepTutor 已有可保存 PDF、擷取題目、檢視結果與啟動 Original Paper 的基礎功能，但目前 Paper Library 仍位於 Learning Space，且所有試卷共用單一平面容器。這使試卷來源資源與 Question Bank 的收藏題目、Knowledge Base 的文件資源之間缺少清楚的領域邊界。

使用者需要在 Knowledge Center 內管理多個可分類的試卷庫，為每個試卷庫指定試卷擷取所用的 LLM、PDF parser 與失敗處理策略，並能在擷取完成後檢查題目與圖片配對。Chat 也需要有獨立的「考試」Capability：考試選擇的是「試卷庫 → 試卷」，而不是一般 Knowledge Base 或 Custom Quiz 設定。

目前還不需要試卷計分、總分統計或成績歷史；本規格明確不實作計分功能。

## Solution

將 Paper Library 的使用者入口移至 Knowledge Center，與 Knowledge Bases 以同層 tab 呈現：

- `Knowledge Bases`
- `Paper Libraries`

Paper Library 仍是獨立的私有資源，不使用 Knowledge Base `metadata.type` 偽裝，不建立 RAG 索引，也不依賴 Knowledge Base 權限。

Paper Library 以一層式分類容器管理試卷。每份試卷只屬於一個試卷庫；同一試卷庫以 PDF SHA-256 去重，不同試卷庫可以保存相同 PDF。試卷庫建立時設定 extraction LLM、PDF parser 與失敗處理策略；LLM 永遠啟用，且只負責 PDF 題目擷取，不控制 Chat、follow-up 或 AI Judge。

Chat 新增獨立的 `Exam` Capability，重用現有 Deep Question 的 Original Paper 執行路徑。一般 `Quiz` Capability 只保留 `Custom` 與 `Mimic Paper`。Exam 介面隱藏一般 Knowledge selector，改以「試卷庫 → 試卷」選擇來源；原卷 side card 只在 Exam 中顯示。

Paper Review 允許修正題號、答案，以及解除錯誤的題目圖片配對。解除配對不刪除原始 PDF；若 asset 已沒有任何題目引用，後端可清理該未引用 asset。第一版不支援把圖片重新配對到另一題。

## User Stories

1. As a learner, I want to open Paper Libraries from Knowledge Center, so that source papers live beside Knowledge Bases instead of inside Question Bank management.
2. As a learner, I want to switch between Knowledge Bases and Paper Libraries at the same level, so that the two resource types have clear and predictable ownership.
3. As a learner, I want `/space/questions` to redirect to Knowledge Center, so that the old entry point does not become a second Paper Library surface.
4. As a learner, I want 收藏題目 to remain separate from Paper Libraries, so that saved quiz records are not confused with source PDFs.
5. As a learner, I want my Paper Libraries to remain private to my current user/workspace, so that another user cannot see my source papers, answers, or extracted images.
6. As a learner, I want to create a Paper Library with a name and optional description, so that I can group related exams.
7. As a learner, I want Paper Library names to be unique within my user/workspace regardless of case or surrounding whitespace, so that two containers cannot be confused.
8. As a learner, I want the first release to use one-level classification, so that organizing papers stays simple and does not introduce nested folders.
9. As a learner, I want no default Paper Library to be created automatically, so that an uploaded paper is never silently assigned to the wrong category.
10. As a learner, I want to rename or delete a Paper Library, so that obsolete categories can be maintained.
11. As a learner, I want deleting a Paper Library to delete its live paper resources, so that the container deletion is complete.
12. As a learner, I want deleting a Paper Library not to delete Chat history, quiz snapshots, or Question Bank records, so that historical learning evidence remains available.
13. As a learner, I want to move a paper to another Paper Library, so that I can correct an earlier classification.
14. As a learner, I want a move to retain the paper ID when the destination has no duplicate, so that paper references and current review state remain stable.
15. As a learner, I want a move blocked when the destination already contains the same PDF hash, so that one Paper Library never contains duplicate content.
16. As a learner, I want the same PDF to be allowed in different Paper Libraries, so that one source can be organized under different learning contexts.
17. As a learner, I want to upload one or more PDFs into a selected Paper Library, so that I can build a categorized source collection.
18. As a learner, I want drag-and-drop and file-picker upload to reuse existing upload behavior, so that Paper Library does not have a second file workflow.
19. As a learner, I want non-PDF, unsafe, unreadable, or oversized files rejected, so that invalid source material never enters extraction.
20. As a learner, I want identical PDFs deduplicated only within the selected Paper Library, so that duplicate LLM extraction is avoided without preventing cross-library organization.
21. As a learner, I want an uploaded paper to preserve its original filename and safe display name, so that provenance is visible without exposing filesystem paths.
22. As a learner, I want each paper to have an opaque paper ID, so that Chat requests never transmit a server path or Knowledge Base name.
23. As a learner, I want extraction to start in the background after upload, so that the UI remains usable while a paper is processed.
24. As a learner, I want one failed paper in a batch not to stop the other papers, so that a single bad PDF does not block the upload batch.
25. As a learner, I want each paper to show its own pending, processing, ready, ready-with-warnings, partial, or failed status, so that I know which papers can be used.
26. As a learner, I want extraction progress to use the existing task/progress infrastructure, so that a long extraction does not appear frozen.
27. As a learner, I want a failed paper to retain its PDF, so that I can review the source and retry it.
28. As a learner, I want an interrupted extraction to become failed and retryable after restart, so that no paper remains permanently stuck in processing.
29. As a learner, I want the system not to auto-retry a failed paper, so that an unavailable LLM or parser does not cause unexpected repeated cost.
30. As a learner, I want a clear error when the configured extraction LLM is unavailable, so that I know why the paper failed and can retry after fixing settings.
31. As a learner, I want LLM extraction to be mandatory, so that structured question extraction never silently falls back to a non-LLM path.
32. As a learner, I want to select a system-default or available PDF parser when configuring a Paper Library, so that the extraction behavior is explicit.
33. As a learner, I want parser and LLM settings to apply to new uploads and manual retries, so that configuration changes have a predictable boundary.
34. As a learner, I want existing papers not to be re-extracted automatically after a setting change, so that settings changes do not unexpectedly replace reviewed questions.
35. As a learner, I want each paper to retain an extraction configuration snapshot, so that I can tell which LLM, parser, and failure policy produced its current questions.
36. As a learner, I want a Paper Library to define a failure policy, so that partial usable results and complete failures are handled consistently.
37. As a learner, I want usable questions retained as `partial` when some extraction records fail, so that one malformed question does not discard the whole paper.
38. As a learner, I want a paper with no usable questions marked `failed`, so that an empty paper cannot launch an Exam.
39. As a learner, I want a complete question set with warnings marked `ready_with_warnings`, so that I can review uncertainty without losing usable content.
40. As a learner, I want the full text-layer PDF sent to the extraction LLM, so that answer keys and question boundaries can be resolved across pages.
41. As a learner, I want scanned/image-only PDFs to fail with a clear text-layer message, so that OCR is not silently implied.
42. As a learner, I want original question wording, options, displayed numbers, order, page metadata, and source language preserved, so that the Paper Library remains faithful to the PDF.
43. As a learner, I want explicit answer-key content copied without answer inference, so that uncertain answers remain visibly uncertain.
44. As a learner, I want all supported question types retained, so that choice, concept, fill-in-blank, short-answer, written, and coding questions remain available.
45. As a learner, I want parser-extracted image assets preserved even when visual meaning is uncertain, so that diagrams are not lost.
46. As a learner, I want a Vision-capable extraction LLM to receive available images when supported, so that visual question associations can be more accurate.
47. As a learner, I want non-Vision extraction to retain layout/order associations with a warning, so that the paper remains usable while signaling manual review.
48. As a learner, I want question image references to use safe relative asset names, so that server paths and Base64 data never enter durable paper JSON.
49. As a learner, I want Paper Review to show each question's related images, so that I can compare the association with the original PDF.
50. As a learner, I want to remove a wrongly associated image from a question, so that an incorrect visual context does not appear in an Exam.
51. As a learner, I want removing an image association not to modify the original PDF, so that source evidence is never destroyed by review.
52. As a learner, I want unused assets optionally cleaned after unlinking, so that paper storage does not retain files no question can use.
53. As a learner, I want the first release to support unlinking only, so that Review does not introduce a complex drag-and-drop reassignment model.
54. As a learner, I want to correct a displayed question number and reference answer, so that extraction mistakes can be repaired before an Exam.
55. As a learner, I want manual corrections saved per question, so that one correction does not require a bulk-edit workflow.
56. As a learner, I want a retry to use the current Paper Library settings, so that manual retry is an explicit request for a new extraction.
57. As a learner, I want a retry to replace current questions only after a valid candidate is ready, so that a failed retry does not erase a usable paper.
58. As a learner, I want a successful retry to clear old manual corrections, so that corrections from an older extraction are not applied to new question IDs.
59. As a learner, I want to open the original PDF through a secure paper endpoint, so that I can verify extraction against the source.
60. As a learner, I want to delete a paper only after confirmation, so that accidental source loss is less likely.
61. As a learner, I want paper deletion to remove the live PDF, questions, metadata, and assets, so that deletion is real.
62. As a learner, I want re-uploading a deleted PDF to create a new paper identity, so that deletion does not behave like a hidden restore.
63. As a learner, I want to start an Exam from a ready, warning-bearing, or partial paper, so that usable extraction results are immediately studyable.
64. As a learner, I want failed and processing papers unavailable in the Exam picker, so that an Exam cannot start from incomplete live data.
65. As a learner, I want the Exam picker to choose a Paper Library first and a paper second, so that paper selection matches the resource hierarchy.
66. As a learner, I want the Exam picker to show only relevant paper metadata and status, so that I am not asked to configure Custom Quiz options that Exam ignores.
67. As a learner, I want Chat's normal Knowledge selector hidden during an Exam, so that the Exam source cannot be confused with RAG context.
68. As a learner, I want the original-paper side card shown only in Exam, so that ordinary Quiz and Chat surfaces stay uncluttered.
69. As a learner, I want Exam to reuse the existing Deep Question Original Paper execution path, so that source questions are not regenerated or rewritten.
70. As a learner, I want Quiz to keep only Custom and Mimic Paper modes, so that Exam has a clear separate purpose.
71. As a learner, I want an Exam started from Paper Review to open a new Chat session, so that unrelated conversation context cannot contaminate the source paper.
72. As a learner, I want an Exam request to contain only an opaque paper ID, so that local paths and library names are not trusted from the browser.
73. As a learner, I want an immutable snapshot created before the first question is shown, so that later paper edits or deletion cannot change my active Exam.
74. As a learner, I want the snapshot to include all question fields and only the images used by the Exam, so that historical rendering remains complete without copying the PDF.
75. As a learner, I want an Exam to fail before display if a required snapshot image cannot be copied, so that a partial historical Exam is never presented as complete.
76. As a learner, I want one-question-at-a-time Previous/Next navigation, so that the existing QuizViewer interaction remains familiar.
77. As a learner, I want each submitted answer saved immediately, so that leaving the page does not lose completed work.
78. As a learner, I want to skip unanswered questions and return later, so that I can work through a paper at my own pace.
79. As a learner, I want text, choice, multi-line, and image answer inputs to reuse the current QuizViewer, so that Exam does not need a second answer editor.
80. As a learner, I want objective questions with explicit answers to retain current conservative deterministic grading, so that obvious answers do not require unnecessary model calls.
81. As a learner, I want subjective, answerless, image-dependent, and unsupported multi-select questions to remain answerable, so that extraction uncertainty does not remove useful practice.
82. As a learner, I want to start AI Judge manually for a subjective answer, so that LLM feedback remains opt-in per question.
83. As a learner, I want AI Judge results saved with the Question Bank entry, so that feedback survives page reload and paper deletion.
84. As a learner, I want Question Bank records to retain paper ID, library ID, display-name snapshots, and source question number, so that historical source context remains meaningful without a hard foreign key.
85. As a learner, I want deleting a live Paper Library resource not to delete completed Exam history, so that my past learning evidence remains readable.
86. As a maintainer, I want the existing PaperLibraryService to remain the primary backend seam, so that storage and lifecycle rules are not duplicated across routers.
87. As a maintainer, I want the existing parser registry and LLM option registry reused, so that the settings API exposes real available engines and models.
88. As a maintainer, I want the existing task IDs, progress stream, StreamBus, capability registry, session snapshots, and QuizViewer reused, so that the feature does not create parallel infrastructure.
89. As a maintainer, I want deterministic tests to cover library-scoped deduplication and user isolation, so that categorization cannot leak or collide.
90. As a maintainer, I want real PDF/backend/frontend/WebSocket evidence behind an explicit opt-in, so that acceptance uses actual extraction behavior without making default tests network-dependent.
91. As a maintainer, I want UI tests to verify only visible behavior and API contracts, so that implementation refactors do not make tests brittle.

## Implementation Decisions

### Domain boundaries

- Paper Library is a first-class resource alongside Knowledge Base, not a Knowledge Base subtype and not a Question Bank category.
- Question Bank remains the store for saved questions, answers, bookmarks, categories, and AI Judge history. It does not become the Paper Library storage layer.
- Paper Libraries are private per user/workspace. There is no sharing, public library, cross-user import, or Knowledge Base permission inheritance.
- A Paper Library is a flat container. Nested folders, tags, subject metadata, and grade metadata are not part of this release.
- A paper belongs to exactly one Paper Library. The same PDF may exist once per library but may exist in multiple libraries.

### Storage, compatibility, and deletion

- Keep file-backed per-user paper storage and extend its metadata boundary with a persistent Paper Library container registry.
- A paper retains an opaque generated ID, original filename, display name, SHA-256, lifecycle state, counts, warnings/errors, parser information, and current extraction configuration snapshot.
- The current source PDF remains immutable. A new PDF is a new paper; retry reprocesses the same source.
- Same-library deduplication compares complete PDF SHA-256. A destination-library move checks the target hash before changing ownership.
- Deleting a library cascades to its live paper resources. It does not delete Chat sessions, quiz snapshots, Question Bank rows, AI Judge text, or copied answer attachments.
- Existing legacy Paper Library runtime data may be removed as an operational cleanup. No migration of legacy papers into the new container model is required. Existing Question Bank and Chat snapshot data is retained.
- Deleting a live paper removes its PDF, current questions, metadata, and paper assets. Historical snapshot data remains independent.
- Settings changes do not mutate existing paper records and do not automatically schedule extraction.

### Library settings

- A library settings record contains: extraction LLM selection, parser selection, failure policy, and settings schema/version metadata.
- LLM selection stores opaque profile/model IDs, not provider secrets. The settings API uses the existing LLM option discovery and parser registry.
- LLM is mandatory for structured PDF question extraction; the UI does not expose an off switch or non-LLM extraction fallback.
- Parser selection accepts the system default or a currently available parser. An unavailable selected parser fails the task with a clear error.
- Failure policy supports retaining usable questions as `partial` and marking zero-question results as `failed`; extraction never auto-retries.
- Each upload and manual retry captures the effective library settings in the paper's extraction configuration snapshot. Existing papers are not re-extracted when library settings change.
- LLM settings apply only to paper PDF extraction. They do not control Chat responses, follow-up conversations, or AI Judge.

### Paper lifecycle and extraction

- Lifecycle states remain `pending`, `processing`, `ready`, `ready_with_warnings`, `partial`, and `failed`.
- Upload accepts a selected library ID and one or more PDFs. Each paper receives an independent task, while the batch runs serially and continues after individual failures.
- Processing papers cannot be deleted or moved. A restart reconciliation marks abandoned processing as failed and leaves the source retryable.
- A complete extraction with warnings is `ready_with_warnings`; a usable subset after invalid records or incomplete LLM coverage is `partial`; zero usable questions is `failed`.
- Use the existing parser service and parser registry to obtain text, page/block metadata, order, and image assets.
- Send the full parsed document to the configured extraction LLM in one request. Do not silently truncate, chunk, fallback to a different LLM, or disable LLM extraction.
- Use Vision input when the selected LLM supports it. Without Vision, retain images and use layout/order associations with a warning.
- Do not infer missing answers. Preserve blank answers and add review warnings for missing, conflicting, or uncertain answer associations.
- Preserve source wording, source question number, order, options, canonical question type, optional difficulty, page, image references, and internal question ID.
- Keep parser intermediates in the existing parse cache; persist only paper-owned source, metadata, current questions, and copied image assets.
- Extraction output, image assets, question JSON, and metadata are staged and atomically committed. A completely failed retry leaves the previous successful question set intact; a valid partial retry replaces it and marks `partial`.
- Manual Review can edit displayed question number and answer only. Question number cannot be empty; answer may be empty. A successful retry creates fresh question records and clears old manual corrections.

### Image association review

- The question update contract accepts a sanitized image-reference list in addition to question number and answer.
- Review renders every currently associated paper asset with a remove action.
- Remove action only unlinks the asset from that question and persists the question update. It never edits or deletes the original PDF.
- After unlinking, the service may remove an asset file when no question in the same paper references it. Cleanup is best-effort and must not fail the question update.
- Reassigning an image to another question, drag-and-drop association, image cropping, or PDF annotation is out of scope.

### API contracts

- Introduce canonical Paper Library resource endpoints with nested paper operations:
  - list/create/update/delete Paper Libraries;
  - list/upload papers under a library;
  - get/rename/delete/retry/move a paper;
  - get paper detail, source PDF, and secure asset;
  - update a question's number, answer, and image references;
  - list parser options and LLM extraction options.
- Keep existing `/api/v1/papers` operations available for compatibility with current tests and legacy callers while the new UI uses library-scoped endpoints.
- Upload, move, retry, and Exam selection accept opaque IDs only. No endpoint accepts a server filesystem path or Knowledge Base name as a paper source.
- List/detail responses include library identity, paper identity, display metadata, lifecycle state, counts, warnings/errors, progress, parser engine, and extraction configuration snapshot where appropriate.
- Ownership checks are performed through the current user/workspace service before every paper, source, asset, and library operation.
- Conflict responses are used for duplicate library names, same-library duplicate PDFs, invalid moves, and operations racing with processing.

### Knowledge Center UI

- Knowledge Center has two same-level tabs: `Knowledge Bases` and `Paper Libraries`. The existing Knowledge Base views remain available without behavioral changes.
- Paper Library view provides create-library, library selection, library settings, search/filter, upload, processing status, Review, retry, rename, move, delete, and Start Exam actions.
- Library management is one-level; no nested folder tree is rendered.
- Create/edit settings show available LLM and parser options and the statement that structured extraction requires LLM. No option disables LLM.
- Existing PaperLibraryPanel behavior is moved/reused in Knowledge Center rather than maintained as a second Learning Space panel.
- `/space/questions` redirects to Knowledge Center's Paper Libraries view. The old Paper Library URL is not a second source of truth.
- Review keeps source order, displays extraction warnings, shows source page when available, allows question number/answer correction, and provides per-image unlink actions.
- Review starts Exam with the selected paper ID and library context, not a path.

### Exam Capability and Quiz modes

- Register an `exam` Capability that reuses the existing Deep Question Original Paper logic and request validation rather than creating a second quiz engine.
- The existing Quiz capability keeps only `custom` and `mimic` modes. `original_paper` is exposed through Exam, not as a third mode inside ordinary Quiz.
- Exam configuration selects one Paper Library and then one ready, ready-with-warnings, or partial paper. Processing and failed papers are disabled.
- During Exam, hide the normal Knowledge Base selector and show the library-to-paper selector. The Original Paper source card is rendered only for Exam turns.
- Exam sends only the paper ID in its public capability config. The backend resolves ownership, library, current paper state, and current questions.
- Exam uses the stored questions directly and preserves source order. It does not invoke Custom generation, Mimic generation, RAG retrieval, or answer rewriting.
- Start Exam from Review creates a fresh Chat session with Exam configuration preselected.
- Before emitting the first question, create a complete immutable snapshot containing source metadata, question data, and only the images used by those questions. Copy images into existing session attachment/snapshot storage; if a required copy fails, do not emit a quiz.
- Reuse existing StreamBus events, capability result envelope, turn ID, per-question Question Bank upsert, answer-image persistence, QuizViewer navigation, retry/reset, follow-up, and manual AI Judge.
- Incomplete Exams remain resumable. No score, points, score summary, or completion result is created by this feature.

### Question Bank integration

- Add nullable source metadata for library ID/name snapshot, paper ID/name snapshot, source question number, source type, and snapshot ID where needed.
- Do not create a hard foreign key from Question Bank to a live Paper Library resource. Historical rows must survive library or paper deletion.
- Preserve current turn-scoped uniqueness and existing bookmark/category/AI Judge behavior.
- Paper Library papers are not added to the general Question Bank picker in this release.

### Testing seams

- Use the existing PaperLibraryService/application-service boundary as the single new backend seam. Test public behavior for libraries, scoped deduplication, settings snapshots, lifecycle, image unlinking, move/delete, ownership, and secure asset access.
- Use the existing Deep Question Capability plus StreamBus as the quiz seam. Assert Exam routing, paper-ID resolution, source order, snapshot completeness, error-before-first-question behavior, turn-scoped metadata, and persistence without testing private helper calls.
- Use existing API TestClient contracts for library/paper endpoints and existing WebSocket tests for capability/snapshot behavior.
- Use the existing Playwright/UI audit seam for Knowledge Center tabs, library CRUD/settings, upload/review/move/retry/delete, Exam configuration, hidden selectors, Start Exam, and real navigation.
- Do not create a parallel storage service, task queue, quiz renderer, WebSocket protocol, or frontend test framework.

## Testing Decisions

- Tests assert observable contracts: response status and payload shape, durable metadata/questions, file ownership boundaries, lifecycle transitions, emitted StreamBus events, snapshot contents, Question Bank source metadata, and visible UI state. They do not assert private helper call order or exact LLM prose.
- Service tests cover library name uniqueness, flat-container behavior, same-library SHA-256 deduplication, cross-library duplicate allowance, move conflicts, cascade deletion without snapshot deletion, settings persistence, config snapshots, image unlink cleanup, retry behavior, status recovery, and user isolation.
- API tests cover canonical nested endpoints, legacy compatibility endpoints, parser/LLM option responses, upload scoping, duplicate conflicts, source/asset authorization, question image removal, and error mapping for busy or missing resources.
- Extraction tests use real text-layer PDF fixtures and injected deterministic parser/LLM seams to verify schema normalization, source order, question/image association, warning/partial/failed state, selected parser/LLM snapshot, and no-fallback behavior.
- Real LLM/network tests are opt-in through `PAPER_REAL_E2E=1`. They use real PDF fixtures, the running backend, the running frontend, the real WebSocket, and a configured real LLM; they do not use mock, fake, synthetic, or fallback evidence.
- Real E2E assertions are structural: library creation, settings visibility, PDF upload, task completion, Review, removal of an incorrect image association, retry/delete behavior, Exam library-to-paper selection, new session, snapshot-backed source card, per-question submission, Previous/Next, and Question Bank source metadata. No scoring assertion is included.
- Browser tests use the required `LD_LIBRARY_PATH` workaround and existing Playwright configuration. Python tests use `PYTHONPATH=. .venv/bin/python -m pytest -c /dev/null`.
- Existing Custom, Mimic Paper, Original Paper foundation, QuizViewer turn-scoping, attachment, Question Bank, AI Judge, and Knowledge Base regression tests must continue to pass.

## Out of Scope

- Any scoring feature: per-question points, 100-point normalization, total score, percentage, completion score, result statistics, score history, or ranking.
- Automatic score completion or a distinction between an incomplete and scored Exam.
- Knowledge Base `metadata.type` classification, RAG indexing, vector search, Knowledge Base file links, or Knowledge Base permission inheritance.
- Shared/public Paper Libraries, collaboration, cross-user import, cloud object storage, or workspace sharing.
- Nested folders, tags, subjects, grade metadata, paper/full-text question search, or advanced classification.
- OCR, scanned/image-only PDF support, automatic translation, source rewriting, or answer inference.
- Multiple PDFs as one logical paper, separate answer-key uploads, or external answer files.
- Automatic re-extraction after settings changes and automatic retry after failures.
- Paper version history, correction carry-forward, diff view, or bulk question correction.
- Image reassignment, drag-and-drop image matching, image cropping, PDF annotation, or a custom PDF reader.
- A new multi-select question UI or deterministic multi-select grading.
- Automatic AI Judge for every answer; AI Judge remains manually initiated as in the existing flow.
- Adding Paper Library papers to the general Question Bank picker.
- Migration of legacy runtime paper resources into new libraries. Legacy paper data may be operationally removed; historical Question Bank and quiz snapshot data is retained.
- A new task queue, persistence database, quiz renderer, WebSocket protocol, or frontend test framework.

## Further Notes

- This specification supersedes the earlier Paper Library placement/configuration proposal for the next implementation slice while preserving the completed Paper Library, snapshot, Question Bank, and Original Paper foundation.
- The old Paper Library runtime data is not a migration source. If it is removed, the new UI starts with explicitly created Paper Libraries.
- The extraction LLM setting is deliberately narrower than the Chat model selector: it is a paper-ingestion setting only.
- The previously discussed scoring design (LLM-assigned per-question weights normalized to 100) is intentionally deferred and must not be implemented as part of this issue.
