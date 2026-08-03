import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(
  path.join(process.cwd(), "hooks/useRealtimeVoiceSession.ts"),
  "utf8",
);

test("soft interruption re-arms WebRTC audio even when the current turn finishes", () => {
  const start = source.indexOf(
    "softInterruptTimerRef.current = window.setTimeout",
  );
  const timer = source.slice(start, source.indexOf("}, 1200);", start));

  assert.doesNotMatch(
    timer,
    /if \(outputActiveRef\.current \|\| assistantPendingRef\.current\)/,
  );
  assert.match(timer, /remoteAudioRef\.current\.muted = false/);
  assert.match(timer, /void resumeRemoteAudio\(\)/);
});
