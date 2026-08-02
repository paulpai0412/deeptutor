import fs from "node:fs";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The coding-agent Chromium image may provide browser dependencies in a
// user-local extraction instead of the system loader path. Keep normal CI
// untouched, but make direct `npx playwright test` runs use that extraction
// when it is present.
const localBrowserLibDirs = [
  process.env.PLAYWRIGHT_LD_LIBRARY_PATH,
  "/tmp/playwright-libs/usr/lib/x86_64-linux-gnu",
  "/tmp/playwright-libs/lib/x86_64-linux-gnu",
].filter((directory): directory is string => Boolean(directory && fs.existsSync(directory)));
if (localBrowserLibDirs.length > 0) {
  const existing = process.env.LD_LIBRARY_PATH
    ?.split(path.delimiter)
    .filter(Boolean) ?? [];
  process.env.LD_LIBRARY_PATH = [
    ...new Set([...localBrowserLibDirs, ...existing]),
  ].join(path.delimiter);
}

const BASE_URL =
  process.env.WEB_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  "http://localhost:3000";
const SERIAL_MODE = process.env.PW_SERIAL === "1";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: !SERIAL_MODE,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: SERIAL_MODE ? 1 : undefined,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "ui-audit",
      testMatch: "**/*.audit.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "ui-e2e",
      testMatch: "**/*.e2e.ts",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
