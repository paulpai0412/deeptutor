import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

type PaperRecord = {
  paper_id: string;
  display_name: string;
  original_filename: string;
  source_hash: string;
  status: string;
  question_count: number;
  warning_count: number;
  error?: string;
  warnings?: string[];
  library_id?: string;
};

type PaperQuestion = {
  question_id: string;
  question_number: string;
  question_text: string;
  question_type: string;
  options: Record<string, string>;
  answer: string;
  images: string[];
  page?: number | null;
};

type PaperDetail = PaperRecord & {
  questions: PaperQuestion[];
};

type LibrarySummary = {
  library_id: string;
  name: string;
  description?: string;
  settings?: Record<string, unknown>;
  paper_count: number;
};

const defaultPdfPath = path.resolve(
  process.cwd(),
  "../tests/01-115國中社會2上歷史平時測驗卷-L01-商周至隋唐時期的國家與社會-PDF教用(115f318345).pdf",
);
const pdfPath = process.env.PAPER_E2E_PDF || defaultPdfPath;
const pdfFilename = path.basename(pdfPath);
const screenshotDir = path.resolve(
  process.cwd(),
  "../docs/sop/assets/knowledge-center-exam-e2e",
);

function capture(page: Page, name: string) {
  fs.mkdirSync(screenshotDir, { recursive: true });
  return page.screenshot({
    path: path.join(screenshotDir, `${name}.png`),
    fullPage: true,
  });
}

function terminalPaperStatus(status: string): boolean {
  return ["ready", "ready_with_warnings", "partial", "failed"].includes(status);
}

