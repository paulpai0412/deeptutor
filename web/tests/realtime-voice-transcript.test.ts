import test from "node:test";
import assert from "node:assert/strict";

import { appendRealtimeTranscript } from "../lib/realtime-voice";

function collect(fragments: string[]): string {
  return fragments.reduce(appendRealtimeTranscript, "");
}

test("Realtime transcript accumulates character deltas into a sentence", () => {
  assert.equal(
    collect(["今", "天", "天", "氣", "很", "好", "。"]),
    "今天天氣很好。",
  );
});

test("Realtime transcript preserves provider spacing between English deltas", () => {
  assert.equal(
    collect(["Hello", " ", "world", ",", " how", " are", " you", "?"]),
    "Hello world, how are you?",
  );
});

test("Realtime transcript accepts cumulative snapshots without duplicating text", () => {
  assert.equal(
    collect(["A longer", "A longer sentence", "A longer sentence."]),
    "A longer sentence.",
  );
});
