import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";
import { chromium, expect, type Page, type Browser } from "@playwright/test";
import { createProductionApplication } from "../../integration/production-server.ts";
import type { ExecutionProvider } from "../../contracts/execution.ts";
import {
  createExecutionService,
  createExecutionHttpHandler,
} from "../execution/index.ts";

export const content = (text: string) => ({
  files: [{ path: "SKILL.md", content: text, mediaType: "text/markdown" }],
});
export async function harness(
  options: { executionProvider?: ExecutionProvider } = {},
) {
  assert.ok(
    process.env.DATABASE_URL,
    "DATABASE_URL is required; missing PG is not a passing/skipped acceptance",
  );
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  const schema = "collaboration_" + randomUUID().replaceAll("-", "");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  let schemaCreated = false,
    closed = false;
  let application:
    Awaited<ReturnType<typeof createProductionApplication>> | undefined;
  let chrome: Browser | undefined;
  async function cleanup() {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    // Ordered teardown, but every resource is attempted even if an earlier close fails.
    for (const step of [
      () => chrome?.close(),
      () => application?.close(),
      () => pool.end(),
      () =>
        schemaCreated
          ? admin.query(`DROP SCHEMA ${schema} CASCADE`)
          : undefined,
      () => admin.end(),
    ]) {
      try {
        await step();
      } catch (e) {
        failures.push(e);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Collaboration test cleanup failed");
  }
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    const port = Number(process.env.COLLABORATION_PORT ?? 18754);
    const origin = `http://127.0.0.1:${port}`;
    const app = await createProductionApplication({
      pool,
      publicOrigin: origin,
      mode: "test",
      webDir: resolve(import.meta.dirname, "../product/dist"),
      pollIntervalMs: 40,
      operations: { logger: () => {} },
      executionFactory: options.executionProvider
        ? ({ pool, identity }) => {
            const execution = createExecutionService({
              pool,
              provider: options.executionProvider!,
              pollIntervalMs: 40,
            });
            return {
              handle: createExecutionHttpHandler({ execution, identity }),
              start: () => execution.start(),
              stop: () => execution.stop(),
            };
          }
        : undefined,
      testProvider: {
        name: "explicit-collaboration-test-provider",
        authorizationUrl: ({ state, redirectUri }) =>
          `${redirectUri}?state=${state}&code=alice`,
        exchange: async ({ code }) => ({
          subject: code,
          displayName: code,
          verifiedEmail: `${code}@example.test`,
        }),
      },
    });
    application = app;
    await new Promise<void>((done, reject) => {
      app.server.once("error", reject);
      app.server.listen(port, "127.0.0.1", () => {
        app.server.off("error", reject);
        done();
      });
    });
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROME_PATH ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    chrome = browser;
    const errors: string[] = [];
    async function login(name: string) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1100 },
      });
      context.setDefaultTimeout(8000);
      // Real state/PKCE-cookie/callback/session flow; only upstream OAuth exchange is a declared fixture.
      const first = await context.request.get(origin + "/api/identity/login", {
        maxRedirects: 0,
      });
      const callback = new URL(first.headers().location);
      callback.searchParams.set("code", name);
      assert.equal(
        (
          await context.request.get(callback.href, { maxRedirects: 0 })
        ).status(),
        302,
      );
      const session = (
        await (
          await context.request.get(origin + "/api/identity/session")
        ).json()
      ).data;
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("dialog", (d) => void d.accept());
      const request = async (
        area: string,
        method: string,
        body: unknown,
        team = "",
      ) => {
        const response = await context.request.post(
          `${origin}/api/${area}/${method}`,
          {
            headers: {
              Origin: origin,
              "X-Team-Id": team,
              "X-CSRF-Token": session.csrfToken,
              "X-Skill-Library": "1",
            },
            data: body,
          },
        );
        return { status: response.status(), body: await response.json() };
      };
      const identity = async (method: string, input: unknown) => {
        const r = await request("identity", method, input);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        return r.body.data;
      };
      const rpc = async (
        team: string,
        method: string,
        args: unknown[],
        area = "library",
      ) => {
        const r = await request(area, method, { args }, team);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        return r.body.result;
      };
      return { context, page, session, request, identity, rpc };
    }
    const alice = await login("alice"),
      bob = await login("bob");
    const team = await alice.identity("createTeam", {
      name: "真实协作验收团队",
    });
    const invite = await alice.identity("invite", {
      teamId: team.id,
      email: "bob@example.test",
      role: "contributor",
    });
    await bob.identity("accept", { token: invite.token });
    return {
      app,
      pool,
      origin,
      browser,
      alice,
      bob,
      team,
      errors,
      async close() {
        await cleanup();
        assert.deepEqual(errors, [], "Chrome page errors");
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export type Harness = Awaited<ReturnType<typeof harness>>;
export type User = Harness["alice"];
export async function seed(h: Harness, name = "双人编辑技能") {
  const { skill, draft } = await h.alice.rpc(h.team.id, "createSkill", [
    {
      name,
      description: "真实 HTTP / PG 验收",
      maintainerIds: [],
      content: content("# v1\n共同基础"),
    },
  ]);
  const v1 = await publish(h.alice, h.team.id, draft, "首次发布");
  return { skill, v1 };
}
export async function publish(
  user: User,
  team: string,
  draft: any,
  summary = "发布更新",
  idempotencyKey = randomUUID(),
) {
  return user.rpc(team, "publishDraft", [
    {
      draftId: draft.id,
      expectedRevision: draft.revision,
      expectedBaseVersionId: draft.baseVersionId,
      changeSummary: summary,
      idempotencyKey,
    },
  ]);
}
export async function publishText(
  user: User,
  team: string,
  skill: string,
  text: string,
) {
  const d = await user.rpc(team, "createDraft", [skill]);
  const saved = await user.rpc(team, "saveDraft", [
    { draftId: d.id, expectedRevision: d.revision, content: content(text) },
  ]);
  return publish(user, team, saved);
}
export async function openEditor(
  h: Harness,
  user: User,
  name = "双人编辑技能",
) {
  await user.page.goto(h.origin);
  await user.page.getByLabel("当前团队").selectOption(h.team.id);
  await user.page
    .getByRole("button", { name: new RegExp(name + ".*查看") })
    .click();
  await user.page
    .getByRole("button", { name: "编辑技能", exact: true })
    .click();
  await expect(editor(user.page)).toBeVisible();
}
export const editor = (page: Page) =>
  page.getByRole("textbox", { name: "SKILL.md", exact: true });
export async function save(page: Page) {
  await page.getByRole("button", { name: /^(保存草稿|重试保存)$/ }).click();
  await expect(page.locator(".save-status")).toContainText("草稿已保存");
}
export async function draftId(page: Page) {
  return page.evaluate(() =>
    sessionStorage.getItem(
      Object.keys(sessionStorage).find((k) => k.startsWith("skill-draft:"))!,
    ),
  );
}
