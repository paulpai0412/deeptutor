import test from "node:test";
import assert from "node:assert/strict";

import {
  buildQuizWSConfig,
  extractQuizQuestions,
  extractStreamingQuizQuestions,
  normalizeQuizConfig,
  summarizeQuizConfig,
  type DeepQuestionFormConfig,
} from "../lib/quiz-types";

const originalConfig: DeepQuestionFormConfig = {
  mode: "original_paper",
  topic: "ignored",
  num_questions: 20,
  difficulty: "hard",
  question_types: ["choice"],
  per_type_counts: { choice: 20 },
  paper_path: "/must-not-be-sent",
  paper_id: "paper-123",
  max_questions: 100,
};

test("Original Paper request sends only its opaque paper ID", () => {
  assert.deepEqual(buildQuizWSConfig(originalConfig), {
    mode: "original_paper",
    paper_id: "paper-123",
  });
});

test("normalizes persisted quiz config from before paper_id existed", () => {
  const restored = normalizeQuizConfig({
    mode: "custom",
    topic: "old quiz",
    num_questions: 3,
    difficulty: "auto",
    question_types: [],
    per_type_counts: {},
    paper_path: "",
    max_questions: 10,
  });

  assert.equal(restored.paper_id, "");
  assert.doesNotThrow(() =>
    summarizeQuizConfig({ ...restored, mode: "original_paper" }),
  );
});

test("Original Paper summary names the selected paper ID", () => {
  assert.equal(
    summarizeQuizConfig(originalConfig),
    "Original Paper · paper-123",
  );
});

test("Original Paper streaming questions retain source metadata and order", () => {
  const questions = extractStreamingQuizQuestions([
    {
      type: "content",
      metadata: {
        call_kind: "quiz_question_emitted",
        question_index: 1,
        qa_pair: {
          question_id: "q-2",
          question: "Second",
          question_type: "written",
          correct_answer: "B",
          explanation: "",
          source_type: "original_paper",
          paper_id: "paper-123",
          source_question_number: "2",
        },
      },
    },
    {
      type: "content",
      metadata: {
        call_kind: "quiz_question_emitted",
        question_index: 0,
        qa_pair: {
          question_id: "q-1",
          question: "First",
          question_type: "choice",
          correct_answer: "A",
          explanation: "",
          source_type: "original_paper",
          paper_id: "paper-123",
          source_question_number: "1",
        },
      },
    },
  ]);

  assert.deepEqual(
    questions?.map((question) => [
      question.question_id,
      question.source_type,
      question.paper_id,
      question.source_question_number,
    ]),
    [
      ["q-1", "original_paper", "paper-123", "1"],
      ["q-2", "original_paper", "paper-123", "2"],
    ],
  );
});

test("Original Paper result extraction keeps persisted result order", () => {
  const questions = extractQuizQuestions({
    mode: "original_paper",
    paper_id: "paper-123",
    summary: {
      results: [
        {
          qa_pair: {
            question_id: "q-2",
            question: "Second",
            question_type: "written",
            correct_answer: "",
            explanation: "",
            source_type: "original_paper",
            paper_id: "paper-123",
            source_question_number: "2",
          },
        },
        {
          qa_pair: {
            question_id: "q-1",
            question: "First",
            question_type: "written",
            correct_answer: "",
            explanation: "",
            source_type: "original_paper",
            paper_id: "paper-123",
            source_question_number: "1",
          },
        },
      ],
    },
  });

  assert.deepEqual(
    questions?.map((question) => question.question_id),
    ["q-2", "q-1"],
  );
});
