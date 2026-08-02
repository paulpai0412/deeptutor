import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import RealtimeVoiceControl from "../components/chat/home/RealtimeVoiceControl";
import { AppShellProvider } from "../context/AppShellContext";

void i18n.use(initReactI18next).init({
  lng: "en",
  resources: { en: { translation: {} } },
  initImmediate: false,
});

const noop = () => {};

function render(state: "idle" | "listening" | "speaking") {
  // AppShellProvider supplies the pet preference (SSR default: codex), which
  // the bubble needs for its voice-session pet avatar.
  return renderToStaticMarkup(
    createElement(
      AppShellProvider,
      null,
      createElement(RealtimeVoiceControl, {
        state,
        transcript:
          state === "idle"
            ? ""
            : "This is a complete sentence shown inside the voice bubble.",
        error: null,
        audioOutputReceived: state === "speaking",
        audioOutputCount: state === "speaking" ? 1 : 0,
        lastTurnMode: null,
        disabled: false,
        onToggle: noop,
        onToggleMute: noop,
        onInterrupt: noop,
        onEnd: noop,
      }),
    ),
  );
}

test("Realtime Voice is one dedicated composer entry and opens a single bubble", () => {
  const idle = render("idle");
  assert.match(idle, /data-testid="realtime-voice-toggle"/);
  assert.doesNotMatch(idle, /data-testid="realtime-voice-bubble"/);

  const active = render("listening");
  assert.match(active, /data-testid="realtime-voice-bubble"/);
  assert.match(active, /data-testid="realtime-mute"/);
  assert.match(active, /data-testid="realtime-end"/);
  assert.match(active, /This is a complete sentence shown inside the voice bubble/);
});

test("Realtime Voice bubble exposes interruption only while assistant output is active", () => {
  assert.doesNotMatch(render("listening"), /data-testid="realtime-interrupt"/);
  assert.match(render("speaking"), /data-testid="realtime-interrupt"/);
});
