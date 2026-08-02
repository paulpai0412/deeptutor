import { expect, test, type Page } from "@playwright/test";

type Catalog = {
  version: number;
  services: Record<string, unknown>;
};

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function json(body: unknown, status = 200) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function emptyService() {
  return { active_profile_id: null, active_model_id: null, profiles: [] };
}

function fixtureCatalog(): Catalog {
  return {
    version: 1,
    services: {
      llm: {
        active_profile_id: "llm-profile",
        active_model_id: "llm-model",
        profiles: [
          {
            id: "llm-profile",
            name: "Codex",
            binding: "openai_codex",
            base_url: "",
            api_key: "",
            api_version: "",
            extra_headers: {},
            models: [
              {
                id: "llm-model",
                name: "Codex model",
                model: "gpt-5.5",
              },
            ],
          },
        ],
      },
      embedding: emptyService(),
      search: emptyService(),
      tts: emptyService(),
      stt: emptyService(),
      imagegen: {
        active_profile_id: "image-profile",
        active_model_id: "image-model",
        profiles: [
          {
            id: "image-profile",
            name: "OpenAI",
            binding: "openai",
            base_url: "https://api.openai.com/v1",
            api_key: "sk-fixture",
            api_version: "",
            extra_headers: {},
            models: [
              {
                id: "image-model",
                name: "Image model",
                model: "gpt-image-1",
                size: "",
                quality: "",
                style: "",
              },
            ],
          },
        ],
      },
      videogen: emptyService(),
    },
  };
}

const providerChoices = {
  llm: [
    {
      value: "openai_codex",
      label: "OpenAI Codex",
      base_url: "",
    },
  ],
  embedding: [],
  search: [],
  tts: [],
  stt: [],
  imagegen: [
    {
      value: "openai",
      label: "OpenAI",
      base_url: "https://api.openai.com/v1",
      default_model: "gpt-image-1",
    },
    {
      value: "openai_codex",
      label: "OpenAI Codex OAuth",
      base_url: "",
      default_model: "gpt-5.5",
      auth_mode: "oauth",
      oauth_ready: true,
    },
  ],
  videogen: [],
};

function settingsPayload(catalog: Catalog) {
  return {
    catalog,
    ui: {
      theme: "snow",
      language: "en",
      code_block_theme: "github",
      code_block_show_line_numbers: true,
      code_block_wrap_long_lines: false,
    },
    providers: providerChoices,
  };
}

