import test from "node:test";
import assert from "node:assert/strict";

import {
  appendRealtimeTranscript,
  reduceRealtimeVoiceTranscript,
} from "../lib/realtime-voice";

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

test("provider-owned final transcripts stay in GPT-Live instead of starting DeepTutor", () => {
  const result = reduceRealtimeVoiceTranscript(undefined, {
    type: "transcript",
    phase: "final",
    mode: "provider",
    provider_turn_id: "provider-user-1",
    text: "答案 C",
  });

  assert.equal(result.action, "none");
  assert.equal(result.state.userFinal, "答案 C");
  assert.equal(result.state.userTurnId, "provider-user-1");
  assert.equal(result.state.userMode, "provider");
});

test("only delegated final transcripts request a DeepTutor turn", () => {
  const result = reduceRealtimeVoiceTranscript(undefined, {
    type: "transcript",
    phase: "final",
    mode: "delegated",
    handoff_id: "delegation-1",
    text: "Search the selected textbook",
  });

  assert.equal(result.action, "delegate");
  assert.equal(result.state.userFinal, "Search the selected textbook");
  assert.equal(result.state.userMode, "delegated");
});

test("assistant transcript is the visible record of GPT-Live speech", () => {
  const partial = reduceRealtimeVoiceTranscript(undefined, {
    type: "assistant_transcript",
    phase: "partial",
    text: "下一題",
  });
  const final = reduceRealtimeVoiceTranscript(partial.state, {
    type: "assistant_transcript",
    phase: "final",
    provider_turn_id: "provider-assistant-1",
    text: "下一題是什麼？",
  });

  assert.equal(final.action, "none");
  assert.equal(final.state.assistantText, "下一題是什麼？");
  assert.equal(final.state.assistantTurnId, "provider-assistant-1");
  assert.equal(final.state.assistantFinal, true);
});
