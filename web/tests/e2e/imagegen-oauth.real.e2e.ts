import { expect, test } from "@playwright/test";

const enabled = process.env.IMAGEGEN_REAL_E2E === "1";

test.describe("real Codex OAuth image generation", () => {
  test.skip(
    !enabled,
    "Set IMAGEGEN_REAL_E2E=1 to run the opt-in, billable integration test.",
  );
  test.setTimeout(240_000);

  test("configures Image Generation and renders a real Chat artifact", async ({
    page,
  }) => {
    await page.goto("/settings/image");
    await expect(page.locator("select").first()).toHaveValue(/openai|openai_codex/);

    await page.locator("select").first().selectOption("openai_codex");
    await expect(
      page.getByText(/Codex OAuth.*(Connected|已連線)/i),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByPlaceholder("style (e.g. vivid)")).toHaveCount(0);

    await page.locator('input[placeholder="gpt-4o"]').fill("gpt-5.5");
    await page.getByPlaceholder("1024x1024").fill("1024x1024");
    await page.getByPlaceholder("quality (e.g. hd)").fill("high");

    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/v1/settings/apply",
      ),
      page.getByRole("button", { name: /^(Apply|套用|应用)$/ }).click(),
    ]);

    const runTest = page.getByRole("button", {
      name: /^(Run test|運行測試|執行測試)$/,
    });
    await runTest.click();
    await expect(
      page.locator("pre").filter({
        hasText: "IMAGEGEN test completed successfully.",
      }),
    ).toBeVisible({ timeout: 180_000 });
    await expect(
      page.locator(
        'main img[alt$=".png"], main img[alt$=".jpg"], main img[alt$=".jpeg"], main img[alt$=".webp"]',
      ),
    ).toHaveCount(0);

    const toolsLoaded = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/tools" &&
        response.request().method() === "GET",
    );
    await page.goto("/home");
    await toolsLoaded;
    // Let the resolved user toggle set flow through the chat state before the
    // send snapshot is created; otherwise a fast browser can submit [] tools.
    await page.waitForTimeout(750);
    const composer = page.locator("textarea").first();
    await expect(composer).toBeVisible({ timeout: 30_000 });

    await composer.fill(
      "Generate exactly one image with the imagegen tool: a small blue book on a white desk, clean educational illustration. Return the image artifact, not a text-only description.",
    );
    await page.getByRole("button", { name: /^(Send|送出|发送)$/ }).click();

    const generatedImage = page
      .locator(
        'main img[alt$=".png"], main img[alt$=".jpg"], main img[alt$=".jpeg"], main img[alt$=".webp"]',
      )
      .first();
    await expect(generatedImage).toBeVisible({ timeout: 210_000 });
    await expect
      .poll(
        () =>
          generatedImage.evaluate((image) => {
            const loaded = image as HTMLImageElement;
            return {
              complete: loaded.complete,
              naturalWidth: loaded.naturalWidth,
              naturalHeight: loaded.naturalHeight,
            };
          }),
        { timeout: 30_000 },
      )
      .toMatchObject({ complete: true });
    await expect
      .poll(() =>
        generatedImage.evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);

    await page.screenshot({
      path:
        process.env.IMAGEGEN_REAL_E2E_SCREENSHOT ||
        "test-results/imagegen-oauth-real-chat.png",
      fullPage: true,
    });
  });
});
