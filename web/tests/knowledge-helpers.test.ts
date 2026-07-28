import test from "node:test";
import assert from "node:assert/strict";
import type { TFunction } from "i18next";

import {
  kbCanReindex,
  validateFiles,
  type KnowledgeBase,
} from "../lib/knowledge-helpers";

function kb(overrides: Partial<KnowledgeBase>): KnowledgeBase {
  return {
    name: "kb",
    status: "ready",
    statistics: { raw_documents: 1 },
    ...overrides,
  };
}

test("kbCanReindex allows failed knowledge bases with source files", () => {
  assert.equal(
    kbCanReindex(
      kb({
        status: "error",
        statistics: { raw_documents: 1, active_match: true },
      }),
    ),
    true,
  );
});

test("kbCanReindex keeps empty failed knowledge bases disabled", () => {
  assert.equal(
    kbCanReindex(
      kb({
        status: "error",
        statistics: { raw_documents: 0, active_match: false },
      }),
    ),
    false,
  );
});

test("kbCanReindex preserves mismatch and needs-reindex behavior", () => {
  assert.equal(
    kbCanReindex(kb({ statistics: { raw_documents: 1, needs_reindex: true } })),
    true,
  );
  assert.equal(
    kbCanReindex(kb({ statistics: { raw_documents: 1, active_match: false } })),
    true,
  );
  assert.equal(
    kbCanReindex(kb({ statistics: { raw_documents: 1, active_match: true } })),
    false,
  );
});

test("paper upload validation keeps only PDF files within the size limit", () => {
  const t = ((key: string) => key) as TFunction;
  const selection = validateFiles(
    [
      new File(["pdf"], "practice.pdf"),
      new File(["text"], "notes.txt"),
      new File(["too-large"], "large.pdf"),
    ],
    {
      extensions: [".pdf"],
      accept: ".pdf,application/pdf",
      max_file_size_bytes: 5,
    },
    t,
  );

  assert.deepEqual(
    selection.validFiles.map((file) => file.name),
    ["practice.pdf"],
  );
  assert.deepEqual(
    selection.invalidFiles.map((item) => [item.file.name, item.error]),
    [
      ["notes.txt", "Unsupported file type"],
      ["large.pdf", "This file exceeds the maximum size of {{size}}."],
    ],
  );
});
