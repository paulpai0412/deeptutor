import { expect, test } from "@playwright/test";

const BASE_URL =
  process.env.WEB_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  "http://localhost:3000";

const library = {
  library_id: "library-1",
  name: "History Papers",
  description: "Source exams for history practice.",
  settings: { failure_policy: "keep_partial" },
  paper_count: 0,
};

const paper = {
  paper_id: "paper-1",
  display_name: "Practice.pdf",
  original_filename: "Practice.pdf",
  source_hash: "hash-1",
  status: "ready",
  question_count: 2,
  warning_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  library_id: "library-2",
};

const paperDetail = {
  ...paper,
  questions: [
    {
      question_id: "question-1",
      question_number: "1",
      question_text: "Which answer is correct?",
      options: { A: "Correct" },
      question_type: "choice",
      difficulty: null,
      answer: "A",
      images: ["figure.png"],
      page: 1,
      is_multi_select: false,
      warnings: [],
    },
  ],
};

function json(body: unknown, status = 200) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

test.describe("Paper Library :: Knowledge Center navigation", () => {
  test("opens the card overview, detail sections, and preserves URL state", async ({
    page,
  }) => {
    let libraries = [library];

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
          failure_policies: [
            { id: "keep_partial", label: "Keep usable questions" },
            { id: "fail_fast", label: "Stop on first failure" },
          ],
          llm_required: true,
        }),
      ),
    );
    await page.route("**/api/v1/papers/libraries", async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const created = {
          ...library,
          library_id: "library-2",
          name: "New Papers",
          description: "Created in the audit.",
        };
        libraries = [...libraries, created];
        await route.fulfill(json(created, 201));
        return;
      }
      if (request.method() === "PATCH") {
        const body = JSON.parse(request.postData() || "{}");
        const updated = {
          ...(libraries.find((item) => item.library_id === "library-2") ?? library),
          name: body.name,
          description: body.description,
          settings: body.settings,
        };
        libraries = libraries.map((item) =>
          item.library_id === "library-2" ? updated : item,
        );
        await route.fulfill(json(updated));
        return;
      }
      await route.fulfill(json({ libraries }));
    });
    await page.route("**/api/v1/papers/libraries/library-2", async (route) => {
      if (route.request().method() === "DELETE") {
        libraries = libraries.filter((item) => item.library_id !== "library-2");
        await route.fulfill(json({ deleted: true, library_id: "library-2" }));
        return;
      }
      if (route.request().method() === "PATCH") {
        const body = JSON.parse(route.request().postData() || "{}");
        const updated = {
          ...(libraries.find((item) => item.library_id === "library-2") ?? library),
          name: body.name,
          description: body.description,
          settings: body.settings,
        };
        libraries = libraries.map((item) =>
          item.library_id === "library-2" ? updated : item,
        );
        await route.fulfill(json(updated));
        return;
      }
      await route.fulfill(json(libraries.find((item) => item.library_id === "library-2")));
    });
    await page.route(
      "**/api/v1/papers/libraries/*/papers*",
      (route) =>
        route.fulfill(
          json({
            papers: route.request().url().includes("library-2") ? [paper] : [],
          }),
        ),
    );
    await page.route("**/api/v1/papers/paper-1", (route) =>
      route.fulfill(json(paperDetail)),
    );
    await page.route("**/api/v1/papers/paper-1/source", (route) =>
      route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4" }),
    );
    await page.route("**/api/v1/papers/paper-1/assets/*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
    );
    await page.route(
      "**/api/v1/papers/libraries/library-2/papers/paper-1/questions/*",
      async (route) => {
        const body = JSON.parse(route.request().postData() || "{}");
        await route.fulfill(
          json({
            ...paperDetail.questions[0],
            question_number: body.question_number,
            answer: body.answer,
            images: body.images ?? paperDetail.questions[0].images,
          }),
        );
      },
    );

    await page.goto(`${BASE_URL}/knowledge?tab=papers`);
    await expect(
      page.getByRole("heading", { name: "Paper Libraries" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New Paper Library" }).first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /History Papers/ })).toBeVisible();

    await page.getByRole("button", { name: "New Paper Library" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Library name").fill("New Papers");
    await page.getByLabel("Description (optional)").fill("Created in the audit.");
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();

    await expect(page).toHaveURL(/tab=papers&library=library-2&section=papers/);
    await expect(
      page.getByRole("heading", { name: "New Papers" }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.getByRole("button", { name: "Practice.pdf File ready", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Practice.pdf File ready", exact: true })
      .click();
    await expect(page.locator('iframe[title="Practice.pdf"]')).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Review questions", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Exam", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Start Exam", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Start Exam", exact: true }).click();
    await expect(page).toHaveURL(/\/home\?exam_paper_id=paper-1&exam_library_id=library-2/);
    await page.goto(
      `${BASE_URL}/knowledge?tab=papers&library=library-2&section=papers&paper=paper-1`,
    );
    await expect(
      page.getByRole("button", { name: "Practice.pdf File ready", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Practice.pdf File ready", exact: true })
      .click();
    await page.getByRole("button", { name: "Review questions", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Back to Paper Library", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Which answer is correct?", { exact: true })).toBeVisible();
    await page.locator("ol input").first().fill("1-reviewed");
    await page.locator("ol textarea").first().fill("A (verified)");
    await page.getByRole("button", { name: "Save correction", exact: true }).click();
    await expect(page.getByRole("img", { name: /Related image/ })).toBeVisible();
    await page
      .getByRole("button", { name: "Remove", exact: true })
      .click({ force: true });
    await expect(page.getByRole("img", { name: /Related image/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Back to Paper Library", exact: true }).click();

    await page.getByRole("tab", { name: "Add files", exact: true }).click();
    await expect(page).toHaveURL(/section=add/);
    await expect(page.getByRole("heading", { name: "Add files" })).toBeVisible();

    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/section=settings/);
    await expect(
      page.getByRole("heading", { name: "Paper Library settings" }),
    ).toBeVisible();
    await page.getByLabel("Library name").fill("Updated Papers");
    await page.getByLabel("Description").fill("Updated description.");
    await page.getByLabel("Extraction LLM").selectOption("profile-1:model-1");
    await page.getByLabel("PDF parser").selectOption("text_only");
    await page.getByLabel("Failure policy").selectOption("fail_fast");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Settings saved");
    await page.reload();
    await expect(page.getByLabel("Library name")).toHaveValue("Updated Papers");
    await expect(page.getByLabel("Description")).toHaveValue("Updated description.");
    await expect(page.getByLabel("Extraction LLM")).toHaveValue("profile-1:model-1");
    await expect(page.getByLabel("PDF parser")).toHaveValue("text_only");
    await expect(page.getByLabel("Failure policy")).toHaveValue("fail_fast");

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete Paper Library", exact: true }).click();
    await expect(page).toHaveURL(/tab=papers$/);
    await expect(
      page.getByRole("heading", { name: "Paper Libraries" }).first(),
    ).toBeVisible();
  });

  test("creates nested Paper Folders and moves papers through the tree", async ({
    page,
  }) => {
    const folders: string[] = [];
    let folderPaper = { ...paper, folder_path: "" };

    await page.route("**/api/v1/knowledge/list", (route) =>
      route.fulfill(json([])),
    );
    await page.route("**/api/v1/knowledge/rag-providers", (route) =>
      route.fulfill(json({ providers: [] })),
    );
    await page.route("**/api/v1/knowledge/supported-file-types", (route) =>
      route.fulfill(json({ extensions: [".pdf"], accept: ".pdf" })),
    );
    await page.route("**/api/v1/papers/libraries/options", (route) =>
      route.fulfill(
        json({
          llm: { active: null, options: [] },
          parsers: [],
          failure_policies: [],
          llm_required: true,
        }),
      ),
    );
    await page.route("**/api/v1/papers/libraries", (route) =>
      route.fulfill(
        json({
          libraries: [
            {
              ...library,
              library_id: "library-2",
              name: "Folder Fixtures",
              folders,
              paper_count: 1,
            },
          ],
        }),
      ),
    );
    await page.route(
      "**/api/v1/papers/libraries/library-2/papers*",
      (route) => route.fulfill(json({ papers: [folderPaper], folders })),
    );
    await page.route(
      "**/api/v1/papers/libraries/library-2/folders",
      async (route) => {
        const body = JSON.parse(route.request().postData() || "{}");
        const path = [body.parent_path, body.name.trim()]
          .filter(Boolean)
          .join("/");
        folders.push(path);
        await route.fulfill(json({ path }, 201));
      },
    );
    await page.route(
      "**/api/v1/papers/libraries/library-2/papers/paper-1/move",
      async (route) => {
        const body = JSON.parse(route.request().postData() || "{}");
        folderPaper = { ...folderPaper, folder_path: body.target_folder_path || "" };
        await route.fulfill(json(folderPaper));
      },
    );

    await page.goto(
      `${BASE_URL}/knowledge?tab=papers&library=library-2&section=papers`,
    );
    await expect(
      page.getByRole("button", { name: "Library root", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "New root folder" }).click();
    await page.getByLabel("Folder name", { exact: true }).fill("Mock Exams");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /^Mock Exams/ }),
    ).toBeVisible();

    await page.getByRole("button", { name: "New child folder", exact: true }).click();
    await page.getByLabel("Folder name", { exact: true }).fill("2026");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("2026", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: /Practice\.pdf/ }).click();
    await page.getByRole("button", { name: "Move to…" }).click();
    await page.getByRole("button", { name: "Mock Exams", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /Practice\.pdf/ }).first(),
    ).toBeVisible();
    await expect(page).toHaveURL(/folder=Mock\+Exams|folder=Mock%20Exams/);
  });

  test("keeps Add files open and shows independent upload status", async ({
    page,
  }) => {
    let uploadBody = "";
    const uploadedPaper = {
      ...paper,
      display_name: "root.pdf",
      folder_path: "",
      status: "pending",
      question_count: 0,
    };

    await page.route("**/api/v1/knowledge/list", (route) =>
      route.fulfill(json([])),
    );
    await page.route("**/api/v1/knowledge/rag-providers", (route) =>
      route.fulfill(json({ providers: [] })),
    );
    await page.route("**/api/v1/knowledge/supported-file-types", (route) =>
      route.fulfill(json({ extensions: [".pdf"], accept: ".pdf" })),
    );
    await page.route("**/api/v1/papers/libraries/options", (route) =>
      route.fulfill(
        json({
          llm: { active: null, options: [] },
          parsers: [],
          failure_policies: [],
          llm_required: true,
        }),
      ),
    );
    await page.route("**/api/v1/papers/libraries", (route) =>
      route.fulfill(
        json({
          libraries: [
            {
              ...library,
              library_id: "library-2",
              name: "Upload Fixtures",
              paper_count: 0,
              folders: [],
            },
          ],
        }),
      ),
    );
    await page.route(
      "**/api/v1/papers/libraries/library-2/papers*",
      (route) => route.fulfill(json({ papers: [], folders: [] })),
    );
    await page.route(
      "**/api/v1/papers/libraries/library-2/upload",
      async (route) => {
        uploadBody = route.request().postData() || "";
        await route.fulfill(json({ papers: [uploadedPaper], rejected: [], batch_id: "batch-1" }));
      },
    );

    await page.goto(
      `${BASE_URL}/knowledge?tab=papers&library=library-2&section=add`,
    );
    await expect(page.locator('input[type="file"]').first()).toHaveCount(1);
    await page.locator('input[type="file"]').first().setInputFiles([
      { name: "root.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") },
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") },
    ]);
    await expect(page.getByText(/1 ready, 1 will be skipped/)).toBeVisible();
    await page.getByRole("button", { name: "Upload PDFs", exact: true }).click();
    await expect(page).toHaveURL(/tab=papers&library=library-2&section=add/);
    await expect(page.getByText("Latest upload status", { exact: true })).toBeVisible();
    await expect(page.getByText("root.pdf", { exact: true })).toBeVisible();
    expect(uploadBody).toContain('name="rel_paths"');
  });
});