async function installFixture(page: Page) {
  let catalog = fixtureCatalog();
  let appliedCatalog: Catalog | null = null;
  let startTurn: Record<string, unknown> | null = null;

  await page.route("**/api/v1/settings**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === "/api/v1/settings" && request.method() === "GET") {
      await route.fulfill(json(settingsPayload(catalog)));
      return;
    }
    if (pathname === "/api/v1/settings/apply" && request.method() === "POST") {
      const body = JSON.parse(request.postData() || "{}");
      catalog = body.catalog as Catalog;
      appliedCatalog = catalog;
      await route.fulfill(json({ catalog }));
      return;
    }
    if (pathname === "/api/v1/settings/llm-options") {
      await route.fulfill(
        json({
          active: { profile_id: "llm-profile", model_id: "llm-model" },
          options: [
            {
              profile_id: "llm-profile",
              model_id: "llm-model",
              profile_name: "Codex",
              model_name: "Codex model",
              model: "gpt-5.5",
              provider: "openai_codex",
              is_active_default: true,
            },
          ],
        }),
      );
      return;
    }
    if (pathname === "/api/v1/settings/chat-attachments") {
      await route.fulfill(
        json({
          effective: {
            max_file_bytes: 20 * 1024 * 1024,
            max_total_bytes: 40 * 1024 * 1024,
          },
        }),
      );
      return;
    }
    await route.continue();
  });

  await page.route("**/api/v1/auth/status", (route) =>
    route.fulfill(
      json({
        enabled: false,
        authenticated: true,
        user_id: "e2e-user",
        username: "e2e-admin",
        role: "admin",
        is_admin: true,
      }),
    ),
  );
  await page.route("**/api/v1/system/status", (route) =>
    route.fulfill(
      json({
        backend: { status: "ok", timestamp: new Date().toISOString() },
        llm: { status: "ok", model: "gpt-5.5" },
        embeddings: { status: "ok" },
        search: { status: "ok" },
      }),
    ),
  );
  await page.route("**/api/v1/tools", (route) =>
    route.fulfill(json({ enabled_optional_tools: ["imagegen"] })),
  );
  await page.route("**/api/v1/knowledge/list", (route) =>
    route.fulfill(json([])),
  );
  await page.route("**/api/v1/subagents/connections", (route) =>
    route.fulfill(json({ connections: [] })),
  );
  await page.route("**/api/v1/subagents/settings", (route) =>
    route.fulfill(json({ consult_budget: 2 })),
  );
  await page.route("**/api/v1/sessions**", (route) =>
    route.fulfill(json({ sessions: [] })),
  );
  await page.route("**/api/outputs/codex-book.png", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: png }),
  );

  await page.routeWebSocket("**/api/v1/ws", (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type !== "start_turn") return;
      startTurn = message;

      const base = {
        source: "chat",
        stage: "responding",
        session_id: "session-imagegen-e2e",
        turn_id: "turn-imagegen-e2e",
        timestamp: Date.now() / 1000,
      };
      socket.send(
        JSON.stringify({
          ...base,
          type: "session",
          content: "",
          seq: 1,
          metadata: {
            session_id: "session-imagegen-e2e",
            turn_id: "turn-imagegen-e2e",
          },
        }),
      );
      socket.send(
        JSON.stringify({
          ...base,
          type: "tool_call",
          content: "imagegen",
          seq: 2,
          metadata: {
            tool: "imagegen",
            args: { prompt: message.content },
          },
        }),
      );
      socket.send(
        JSON.stringify({
          ...base,
          type: "tool_result",
          content: "Generated image.",
          seq: 3,
          metadata: {
            tool: "imagegen",
            tool_metadata: {
              artifacts: [
                {
                  filename: "codex-book.png",
                  url: "/api/outputs/codex-book.png",
                  mime_type: "image/png",
                  size_bytes: png.length,
                },
              ],
            },
          },
        }),
      );
      socket.send(
        JSON.stringify({
          ...base,
          type: "content",
          content: "Generated codex-book.png.",
          seq: 4,
          metadata: {},
        }),
      );
      socket.send(
        JSON.stringify({
          ...base,
          type: "done",
          content: "",
          seq: 5,
          metadata: {
            status: "completed",
            user_message_id: 101,
            assistant_message_id: 102,
          },
        }),
      );
    });
  });

  return {
    getAppliedCatalog: () => appliedCatalog,
    getStartTurn: () => startTurn,
  };
}

test("configures Codex image OAuth in Settings and generates an image from Chat", async ({
  page,
}) => {
  const fixture = await installFixture(page);

  await page.goto("/settings/image");
  await expect(
    page.getByRole("heading", { name: "Image Generation" }),
  ).toBeVisible();

  const providerSelect = page.locator("select").first();
  await expect(providerSelect).toHaveValue("openai");
  await providerSelect.selectOption("openai_codex");

  await expect(
    page.getByText("Codex OAuth status: Connected", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("API Key", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Base URL", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Extra (optional)", { exact: true })).toHaveCount(0);

  const modelInput = page.locator('input[placeholder="gpt-4o"]');
  await modelInput.fill("gpt-5.5");
  await page.getByPlaceholder("1024x1024").fill("1024x1024");
  await page.getByPlaceholder("quality (e.g. hd)").fill("high");

  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/v1/settings/apply",
    ),
    page.getByRole("button", { name: "Apply", exact: true }).click(),
  ]);

  await expect
    .poll(() => {
      const catalog = fixture.getAppliedCatalog();
      const service = catalog?.services.imagegen as {
        profiles: Array<{
          binding?: string;
          models: Array<{ model?: string; size?: string; quality?: string }>;
        }>;
      };
      const profile = service?.profiles?.[0];
      const model = profile?.models?.[0];
      return {
        binding: profile?.binding,
        model: model?.model,
        size: model?.size,
        quality: model?.quality,
      };
    })
    .toEqual({
      binding: "openai_codex",
      model: "gpt-5.5",
      size: "1024x1024",
      quality: "high",
    });

  await page.goto("/home");
  const composer = page.getByPlaceholder("How can I help you today?");
  await expect(composer).toBeVisible();

  const prompt = "A small blue book on a white desk, educational illustration.";
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send", exact: true }).click();

  await expect
    .poll(() => fixture.getStartTurn())
    .toEqual(expect.objectContaining({ content: prompt, tools: ["imagegen"] }));
  await expect(page.locator('img[alt="codex-book.png"]')).toBeVisible();
  await expect(page.getByText("codex-book", { exact: false })).toBeVisible();
});
