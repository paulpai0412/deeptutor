import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_QUIZ_CONFIG,
  resolveExamWSConfig,
  type DeepQuestionFormConfig,
} from "../lib/quiz-types";

const examQuizConfig: DeepQuestionFormConfig = {
  ...DEFAULT_QUIZ_CONFIG,
  mode: "original_paper",
  paper_id: "paper-1",
};

test("exam not started yet → original_paper with paper_id", () => {
  assert.deepEqual(
    resolveExamWSConfig({ examActive: false, quizConfig: examQuizConfig }),
    { mode: "original_paper", paper_id: "paper-1" },
  );
});

test("exam already running → proctor, paper data stays server-side", () => {
  assert.deepEqual(
    resolveExamWSConfig({ examActive: true, quizConfig: examQuizConfig }),
    { mode: "proctor" },
  );
});

test("proctor routing survives lost client paper_id", () => {
  // Hydration wipes original_paper fields; a voice turn after reload must
  // not try to restart the paper with an empty id.
  const wiped: DeepQuestionFormConfig = {
    ...examQuizConfig,
    mode: "custom",
    paper_id: "",
  };
  assert.deepEqual(resolveExamWSConfig({ examActive: true, quizConfig: wiped }), {
    mode: "proctor",
  });
});
