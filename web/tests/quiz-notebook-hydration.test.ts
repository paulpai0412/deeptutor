import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Regression test for the Question Bank lookup storm (issue #33): every
// mounted historical QuizViewer re-fired N lookup requests on each parent
// re-render because ``questions`` gets a new array identity whenever the
// streamed message content is re-parsed. One measured voice session issued
// 712 lookup requests. The hydration effect must run once per
// (session, turn, question-set) signature instead.

const source = readFileSync(
  path.join(process.cwd(), "components/quiz/QuizViewer.tsx"),
  "utf8",
);

test("QuizViewer hydrates notebook entries once per question-set signature", () => {
  const effectStart = source.indexOf("const hydratedForRef = useRef('')");
  assert.notEqual(effectStart, -1, "hydration guard ref is missing");
  const effect = source.slice(effectStart, source.indexOf("handleToggleBookmark"));
  assert.match(effect, /if \(hydratedForRef\.current === signature\) return/);
  assert.match(effect, /hydratedForRef\.current = signature/);
  assert.match(effect, /sessionId, turnId, questions, refreshEntryId/);
  // The unguarded form must be gone: no effect may loop over questions for
  // lookups without the signature check.
  assert.equal(
    source.includes("}, [sessionId, questions, refreshEntryId])"),
    false,
    "unguarded hydration effect is still present",
  );
});
