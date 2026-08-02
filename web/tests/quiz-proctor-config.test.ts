import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_QUIZ_CONFIG,
  resolveQuizWSConfig,
  type DeepQuestionFormConfig,
} from "../lib/quiz-types";

const customConfig: DeepQuestionFormConfig = {
  ...DEFAULT_QUIZ_CONFIG,
  mode: "custom",
  topic: " fractions ",
  num_questions: 5,
};

test("no quiz yet → the user's generation config", () => {
  assert.deepEqual(
    resolveQuizWSConfig({ quizActive: false, quizConfig: customConfig }),
    {
      mode: "custom",
      num_questions: 5,
      difficulty: "",
      question_types: [],
      per_type_counts: {},
    },
  );
});

test("quiz on the table → proctor, never a silent regeneration", () => {
  assert.deepEqual(
    resolveQuizWSConfig({ quizActive: true, quizConfig: customConfig }),
    { mode: "proctor" },
  );
});
