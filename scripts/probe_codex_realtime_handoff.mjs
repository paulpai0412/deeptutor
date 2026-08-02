#!/usr/bin/env node

/**
 * Manual, real-environment Codex OAuth AVAS probe.
 *
 * Run this from Windows (or otherwise launch Chromium on the host that owns
 * the physical microphone), not from a WSL-only browser. The page uses the
 * real DeepTutor UI and same-origin WebSocket; this script intentionally does
 * not call page.route/page.routeWebSocket, inject media, or provide fixtures.
 *
 * Usage:
 *   DEEPTUTOR_REALTIME_PROBE=1 node scripts/probe_codex_realtime_handoff.mjs
 *
 * The operator must already be authenticated in DeepTutor and speaks one
 * complete sentence when prompted.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("../web/node_modules/playwright");

if (process.env.DEEPTUTOR_REALTIME_PROBE !== "1") {
  console.error(
    "Refusing to run a billable real probe. Set DEEPTUTOR_REALTIME_PROBE=1 explicitly.",
  );
  process.exit(2);
}

const baseUrl = process.env.WEB_BASE_URL || "http://localhost:3000";
const timeoutMs = Number.parseInt(
  process.env.DEEPTUTOR_REALTIME_PROBE_TIMEOUT_MS || "90000",
  10,
);

const browser = await chromium.launch({
  // Run headed by default so Windows uses the operator's microphone and the
  // operator can see the browser permission prompt.
  headless: process.env.HEADLESS === "1",
});
const context = await browser.newContext({ permissions: ["microphone"] });
const page = await context.newPage();

const waitForTextChange = async (testId, initialText) => {
  await page.waitForFunction(
    ({ testId: id, initial }) => {
      const value = document.querySelector(`[data-testid="${id}"]`)?.textContent || "";
      return value.trim() !== initial.trim();
    },
    { testId, initialText },
    { timeout: timeoutMs },
  );
};

try {
  await page.goto(`${baseUrl}/realtime-probe`, { waitUntil: "domcontentloaded" });
  if (/\/login(?:\/|$)/.test(new URL(page.url()).pathname)) {
    throw new Error("The browser is not authenticated; log in before running the probe.");
  }

  await page.waitForFunction(
    () => !document.querySelector('[data-testid="realtime-probe-start"]')?.disabled,
    undefined,
    { timeout: 15_000 },
  );
  await page.getByTestId("realtime-probe-start").click();
  await page.waitForFunction(
    () => {
      const state = document.querySelector('[data-testid="realtime-probe-status"]')?.textContent || "";
      return !state.includes("idle") && !state.includes("connecting");
    },
    undefined,
    { timeout: timeoutMs },
  );

  const initialTranscript = await page
    .getByTestId("realtime-probe-transcript")
    .textContent();
  console.log("Speak one complete sentence into the Windows physical microphone now.");
  await waitForTextChange(
    "realtime-probe-transcript",
    initialTranscript || "Speak one complete sentence after connecting.",
  );

  await page.getByTestId("realtime-probe-mute").click();
  await page.getByTestId("realtime-probe-mute").click();

  await page.waitForFunction(
    () => {
      const value = document.querySelector('[data-testid="realtime-probe-assistant"]')?.textContent || "";
      return value.trim() !== "No assistant response yet.";
    },
    undefined,
    { timeout: timeoutMs },
  );
  await page.waitForFunction(
    () => {
      const value = document.querySelector('[data-testid="realtime-probe-audio"]')?.textContent || "";
      return !value.includes("not received");
    },
    undefined,
    { timeout: timeoutMs },
  );

  await page.getByTestId("realtime-probe-interrupt").click();
  await page.getByTestId("realtime-probe-end").click();
  await page.waitForFunction(
    () => {
      const value = document.querySelector('[data-testid="realtime-probe-status"]')?.textContent || "";
      return value.includes("idle");
    },
    undefined,
    { timeout: 15_000 },
  );

  const status = await page.getByTestId("realtime-probe-status").textContent();
  const audio = await page.getByTestId("realtime-probe-audio").textContent();
  console.log(JSON.stringify({ status, audio }, null, 2));
  console.log(
    "PASS: Windows microphone -> Codex AVAS -> ChatOrchestrator -> assistant audio, with mute/interruption/end exercised.",
  );
} finally {
  await context.close();
  await browser.close();
}