async function getLibrary(page: Page, libraryId: string): Promise<LibrarySummary> {
  const response = await page.request.get(`/api/v1/papers/libraries/${libraryId}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as LibrarySummary;
}

async function getPaper(
  page: Page,
  libraryId: string,
  paperId: string,
): Promise<PaperRecord> {
  const response = await page.request.get(
    `/api/v1/papers/libraries/${libraryId}/papers`,
  );
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { papers: PaperRecord[] };
  const paper = body.papers.find((item) => item.paper_id === paperId);
  expect(paper, `paper ${paperId} was not listed in library ${libraryId}`).toBeTruthy();
  return paper as PaperRecord;
}

async function waitForPaper(
  page: Page,
  libraryId: string,
  paperId: string,
  timeoutMs = 15 * 60 * 1000,
): Promise<PaperRecord> {
  const deadline = Date.now() + timeoutMs;
  let latest: PaperRecord | undefined;
  while (Date.now() < deadline) {
    latest = await getPaper(page, libraryId, paperId);
    if (terminalPaperStatus(latest.status)) break;
    await page.waitForTimeout(2_000);
  }
  expect(latest, "paper polling did not return a record").toBeTruthy();
  expect(
    latest?.status,
    `paper extraction did not finish: ${latest?.error ?? ""}`,
  ).toEqual(expect.stringMatching(/^(ready|ready_with_warnings|partial)$/));
  expect(latest?.question_count).toBeGreaterThan(1);
  return latest as PaperRecord;
}

function answerKey(question: PaperQuestion): string {
  const answer = question.answer.trim();
  if (question.options[answer]) return answer;
  const keyPrefix = answer.match(/^([A-Za-z])(?:\s|\(|$)/)?.[1];
  if (keyPrefix && question.options[keyPrefix]) return keyPrefix;
  const match = Object.entries(question.options).find(
    ([, value]) => value.trim().toLocaleLowerCase() === answer.toLocaleLowerCase(),
  );
  return match?.[0] || Object.keys(question.options)[0] || answer;
}

async function waitForJudgment(page: Page, entryId: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5 * 60 * 1000;
  let entry: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = await page.request.get(
      `/api/v1/question-notebook/entries/${entryId}`,
    );
    expect(response.status()).toBe(200);
    entry = (await response.json()) as Record<string, unknown>;
    if (typeof entry.ai_judgment === "string" && entry.ai_judgment.trim()) return entry;
    await page.waitForTimeout(1_000);
  }
  expect(entry.ai_judgment, "AI Judge did not persist a judgment").toEqual(
    expect.stringMatching(/\S/),
  );
  return entry;
}

test("ordinary Quiz exposes only Custom and Mimic Paper modes", async ({ page }) => {
  await page.goto("/home");
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByText("Quiz", { exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Custom", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mimic Paper", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Original Paper", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Mimic Paper", exact: true }).click();
  await expect(page.getByText("Parsed Dir", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Quiz", exact: true }).click();
  await page.getByText("Exam", { exact: true }).last().click();
  await expect(
    page.getByRole("button", { name: "Paper Library", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Select knowledge bases", exact: true }),
  ).toHaveCount(0);
});

test.describe("Knowledge Center → Paper Library → Exam :: real release flow", () => {
  test("keeps source history after review, move, judge, and library deletion", async ({
    page,
  }) => {
    test.skip(
      process.env.PAPER_REAL_E2E !== "1",
      "Set PAPER_REAL_E2E=1 to run the real PDF/LLM/browser flow.",
    );
    test.setTimeout(40 * 60 * 1000);
    expect(fs.existsSync(pdfPath), `real PDF does not exist: ${pdfPath}`).toBe(true);

    const wsFrames: string[] = [];
    page.on("websocket", (socket) => {
      socket.on("framesent", (data) => {
        wsFrames.push(
          typeof data === "string" ? data : JSON.stringify(data),
        );
      });
    });

    await page.goto("/space/questions");
    await page.getByRole("tab", { name: "Paper Libraries" }).click();
    await expect(page.getByRole("heading", { name: "Paper Libraries" })).toBeVisible();
    await capture(page, "01-knowledge-center-paper-libraries");

    const suffix = Date.now().toString(36);
    const libraryName = `Real E2E Exam ${suffix}`;
    const [libraryResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/v1/papers/libraries",
      ),
      page.getByPlaceholder("Library name").fill(libraryName).then(() =>
        page.getByRole("button", { name: "Create", exact: true }).click(),
      ),
    ]);
    expect(libraryResponse.status()).toBe(201);
    const library = (await libraryResponse.json()) as LibrarySummary;
    expect(library.name).toBe(libraryName);
    await expect(page.getByRole("heading", { name: libraryName })).toBeVisible();

    const llmSelect = page.getByRole("combobox", { name: "Extraction LLM" });
    const parserSelect = page.getByRole("combobox", { name: "PDF parser" });
    await expect(llmSelect).toBeVisible();
    await expect(parserSelect).toBeVisible();
    const llmValue = await llmSelect.locator("option").evaluateAll((options) => {
      const option = options.find((item) => (item as HTMLOptionElement).value);
      return option ? (option as HTMLOptionElement).value : "";
    });
    expect(llmValue, "the real extraction LLM option list was empty").not.toBe("");
    await llmSelect.selectOption(llmValue);
    const parserValue = await parserSelect.locator("option").evaluateAll((options) => {
      const preferred = options.find(
        (item) => (item as HTMLOptionElement).value === "pymupdf4llm",
      );
      return preferred
        ? (preferred as HTMLOptionElement).value
        : (options.find((item) => (item as HTMLOptionElement).value) as
            | HTMLOptionElement
            | undefined)?.value || "";
    });
    expect(parserValue, "the real parser option list was empty").not.toBe("");
    await parserSelect.selectOption(parserValue);
    const [settingsResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          new URL(response.url()).pathname ===
            `/api/v1/papers/libraries/${library.library_id}`,
      ),
      page.getByRole("button", { name: "Save settings", exact: true }).click(),
    ]);
    expect(settingsResponse.status()).toBe(200);
    const configuredLibrary = await getLibrary(page, library.library_id);
    expect(configuredLibrary.settings?.parser_engine).toBe(parserValue);
    expect(configuredLibrary.settings?.failure_policy).toBe("keep_partial");
    expect(configuredLibrary.settings?.llm_selection).toEqual(
      expect.objectContaining({
        profile_id: llmValue.split(":")[0],
        model_id: llmValue.split(":")[1],
      }),
    );
    await capture(page, "02-library-extraction-settings");

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(pdfPath);
    await expect(page.getByText(pdfFilename, { exact: true })).toBeVisible();
    await capture(page, "03-real-pdf-selected");
    const [uploadResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            `/api/v1/papers/libraries/${library.library_id}/upload`,
      ),
      page.getByRole("button", { name: "Upload PDFs", exact: true }).click(),
    ]);
    expect(uploadResponse.status()).toBe(200);
    const uploadBody = (await uploadResponse.json()) as { papers: PaperRecord[] };
    expect(uploadBody.papers.length).toBe(1);
    const paperId = uploadBody.papers[0].paper_id;
    await capture(page, "04-upload-submitted");

    const initialRow = page.locator("li").filter({ hasText: pdfFilename }).first();
    await expect(initialRow).toBeVisible({ timeout: 30_000 });
    const firstReady = await waitForPaper(page, library.library_id, paperId);
    expect(firstReady.library_id).toBe(library.library_id);
    await expect(initialRow).toContainText(/Paper ready|Paper partially ready/);
    await capture(page, "05-paper-ready-after-llm-extraction");

    page.once("dialog", (dialog) => dialog.accept());
    const [retryResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            `/api/v1/papers/libraries/${library.library_id}/papers/${paperId}/retry`,
      ),
      initialRow.getByRole("button", { name: "Retry", exact: true }).click(),
    ]);
    expect(retryResponse.status()).toBe(200);
    await waitForPaper(page, library.library_id, paperId);
    await capture(page, "06-retry-complete");

    const renamedName = `Renamed ${pdfFilename}`;
    await initialRow.getByTitle("Rename").click();
    const renameInput = initialRow.locator("input").first();
    await renameInput.fill(renamedName);
    const [renameResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          new URL(response.url()).pathname ===
            `/api/v1/papers/libraries/${library.library_id}/papers/${paperId}`,
      ),
      initialRow.getByRole("button", { name: "Save", exact: true }).click(),
    ]);
    expect(renameResponse.status()).toBe(200);
    await expect(initialRow).toContainText(renamedName);

    const detailResponse = await page.request.get(`/api/v1/papers/${paperId}`);
    expect(detailResponse.status()).toBe(200);
    let detail = (await detailResponse.json()) as PaperDetail;
    expect(detail.questions.length).toBeGreaterThan(1);
    expect(detail.questions.map((question) => question.question_id)).not.toEqual(
      detail.questions.map(() => ""),
    );

    await initialRow.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByRole("button", { name: "Back to Paper Library" })).toBeVisible();
    const imageQuestion = detail.questions.find((question) => question.images.length > 0);
    expect(
      imageQuestion,
      "the real extraction did not associate an image; run with a real image-bearing PDF via PAPER_E2E_PDF",
    ).toBeTruthy();
    const correctionQuestion = imageQuestion ?? detail.questions[0];
    const correctedNumber = `${correctionQuestion.question_number}-reviewed`;
    const correctedAnswer = `${correctionQuestion.answer || "reviewed"} (verified)`;
    const correctionItem = page
      .locator("ol > li")
      .filter({ hasText: correctionQuestion.question_text })
      .first();
    await expect(correctionItem).toBeVisible();
    await correctionItem.locator("input").first().fill(correctedNumber);
    await correctionItem.locator("textarea").first().fill(correctedAnswer);
    const [correctionResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          new URL(response.url()).pathname.includes(
            `/api/v1/papers/libraries/${library.library_id}/papers/${paperId}/questions/`,
          ),
      ),
      correctionItem.getByRole("button", { name: "Save correction", exact: true }).click(),
    ]);
    expect(correctionResponse.status()).toBe(200);
    const correctionBody = (await correctionResponse.json()) as PaperQuestion;
    expect(correctionBody.question_number).toBe(correctedNumber);
    expect(correctionBody.answer).toBe(correctedAnswer);

    const removedImage = imageQuestion?.images[0] as string;
    const imageItem = page
      .locator("ol > li")
      .filter({ hasText: imageQuestion?.question_text ?? "" })
      .first();
    const imageFigure = imageItem.locator("figure").first();
    await expect(imageFigure.locator("img")).toBeVisible();
    const [unlinkResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" &&
          new URL(response.url()).pathname.includes(
            `/api/v1/papers/libraries/${library.library_id}/papers/${paperId}/questions/`,
          ),
      ),
      imageFigure.getByRole("button", { name: "Remove", exact: true }).click({ force: true }),
    ]);
    expect(unlinkResponse.status()).toBe(200);
    const unlinkBody = (await unlinkResponse.json()) as PaperQuestion;
    expect(unlinkBody.images).not.toContain(removedImage);
    detail = {
      ...detail,
      questions: detail.questions.map((question) =>
        question.question_id === correctionQuestion.question_id
          ? { ...question, question_number: correctedNumber, answer: correctedAnswer, images: [] }
          : question,
      ),
    };
    await capture(page, "07-paper-review-corrected-and-image-unlinked");
    await page.getByRole("button", { name: "Back to Paper Library" }).click();
    await expect(page.getByRole("heading", { name: libraryName })).toBeVisible();

    const archiveName = `Archive ${suffix}`;
    const [archiveResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/v1/papers/libraries",
      ),
      page.getByPlaceholder("Library name").fill(archiveName).then(() =>
        page.getByRole("button", { name: "Create", exact: true }).click(),
      ),
    ]);
    expect(archiveResponse.status()).toBe(201);
    const archive = (await archiveResponse.json()) as LibrarySummary;
    await page.locator("aside button").filter({ hasText: libraryName }).click();
    const paperRow = page.locator("li").filter({ hasText: renamedName }).first();
    await expect(paperRow).toBeVisible();
    const moveSelect = paperRow.getByRole("combobox", { name: "Move paper" });
    const [moveResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            `/api/v1/papers/libraries/${library.library_id}/papers/${paperId}/move`,
      ),
      moveSelect.selectOption(archive.library_id),
    ]);
    expect(moveResponse.status()).toBe(200);
    const moved = (await moveResponse.json()) as PaperRecord;
    expect(moved.paper_id).toBe(paperId);
    expect(moved.library_id).toBe(archive.library_id);
    await expect(paperRow).toHaveCount(0);
    await page.locator("aside button").filter({ hasText: archiveName }).click();
    const movedRow = page.locator("li").filter({ hasText: renamedName }).first();
    await expect(movedRow).toBeVisible();
    await capture(page, "08-paper-moved-to-archive-library");

    await movedRow.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByRole("button", { name: "Start Exam", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start Exam", exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/home\\?exam_paper_id=${paperId}&exam_library_id=${archive.library_id}`),
    );
    await expect(page.getByText("Exam settings")).toBeVisible();
    const examLibrarySelect = page.getByRole("combobox", { name: "Paper Library" });
    const examPaperSelect = page.getByRole("combobox", { name: "Exam paper" });
    await expect(examLibrarySelect).toHaveValue(archive.library_id);
    await expect(examPaperSelect).toHaveValue(paperId);
    await expect(page.getByText("Count", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Difficulty", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Type", { exact: true })).toHaveCount(0);
    await capture(page, "09-exam-library-to-paper-picker");

    await expect(
      page.getByRole("button", { name: "Paper Library", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(page).toHaveURL(/\/home\/[^?]+$/, { timeout: 60_000 });
    await expect(page.getByText(detail.questions[0].question_text)).toBeVisible({
      timeout: 15 * 60 * 1000,
    });
    const sentPayload = wsFrames.join("\n");
    expect(sentPayload).toContain(paperId);
    expect(sentPayload).not.toContain(pdfPath);
    expect(sentPayload).not.toContain("source_path");
    await capture(page, "10-exam-first-question-snapshot-source-card");

    const firstQuestion = detail.questions[0];
    if (firstQuestion.question_type === "choice" && Object.keys(firstQuestion.options).length) {
      const key = answerKey(firstQuestion);
      await page
        .locator("button")
        .filter({ hasText: firstQuestion.options[key] || key })
        .first()
        .click({ force: true });
    } else if (firstQuestion.question_type === "concept") {
      await page
        .getByRole("button", {
          name: firstQuestion.answer.trim().toLowerCase() === "false" ? "False" : "True",
          exact: true,
        })
        .click({ force: true });
    } else {
      await page.locator("textarea").last().fill(firstQuestion.answer || "real answer");
    }
    await capture(page, "11-exam-answer-selected");
    const [entryResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith("/api/v1/question-notebook/entries/upsert"),
      ),
      page.getByRole("button", { name: "Check Answer", exact: true }).click(),
    ]);
    expect(entryResponse.status()).toBe(200);
    const entry = (await entryResponse.json()) as {
      id: number;
      source_type: string;
      paper_library_id: string;
      paper_library_name: string;
      paper_id: string;
      paper_display_name: string;
      source_question_number: string;
      source_snapshot_id: string;
      ai_judgment?: string;
    };
    expect(entry.source_type).toBe("original_paper");
    expect(entry.paper_library_id).toBe(archive.library_id);
    expect(entry.paper_library_name).toBe(archive.name);
    expect(entry.paper_id).toBe(paperId);
    expect(entry.paper_display_name).toBe(renamedName);
    expect(entry.source_question_number).toBe(firstQuestion.question_number);
    expect(entry.source_snapshot_id).not.toBe("");
    await expect(page.getByText(detail.questions[1].question_text)).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(page.getByText(firstQuestion.question_text)).toBeVisible();
    await capture(page, "12-exam-answer-saved-question-bank-provenance");

    const judgeButton = page.getByRole("button", { name: "AI Judge", exact: true });
    await expect(judgeButton).toBeVisible();
    await judgeButton.click();
    await expect(page.getByRole("button", { name: "Judging...", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Re-judge", exact: true })).toBeVisible({
      timeout: 5 * 60 * 1000,
    });
    const judgedEntry = await waitForJudgment(page, entry.id);
    expect(String(judgedEntry.ai_judgment)).toMatch(/\S/);
    await capture(page, "13-exam-ai-judge-result");

    await page.getByRole("button", { name: "Next", exact: true }).click({ force: true });
    await expect(page.getByText(detail.questions[1].question_text)).toBeVisible();
    await page.getByRole("button", { name: "Previous", exact: true }).click({ force: true });
    await expect(page.getByText(detail.questions[0].question_text)).toBeVisible();

    const imageQuestionIndex = detail.questions.findIndex(
      (question) => question.images.length > 0 && question.question_id !== correctionQuestion.question_id,
    );
    expect(
      imageQuestionIndex,
      "the real Exam snapshot needs an image association left after Review unlink",
    ).toBeGreaterThan(-1);
    await page
      .getByRole("button", { name: String(imageQuestionIndex + 1), exact: true })
      .click({ force: true });
    const snapshotImage = page.locator('img[alt^="Original Paper image"]').first();
    await expect(snapshotImage).toBeVisible();
    const snapshotImageSrc = await snapshotImage.getAttribute("src");
    expect(snapshotImageSrc).toMatch(/\/api\/attachments\//);
    await capture(page, "14-exam-snapshot-image-before-delete");

    const sessionUrl = page.url();
    await page.goto("/knowledge?tab=papers");
    await page.locator("aside button").filter({ hasText: archiveName }).click();
    await expect(page.getByRole("heading", { name: archiveName })).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    const [deleteLibraryResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === "DELETE" &&
          new URL(response.url()).pathname ===
            `/api/v1/papers/libraries/${archive.library_id}`,
      ),
      page.getByRole("button", { name: "Delete library", exact: true }).click(),
    ]);
    expect(deleteLibraryResponse.status()).toBe(200);
    expect((await page.request.get(`/api/v1/papers/${paperId}`)).status()).toBe(404);
    expect(
      (await page.request.get(`/api/v1/papers/libraries/${archive.library_id}`)).status(),
    ).toBe(404);
    const persistedEntryResponse = await page.request.get(
      `/api/v1/question-notebook/entries/${entry.id}`,
    );
    expect(persistedEntryResponse.status()).toBe(200);
    const persistedEntry = (await persistedEntryResponse.json()) as Record<string, unknown>;
    expect(persistedEntry.paper_library_id).toBe(archive.library_id);
    expect(persistedEntry.paper_id).toBe(paperId);
    expect(persistedEntry.source_snapshot_id).toBe(entry.source_snapshot_id);
    expect(String(persistedEntry.ai_judgment)).toMatch(/\S/);
    const attachmentResponse = await page.request.get(snapshotImageSrc as string);
    expect(attachmentResponse.status()).toBe(200);

    await page.goto(sessionUrl);
    await expect(page.getByText(detail.questions[0].question_text)).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByTitle("Click to rename session").getByText("Exam", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "AI Judgment", exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: String(imageQuestionIndex + 1), exact: true })
      .click({ force: true });
    await expect(page.locator('img[alt^="Original Paper image"]').first()).toBeVisible();
    await capture(page, "15-history-readable-after-library-delete");
  });
});
