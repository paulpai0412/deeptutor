import { expect, test, type Page } from "@playwright/test";

const BASE_URL =
  process.env.WEB_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  "http://localhost:3000";

const json = (body: unknown, status = 200) => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

type FixturePaper = {
  paper_id: string;
  display_name: string;
  original_filename: string;
  source_hash: string;
  status: string;
  question_count: number;
  warning_count: number;
  created_at: string;
  updated_at: string;
  library_id: string;
  folder_path: string;
  progress?: { percent?: number; stage?: string; message?: string };
  warnings?: string[];
  error?: string;
};

type FixtureState = {
  libraries: Array<Record<string, unknown>>;
  papers: FixturePaper[];
  folders: string[];
  uploadCount: number;
  uploadPolls: number;
  saveFails: boolean;
};

function makePaper(
  paperId: string,
  name: string,
  status: string,
  folderPath = "",
): FixturePaper {
  return {
    paper_id: paperId,
    display_name: name,
    original_filename: name,
    source_hash: `hash-${paperId}`,
    status,
    question_count: status === "pending" || status === "processing" ? 0 : 2,
    warning_count: status === "ready_with_warnings" ? 1 : 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    library_id: "library-1",
    folder_path: folderPath,
    progress:
      status === "processing"
        ? { stage: "processing", percent: 42, message: "Parsing" }
        : undefined,
    warnings: status === "ready_with_warnings" ? ["Check source page"] : [],
    error: status === "failed" ? "Extraction failed; retry this paper." : "",
  };
}

