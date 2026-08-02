import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveOutgoingParentIds } from "../lib/message-branches";

test("Realtime Voice omits a stale persisted parent and lets the server append", () => {
  assert.deepEqual(resolveOutgoingParentIds(595, undefined, true), {
    localParentId: 595,
    wireParentId: undefined,
  });
});

test("normal and edited turns keep their explicit branch parents", () => {
  assert.deepEqual(resolveOutgoingParentIds(595, undefined, false), {
    localParentId: 595,
    wireParentId: 595,
  });
  assert.deepEqual(resolveOutgoingParentIds(595, null, false), {
    localParentId: null,
    wireParentId: null,
  });
});

test("Realtime transcript turns request server-side linear append", () => {
  const source = readFileSync(
    path.join(process.cwd(), "components/chat/home/ChatComposer.tsx"),
    "utf8",
  );
  const realtimeHandler = source.slice(
    source.indexOf("const handleRealtimeTurn"),
    source.indexOf("const handleRealtimeSessionReady"),
  );
  assert.match(realtimeHandler, /appendToLatest:\s*true/);
});
