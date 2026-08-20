# DeepTutor Domain Context

This context defines the terms used when managing learning resources and source exam papers.

## Learning resources

**Knowledge Base**:
A resource for documents used to provide grounded retrieval context.
_Avoid_: Paper Library, Question Bank

**Paper Library**:
A private collection of source exam papers and their extracted questions.
_Avoid_: 題庫 when referring to the source-paper collection

**Paper Folder**:
An organizational container inside a Paper Library that may contain papers and child Paper Folders.
_Avoid_: Paper Library, sub-library

**Question Bank**:
Saved questions and learning records produced by study activity.
_Avoid_: Paper Library

## Paper study

**Paper**:
A source exam paper and its extracted question set, which may be placed at the Paper Library root or inside a Paper Folder.

**Original Paper / Exam**:
A study session that presents one Paper's extracted questions in source order.

## Pet companions

**Study Day**:
A calendar day on which the learner answers at least one quiz question. A Study Day counts as "attending class"; a day with no answered question counts as absent.
_Avoid_: 上課, attendance record

**Pet XP**:
The single score that both measures study achievement and drives pet growth. Correct answers, attendance (Study Days), and other study activity increase it; wrong answers and absent days decrease it. There is no separate currency or feeding resource.
_Avoid_: 金幣, food, points balance

## Media generation

**Generation Provider**:
The independently selected service that creates media outputs for a turn. It is configured separately from the language-model provider so a turn may use one provider for reasoning and another for image generation.
_Avoid_: assuming the active language-model provider is automatically the image-generation provider.

**Generation Controller Model**:
The model selected within a Generation Provider to interpret a media request and control its generation capability. It is distinct from a provider-managed image model, which may be chosen internally by the provider.

**Imagegen Tool**:
The existing user-enabled chat tool that requests image output through the selected Generation Provider. Provider changes do not create a new user-facing tool or conversation data flow.

## Voice interactions

**Realtime Voice Session**:
A live, bidirectional voice interaction that exchanges audio input, audio output, and partial speech events over one session. It is distinct from one-shot speech transcription and speech synthesis.

**Reasoning Owner**:
The component responsible for interpreting a committed user turn, selecting capabilities and tools, and producing DeepTutor's canonical response. A Realtime Voice Session does not change this ownership.

**Realtime Voice Provider**:
A provider that carries audio input/output and speech events for a Realtime Voice Session without becoming the Reasoning Owner.

**Committed Voice Turn**:
A user turn created only from GPT-Live V3's native `delegation.created` event and submitted to the Reasoning Owner. Interim/final transcript events alone are not turns; provider-owned direct responses are muted and rejected without ending the voice session.

**Partial Speech Event**:
An interim audio or transcript event used for live session feedback but not eligible to trigger reasoning, tools, or artifacts.

**Barge-in**:
A new user utterance that begins while the assistant is delivering a response in a Realtime Voice Session. It stops response delivery and requests cancellation of the interrupted response.

**Cooperative Cancellation**:
A request to stop an interrupted response at safe boundaries. It does not promise rollback of side effects that have already completed.

**Interrupted Voice Turn**:
A Committed Voice Turn whose response delivery was stopped by Barge-in. No new tool or artifact side effect begins after cancellation; in-flight work may finish, and completed side effects remain.

**Voice Input Mode**:
The user-selected meaning of the chat microphone: **Dictation** records one utterance for one-shot transcription into the composer; **Realtime Conversation** opens a Realtime Voice Session. The default is Dictation. It is a global Voice setting shared by chats.

## Teaching whiteboard

**Whiteboard Presentation Mode**:
An optional way for existing capabilities to present a turn through a persistent interactive board alongside text and voice. It is not a Capability or a separate Reasoning Owner.
_Avoid_: Whiteboard Capability, Canvas Agent

**Board Document**:
The persistent, session-owned collection of learner board content and tutor annotations.
_Avoid_: treating a screenshot, viewport, or unfinished animation as the board

**Board Action**:
A validated semantic instruction from the Reasoning Owner to write, draw, mark, highlight, focus, or clear tutor-owned content. It does not contain raw canvas-engine data or executable content.
_Avoid_: Canvas Command, raw Excalidraw operation

**Teaching Beat**:
The smallest semantic presentation unit: normally one to three spoken sentences plus the correlated Board Actions that support them. It is produced once by DeepTutor and delivered through independent speech and board channels.
_Avoid_: audio timestamp, individual stroke, Whiteboard Agent turn

**Dual-Channel Delivery**:
Non-blocking fan-out of one Teaching Beat: narration goes to GPT-Live's `speakable` sideband while Board Actions go through StreamBus and the Unified WebSocket. Neither channel waits for the other.
_Avoid_: transcript-to-board conversion, board acknowledgement barrier

**Learner Board Content**:
Any board element created by the learner, including handwriting, text, shapes, and arrows. Tutor actions may reference it but never edit or delete it.
_Avoid_: Student Annotation

**Tutor Annotation**:
Board content created by a Board Action to explain or respond to learner work. It may be cleared or replaced without affecting Learner Board Content.
_Avoid_: AI Shape, Agent Ink

**Board Context**:
A bounded representation of selected or relevant board elements, optionally with one region image, submitted with an explicit learner turn.
_Avoid_: continuous canvas stream, full board dump

**Presentation Interruption**:
A Barge-in or newer learner turn that stops pending speech and Board Action delivery while preserving completed board content.
_Avoid_: board rollback, clearing interrupted work