async function installFixture(
  page: Page,
  initial: Partial<FixtureState> = {},
): Promise<FixtureState> {
  const state: FixtureState = {
    libraries: [
      {
        library_id: "library-1",
        name: "Fixture Papers",
        description: "Deterministic Paper Library fixture.",
        settings: { failure_policy: "keep_partial" },
        folders: [],
        paper_count: 0,
      },
    ],
    papers: [],
    folders: [],
    uploadCount: 0,
    uploadPolls: 0,
    saveFails: false,
    ...initial,
  };

  await page.route("**/api/v1/knowledge/list", (route) =>
    route.fulfill(json([])),
  );
  await page.route("**/api/v1/knowledge/rag-providers", (route) =>
    route.fulfill(json({ providers: [] })),
  );
  await page.route("**/api/v1/knowledge/supported-file-types", (route) =>
    route.fulfill(
      json({
        extensions: [".pdf"],
        accept: ".pdf,application/pdf",
        max_file_size_bytes: 200 * 1024 * 1024,
      }),
    ),
  );
  await page.route("**/api/v1/papers/libraries/options", (route) =>
    route.fulfill(
      json({
        llm: {
          active: { profile_id: "profile-1", model_id: "model-1" },
          options: [
            {
              profile_id: "profile-1",
              model_id: "model-1",
              profile_name: "Fixture profile",
              model_name: "Fixture model",
              model: "fixture-model",
            },
          ],
        },
        parsers: [
          {
            id: "text_only",
            name: "Text only",
            description: "Deterministic parser",
            available: true,
          },
        ],
        failure_policies: [{ id: "keep_partial", label: "Keep usable questions" }],
        llm_required: true,
      }),
    ),
  );

  await page.route("**/api/v1/papers/libraries", async (route) => {
    if (route.request().method() === "POST") {
      const created = {
        ...state.libraries[0],
        library_id: "library-1",
        name: "Created Fixture Library",
        description: "Created by the audit.",
      };
      state.libraries = [created];
      await route.fulfill(json(created, 201));
      return;
    }
    await route.fulfill(json({ libraries: state.libraries }));
  });

  await page.route("**/api/v1/papers/libraries/library-1", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = JSON.parse(route.request().postData() || "{}");
      const updated = {
        ...state.libraries[0],
        name: body.name ?? state.libraries[0].name,
        description: body.description ?? state.libraries[0].description,
        settings: body.settings ?? state.libraries[0].settings,
      };
      state.libraries = [updated];
      await route.fulfill(json(updated));
      return;
    }
    if (route.request().method() === "DELETE") {
      state.libraries = [];
      state.papers = [];
      state.folders = [];
      await route.fulfill(json({ deleted: true, library_id: "library-1" }));
      return;
    }
    await route.fulfill(json(state.libraries[0]));
  });

  await page.route(
    "**/api/v1/papers/libraries/library-1/folders",
    async (route) => {
      if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        const path = [body.parent_path, String(body.name).trim()]
          .filter(Boolean)
          .join("/");
        if (path.includes("..") || String(body.name).includes("/")) {
          await route.fulfill(json({ detail: "Paper Folder name is invalid." }, 400));
          return;
        }
        if (
          state.folders.some(
            (folder) => folder.toLowerCase() === path.toLowerCase(),
          )
        ) {
          await route.fulfill(
            json({ detail: "Paper Folder name already exists in this folder." }, 400),
          );
          return;
        }
        state.folders.push(path);
        await route.fulfill(json({ path }, 201));
        return;
      }
      await route.fulfill(json({ folders: state.folders }));
    },
  );

  await page.route(
    "**/api/v1/papers/libraries/library-1/papers*",
    async (route) => {
      const requestUrl = new URL(route.request().url());
      if (state.uploadCount === 1 && state.uploadPolls++ >= 0) {
        state.papers = state.papers.map((paper) =>
          paper.paper_id === "upload-root"
            ? makePaper("upload-root", "root.pdf", "ready")
            : paper,
        );
      }
      const search = (requestUrl.searchParams.get("search") || "").toLowerCase();
      const status = requestUrl.searchParams.get("status") || "";
      const papers = state.papers.filter((paper) => {
        const matchesSearch =
          !search ||
          paper.display_name.toLowerCase().includes(search) ||
          paper.original_filename.toLowerCase().includes(search);
        return matchesSearch && (!status || paper.status === status);
      });
      await route.fulfill(json({ papers, folders: state.folders }));
    },
  );

  await page.route("**/api/v1/papers/libraries/library-1/upload", async (route) => {
    state.uploadCount += 1;
    const uploadedPapers =
      state.uploadCount === 1
        ? [
            makePaper("upload-root", "root.pdf", "processing"),
            makePaper("upload-second", "second.pdf", "ready_with_warnings"),
          ]
        : [makePaper("upload-directory", "nested.pdf", "ready", "Mock/2026")];
    if (
      uploadedPapers.some((paper) => paper.folder_path) &&
      !state.folders.includes("Mock")
    ) {
      state.folders.push("Mock", "Mock/2026");
    }
    const uploadedIds = new Set(uploadedPapers.map((paper) => paper.paper_id));
    state.papers = [
      ...state.papers.filter((paper) => !uploadedIds.has(paper.paper_id)),
      ...uploadedPapers,
    ];
    await route.fulfill(
      json({
        papers: uploadedPapers,
        rejected: [],
        batch_id: `batch-${state.uploadCount}`,
      }),
    );
  });

  await page.route(
    "**/api/v1/papers/libraries/library-1/papers/failed/retry",
    async (route) => {
      const updated = makePaper("failed", "failed.pdf", "ready");
      state.papers = state.papers.map((paper) =>
        paper.paper_id === "failed" ? updated : paper,
      );
      await route.fulfill(json(updated));
    },
  );

  await page.route(
    "**/api/v1/papers/libraries/library-1/papers/*/move",
    async (route) => {
      const body = JSON.parse(route.request().postData() || "{}");
      const pathSegments = new URL(route.request().url()).pathname.split("/");
      const paperId = pathSegments[pathSegments.length - 2];
      if (body.target_library_id === "duplicate-library") {
        await route.fulfill(
          json({ detail: "The destination Paper Library already contains this PDF." }, 409),
        );
        return;
      }
      const paper = state.papers.find((item) => item.paper_id === paperId);
      if (!paper || paper.status === "processing") {
        await route.fulfill(json({ detail: "Paper extraction is still processing." }, 409));
        return;
      }
      const updated = {
        ...paper,
        folder_path: body.target_folder_path || "",
        library_id: body.target_library_id,
      };
      state.papers = state.papers.map((item) =>
        item.paper_id === paperId ? updated : item,
      );
      await route.fulfill(json(updated));
    },
  );

  await page.route("**/api/v1/papers/paper-1/source", (route) =>
    route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4" }),
  );
  await page.route("**/api/v1/papers/paper-1/assets/*", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgo=", "base64") }),
  );
  await page.route("**/api/v1/papers/paper-1", (route) =>
    route.fulfill(
      json({
        ...makePaper("paper-1", "review.pdf", "ready_with_warnings"),
        warnings: ["Check extracted page"],
        questions: [
          {
            question_id: "q-1",
            question_number: "1",
            question_text: "Original source question",
            options: { A: "Answer A" },
            question_type: "choice",
            difficulty: null,
            answer: "A",
            images: ["figure.png"],
            page: 1,
            is_multi_select: false,
            warnings: ["Review this image"],
          },
        ],
      }),
    ),
  );
  await page.route(
    "**/api/v1/papers/libraries/library-1/papers/paper-1/questions/*",
    async (route) => {
      if (state.saveFails) {
        await route.fulfill(json({ detail: "Save failed in fixture." }, 500));
        return;
      }
      const body = JSON.parse(route.request().postData() || "{}");
      await route.fulfill(
        json({
          question_id: "q-1",
          question_number: body.question_number,
          question_text: "Original source question",
          options: { A: "Answer A" },
          question_type: "choice",
          answer: body.answer,
          images: body.images ?? [],
          is_multi_select: false,
          warnings: ["Review this image"],
        }),
      );
    },
  );

  return state;
}

