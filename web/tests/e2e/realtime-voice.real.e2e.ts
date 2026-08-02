import { expect, test } from "@playwright/test";

const realE2EEnabled = process.env.DEEPTUTOR_REALTIME_VOICE_REAL_E2E === "1";
const speechTimeout = Number.parseInt(
  process.env.DEEPTUTOR_REALTIME_VOICE_SPEECH_TIMEOUT_MS || "60000",
  10,
);

function waitForPreparedContext(
  page: import("@playwright/test").Page,
  minimumSourceCount: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Realtime context preparation timed out."));
    }, 30_000);
    const onSocket = (socket: import("@playwright/test").WebSocket) => {
      if (!socket.url().includes("/api/v1/voice/realtime")) return;
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        try {
          const message = JSON.parse(payload) as {
            type?: string;
            source_count?: number;
          };
          if (message.type !== "context_ready") return;
          if (Number(message.source_count || 0) < minimumSourceCount) {
            cleanup();
            reject(new Error("Realtime context omitted the selected source."));
            return;
          }
          cleanup();
          resolve();
        } catch {
          // Ignore unrelated control frames.
        }
      });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      page.off("websocket", onSocket);
    };
    page.on("websocket", onSocket);
  });
}

async function waitForVoiceTurn(
  page: import("@playwright/test").Page,
  mode: "delegated",
  userCount: number,
  assistantCount: number,
  previousAudioCount: number,
  prompt: string,
) {
  console.log(prompt);
  await expect(page.getByTestId("realtime-partial-transcript")).not.toHaveText("", {
    timeout: speechTimeout,
  });
  await expect(page.getByTestId("realtime-turn-mode")).toHaveAttribute(
    "data-mode",
    mode,
    { timeout: speechTimeout },
  );
  await expect(page.getByTestId("realtime-audio-output")).toHaveAttribute(
    "data-received",
    "true",
    { timeout: speechTimeout },
  );
  await expect
    .poll(
      async () =>
        Number(
          await page.getByTestId("realtime-audio-output").getAttribute("data-count"),
        ),
      { timeout: speechTimeout },
    )
    .toBeGreaterThan(previousAudioCount);
  await expect(page.getByTestId("chat-user-message")).toHaveCount(userCount, {
    timeout: speechTimeout,
  });
  await expect(page.getByTestId("chat-assistant-message")).toHaveCount(assistantCount, {
    timeout: speechTimeout,
  });
}

test.describe("Codex OAuth Realtime Voice — real environment", () => {
  test.skip(
    !realE2EEnabled,
    "Set DEEPTUTOR_REALTIME_VOICE_REAL_E2E=1 to run the billable real-provider test.",
  );

  test.use({ permissions: ["microphone"] });

  test("runs native delegated microphone turns with cancellation controls", async ({
    page,
  }) => {
    await page.goto("/settings/realtime-voice");

    const providerStatus = page.getByTestId("realtime-voice-provider-status");
    await expect(providerStatus).toContainText(/Connected/i, { timeout: 15_000 });
    await expect(page.getByTestId("realtime-voice-model")).toBeEnabled();
    await expect(page.getByTestId("realtime-voice-voice")).toBeEnabled();

    await page.goto("/home");
    await expect(page.getByRole("button", { name: "Record voice" })).toBeVisible();
    const start = page.getByRole("button", { name: "Start voice conversation" });
    await expect(start).toBeVisible();
    const generalContextReady = waitForPreparedContext(page, 0);
    await start.click();
    await generalContextReady;
    await expect(page.getByTestId("realtime-voice-bubble")).toBeVisible();

    const mute = page.getByTestId("realtime-mute");
    await expect(mute).toBeVisible({ timeout: 15_000 });
    await mute.click();
    await expect(mute).toHaveAttribute("aria-label", "Unmute microphone");
    await mute.click();
    await expect(mute).toHaveAttribute("aria-label", "Mute microphone");

    const audio = page.getByTestId("realtime-audio-output");
    const firstAudioCount = Number(await audio.getAttribute("data-count"));
    await waitForVoiceTurn(
      page,
      "delegated",
      1,
      1,
      firstAudioCount,
      "Speak exactly: What is two plus two? Even this basic question must use a native client delegation.",
    );

    // Speak over the next response if possible, then use the explicit interrupt
    // control. No media is injected; the operator supplies the real utterance.
    console.log(
      "For Barge-in: speak a short follow-up while the assistant is speaking, then click Interrupt voice response.",
    );
    const interrupt = page.getByTestId("realtime-interrupt");
    await expect(interrupt).toBeVisible();
    await interrupt.click();
    await expect(page.getByTestId("realtime-end")).toBeVisible();

    await page.getByTestId("realtime-end").click();
    await expect(page.getByRole("button", { name: "Start voice conversation" })).toBeVisible();

    // Select a real, authorized KB. The delegated prompt deliberately asks for
    // new retrieval; like every voice turn, it must use native delegation.
    const knowledgeSelector = page.getByTestId("knowledge-selector");
    await expect(knowledgeSelector).toBeVisible();
    await knowledgeSelector.click();
    const knowledgeOption = page.locator('[data-testid^="knowledge-option-"]').first();
    await expect(knowledgeOption).toBeVisible({ timeout: 15_000 });
    if ((await knowledgeOption.getAttribute("aria-pressed")) !== "true") {
      await knowledgeOption.click();
    }
    await expect(knowledgeOption).toHaveAttribute("aria-pressed", "true");

    const delegatedContextReady = waitForPreparedContext(page, 1);
    await start.click();
    await delegatedContextReady;
    await expect(mute).toBeVisible({ timeout: 15_000 });
    const delegatedAudioCount = Number(await audio.getAttribute("data-count"));
    await waitForVoiceTurn(
      page,
      "delegated",
      2,
      2,
      delegatedAudioCount,
      "Speak exactly: Use the selected knowledge base to answer a new question that is not in the loaded snapshot.",
    );

    // The same real session now exercises the delegated cancellation boundary.
    console.log(
      "For delegated Barge-in: speak over the answer if possible, then click Interrupt voice response.",
    );
    await expect(interrupt).toBeVisible();
    await interrupt.click();
    await page.getByTestId("realtime-end").click();
    await expect(page.getByRole("button", { name: "Start voice conversation" })).toBeVisible();
  });
});
