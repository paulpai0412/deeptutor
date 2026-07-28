import test from "node:test";
import assert from "node:assert/strict";

import {
  deletePaper,
  getPaperLibraryPaper,
  listPaperLibrary,
  paperAssetPath,
  retryPaper,
  updatePaperQuestion,
  type PaperLibraryRecord,
} from "../lib/knowledge-api";

const paper: PaperLibraryRecord = {
  paper_id: "paper-1",
  display_name: "Practice.pdf",
  original_filename: "Practice.pdf",
  source_hash: "abc123",
  status: "pending",
  question_count: 0,
  warning_count: 0,
  created_at: "2026-01-01T00:00:00+00:00",
  updated_at: "2026-01-01T00:00:00+00:00",
};

test("paper library list client returns server paper summaries", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    assert.equal(init?.credentials, "include");
    return new Response(JSON.stringify({ papers: [paper] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    assert.deepEqual(await listPaperLibrary({ search: "Practice" }), [paper]);
    assert.equal(requestedUrl, "/api/v1/papers?search=Practice");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paper asset paths encode paper and nested image names", () => {
  assert.equal(
    paperAssetPath("paper/1", "figures/figure 1.png"),
    "/api/v1/papers/paper%2F1/assets/figures/figure%201.png",
  );
});

test("paper lifecycle client retries and deletes a paper", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ paper_id: "paper/1", status: "pending" }), {
      status: 200,
    });
  };

  try {
    await retryPaper("paper/1");
    await deletePaper("paper/1");
    assert.deepEqual(requests, [
      { url: "/api/v1/papers/paper%2F1/retry", method: "POST" },
      { url: "/api/v1/papers/paper%2F1", method: "DELETE" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paper library detail client loads and updates a question", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET" });
    if (init?.method === "PATCH") {
      return new Response(
        JSON.stringify({
          question_id: "q-1",
          question_number: "2",
          question_text: "Review me",
          options: {},
          question_type: "written",
          answer: "",
          images: [],
          is_multi_select: false,
          warnings: [],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ...paper, questions: [] }), { status: 200 });
  };

  try {
    const detail = await getPaperLibraryPaper("paper/1");
    assert.deepEqual(detail.questions, []);
    const updated = await updatePaperQuestion("paper/1", "q/1", {
      question_number: "2",
      answer: "",
    });
    assert.equal(updated.question_id, "q-1");
    assert.deepEqual(requests, [
      { url: "/api/v1/papers/paper%2F1", method: "GET" },
      {
        url: "/api/v1/papers/paper%2F1/questions/q%2F1",
        method: "PATCH",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