test.describe("Paper Library :: complete deterministic workflow matrix", () => {
  test("covers empty state, refresh, browser Back, and the original Question Bank entry", async ({
    page,
  }) => {
    const state = await installFixture(page, { libraries: [] });
    await page.goto(`${BASE_URL}/knowledge?tab=papers`);
    await expect(page.getByText("No Paper Libraries yet", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New Paper Library" }).first().click();
    await page.getByLabel("Library name").fill("Created Fixture Library");
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/library=library-1&section=papers/);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Created Fixture Library" })).toBeVisible();

    await page.getByRole("tab", { name: "Add files", exact: true }).click();
    await expect(page).toHaveURL(/section=add/);
    await page.goBack();
    await expect(page).toHaveURL(/section=papers/);
    await page.getByRole("button", { name: "Paper Libraries" }).first().click();
    await expect(page).toHaveURL(/tab=papers$/);
    expect(state.libraries).toHaveLength(1);

    await page.goto(`${BASE_URL}/space/questions`);
    await expect(page).toHaveURL(/\/space\/questions/);
    await expect(page.getByRole("heading", { name: "Question Bank", exact: true })).toBeVisible();
  });

  test("covers folder tree controls, filters, moves, conflicts, and processing locks", async ({
    page,
  }) => {
    const state = await installFixture(page, {
      folders: ["Empty", "Parent", "Parent/Child"],
      papers: [
        makePaper("ready", "ready.pdf", "ready"),
        makePaper("failed", "failed.pdf", "failed", "Parent"),
        makePaper("busy", "busy.pdf", "processing", "Parent/Child"),
      ],
      libraries: [
        {
          library_id: "library-1",
          name: "Fixture Papers",
          description: "Fixture",
          settings: { failure_policy: "keep_partial" },
          folders: ["Empty", "Parent", "Parent/Child"],
          paper_count: 3,
        },
        {
          library_id: "duplicate-library",
          name: "Duplicate Destination",
          folders: ["Archive"],
          paper_count: 1,
        },
      ],
    });
    await page.goto(
      `${BASE_URL}/knowledge?tab=papers&library=library-1&section=papers`,
    );
    await expect(page.getByRole("button", { name: "Empty New child folder" })).toBeVisible();
    const parent = page.getByRole("button", { name: "Parent New child folder" });
    await parent.click();
    await expect(page.getByText("Child", { exact: true })).not.toBeVisible();
    await parent.click();
    await expect(page.getByText("Child", { exact: true })).toBeVisible();

    await page.getByRole("textbox", { name: "Search files..." }).fill("failed");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "failed.pdf File extraction failed", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /ready\.pdf/ })).not.toBeVisible();
    await page.getByRole("combobox", { name: "Filter file status" }).selectOption("failed");
    await expect(
      page.getByRole("button", { name: "failed.pdf File extraction failed", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "failed.pdf File extraction failed", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("button", { name: /failed\.pdf/ })).not.toBeVisible();

    await page.getByRole("textbox", { name: "Search files..." }).fill("");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("combobox", { name: "Filter file status" }).selectOption("");
    await expect(page.getByRole("button", { name: /ready\.pdf/ })).toBeVisible();
    const readyRow = page.locator('[draggable="true"]').filter({ hasText: "ready.pdf" }).first();
    await readyRow.getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("button", { name: "Parent", exact: true }).click();
    await expect.poll(() => state.papers.find((paper) => paper.paper_id === "ready")?.folder_path).toBe("Parent");
    await readyRow.getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("button", { name: "/ Root", exact: true }).click();
    await expect.poll(() => state.papers.find((paper) => paper.paper_id === "ready")?.folder_path).toBe("");
    await readyRow.dragTo(page.getByRole("button", { name: "Parent New child folder" }));
    await expect.poll(() => state.papers.find((paper) => paper.paper_id === "ready")?.folder_path).toBe("Parent");

    await readyRow.getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("button", { name: "Duplicate Destination / Archive", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "destination Paper Library" }),
    ).toContainText("destination Paper Library");
    await expect(page.getByRole("button", { name: /ready\.pdf/ })).toBeVisible();

    await page.getByRole("button", { name: "New root folder" }).click();
    await page.getByLabel("Folder name", { exact: true }).fill("../invalid");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "invalid" })).toContainText("invalid");

    const busyPaper = page.getByRole("button", { name: "busy.pdf File processing" });
    await busyPaper.click();
    await expect(page.getByRole("button", { name: "Start Exam", exact: true })).toBeDisabled();
    await expect(
      page.locator('[draggable="false"]').filter({ hasText: "busy.pdf" }).getByRole("button", { name: "Move to…" }),
    ).toBeDisabled();
    expect(state.papers.find((paper) => paper.paper_id === "busy")?.status).toBe("processing");
  });

  test("covers upload batches, directory paths, live status, retry, preview, and review errors", async ({
    page,
  }) => {
    const state = await installFixture(page, {
      papers: [makePaper("paper-1", "review.pdf", "ready_with_warnings")],
    });
    await page.goto(
      `${BASE_URL}/knowledge?tab=papers&library=library-1&section=add`,
    );

    await page.locator('input[type="file"]').first().setInputFiles([
      { name: "root.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") },
    ]);
    await expect(page.getByText(/1 ready, 1 will be skipped/)).toBeVisible();
    await page.getByRole("button", { name: "Upload PDFs", exact: true }).click();
    await expect(page.getByText("Latest upload status", { exact: true })).toBeVisible();
    await expect(page.getByText("root.pdf", { exact: true })).toBeVisible();
    await expect(page.getByText("second.pdf", { exact: true })).toBeVisible();
    await expect(page.getByText("42%", { exact: true })).toBeVisible();
    await expect(page.getByText("File ready", { exact: true })).toBeVisible({
      timeout: 5000,
    });

    await page.locator('input[webkitdirectory]').evaluate((input) => {
      const file = new File(["%PDF-1.4"], "nested.pdf", { type: "application/pdf" });
      Object.defineProperty(file, "webkitRelativePath", {
        value: "Mock/2026/nested.pdf",
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      Object.defineProperty(input, "files", { value: transfer.files });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.getByText("Mock/2026/nested.pdf", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Upload PDFs", exact: true }).click();
    await expect(page.getByText("Mock/2026/nested.pdf", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Files", exact: true }).click();
    const warningPaper = page.getByRole("button", { name: /review\.pdf/ }).first();
    await expect(warningPaper).toBeVisible();
    await expect(warningPaper).not.toContainText("File ready with warnings");
    await warningPaper.click();
    await expect(page.locator('a[aria-label="Open"]')).toHaveAttribute(
      "href",
      "/api/v1/papers/paper-1/source",
    );
    await expect(page.locator('a[aria-label="Download"]')).toHaveAttribute(
      "download",
      "review.pdf",
    );
    await page.getByRole("button", { name: "Review questions", exact: true }).click();
    await expect(page.getByText("Check extracted page", { exact: true })).toBeVisible();
    await expect(page.getByText("Review this image", { exact: true })).toBeVisible();
    await page.locator("ol input").first().fill("1-corrected");
    await page.locator("ol textarea").first().fill("A");
    state.saveFails = true;
    await page.getByRole("button", { name: "Save correction", exact: true }).click();
    await expect(page.getByText("Save failed in fixture.", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Back to Paper Library", exact: true }).click();
    await page.getByRole("button", { name: /review\.pdf/ }).first().click();
    await expect(page.getByRole("button", { name: "Start Exam", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Start Exam", exact: true }).click();
    await expect(page).toHaveURL(/\/home\?exam_paper_id=paper-1&exam_library_id=library-1/);
  });

  test("covers Traditional Chinese, responsive semantics, focusable controls, and isolation errors", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("deeptutor-language", "zh-TW");
    });
    await installFixture(page, {
      papers: [makePaper("ready", "ready.pdf", "ready")],
    });
    await page.goto(`${BASE_URL}/space`);
    await expect(page.getByRole("heading", { name: "學習空間", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "對話與資料", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "個人化", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE_URL}/knowledge?tab=papers`);
    await expect(
      page.getByRole("heading", { name: "試卷庫", exact: true }),
    ).toBeVisible();
    await page.goto(
      `${BASE_URL}/knowledge?tab=papers&library=library-1&section=papers`,
    );
    await expect(page.getByRole("tab", { name: "檔案", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("button", { name: "新增根資料夾" })).toBeVisible();
    await page.getByRole("button", { name: /ready\.pdf/ }).last().click();
    await expect(page.getByRole("button", { name: "開始考試" })).toBeVisible();
    await page.getByRole("button", { name: "新增根資料夾" }).focus();
    await expect(page.getByRole("button", { name: "新增根資料夾" })).toBeFocused();
    await expect(page.getByRole("navigation", { name: "試卷庫分頁" })).toBeVisible();

    await page.unroute("**/api/v1/papers/libraries");
    await page.route("**/api/v1/papers/libraries", (route) =>
      route.fulfill(json({ detail: "This library is not available." }, 403)),
    );
    await page.goto(`${BASE_URL}/knowledge?tab=papers`);
    await expect(
      page.getByRole("alert").filter({ hasText: "not available" }),
    ).toContainText("not available");
  });
});
