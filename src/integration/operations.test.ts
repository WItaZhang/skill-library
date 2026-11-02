import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { Pool } from "pg";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProductionApplication } from "./production-server.ts";
import type { Limits } from "../modules/operations/rate-limit.ts";
import type { LogRecord } from "../modules/operations/telemetry.ts";
import type { ExecutionFactory } from "../modules/operations/execution.ts";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "DATABASE_URL is required; operations tests cannot skip PostgreSQL",
  );
async function fixture(
  t: any,
  limits: Partial<Limits> = {},
  executionFactory?: ExecutionFactory,
) {
  const root = new Pool({ connectionString: databaseUrl });
  const schema = "ops_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 1000,
  });
  const directory = await mkdtemp(join(tmpdir(), "operations-web-"));
  await writeFile(join(directory, "index.html"), "<h1>正式产物测试</h1>");
  const records: LogRecord[] = [];
  const origin = "http://localhost";
  const opts = {
    pool,
    publicOrigin: origin,
    mode: "test" as const,
    webDir: directory,
    pollIntervalMs: 10,
    testProvider: {
      name: "operations-fixture",
      authorizationUrl: ({
        state,
        redirectUri,
      }: {
        state: string;
        redirectUri: string;
      }) => `${redirectUri}?state=${state}&code=ops`,
      exchange: async () => ({
        subject: "ops",
        displayName: "运维验收账号",
        verifiedEmail: "ops@example.test",
      }),
    },
    operations: {
      logger: (r: LogRecord) => records.push(r),
      metricsToken: "m".repeat(32),
      limits,
      shutdownMs: 1500,
    },
    executionFactory,
  };
  let app = await createProductionApplication(opts);
  async function listen() {
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(app.server.address() as any).port}`;
  }
  let base = await listen();
  t.after(async () => {
    await app.close();
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
    await rm(directory, { recursive: true });
  });
  async function login() {
    const first = await fetch(base + "/api/identity/login", {
      redirect: "manual",
    });
    assert.equal(first.status, 302);
    const callback = new URL(first.headers.get("location")!);
    const r = await fetch(base + callback.pathname + callback.search, {
      redirect: "manual",
      headers: {
        Cookie: first.headers
          .getSetCookie()
          .map((x) => x.split(";")[0])
          .join("; "),
      },
    });
    assert.equal(r.status, 302);
    const cookie = r.headers
      .getSetCookie()
      .filter((x) => x.startsWith("sl_session="))
      .map((x) => x.split(";")[0])
      .join("; ");
    const session = (
      await (
        await fetch(base + "/api/identity/session", {
          headers: { Cookie: cookie },
        })
      ).json()
    ).data;
    return { cookie, csrf: session.csrfToken, user: session.user };
  }
  const post = (user: any, path: string, body: unknown, team = "") =>
    fetch(base + path, {
      method: "POST",
      headers: {
        Cookie: user.cookie,
        Origin: origin,
        "X-CSRF-Token": user.csrf,
        "X-Team-Id": team,
        "X-Skill-Library": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return {
    app,
    pool,
    root,
    schema,
    records,
    login,
    post,
    get base() {
      return base;
    },
    async restart() {
      await app.close();
      app = await createProductionApplication(opts);
      base = await listen();
      return app;
    },
  };
}
test("real HTTP/PG: request ids, private metrics, secret redaction, liveness/readiness and database failure", async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + "/healthz")).status, 200);
  assert.equal((await fetch(f.base + "/readyz")).status, 200);
  assert.equal((await fetch(f.base + "/metrics")).status, 404);
  const response = await fetch(f.base + "/?invitation=DO_NOT_LOG_INVITE", {
    headers: { Cookie: "DO_NOT_LOG_COOKIE", "X-Request-Id": "DO_NOT_TRUST_ID" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-request-id")!, /^[a-f0-9-]{36}$/);
  await fetch(
    f.base +
      "/api/identity/callback?code=DO_NOT_LOG_CODE&state=DO_NOT_LOG_STATE",
  );
  const user = await f.login();
  await f.post(user, "/api/not-a-route", { prompt: "DO_NOT_LOG_PROMPT" });
  f.pool.emit(
    "error",
    Object.assign(new Error("DO_NOT_LOG_PASSWORD"), { code: "ECONNRESET" }),
  );
  const metrics = await fetch(f.base + "/metrics", {
    headers: { Authorization: "Bearer " + "m".repeat(32) },
  });
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /skill_http_requests_total/);
  assert.ok(
    f.records.some(
      (r) => r.event === "database.pool_error" && r.code === "ECONNRESET",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(f.records),
    /DO_NOT_LOG|DO_NOT_TRUST|Bearer|sl_session|csrfToken/,
  );
  // Only this test pool is ended. Shared server/database stays running.
  await f.pool.end();
  assert.equal((await fetch(f.base + "/healthz")).status, 200);
  assert.equal((await fetch(f.base + "/readyz")).status, 503);
  assert.ok(f.records.some((r) => r.event === "database.unavailable"));
  // pg Pool.end is not idempotent; replace only cleanup after the observed failure.
  f.pool.end = async () => {};
});
test("real HTTP: spoofed forwarded IP cannot evade login quota; Retry-After is returned", async (t) => {
  const f = await fixture(t, { loginIp: 2 });
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await fetch(f.base + "/api/identity/login", {
          redirect: "manual",
          headers: { "X-Forwarded-For": `1.2.3.${i}` },
        })
      ).status,
      302,
    );
  const denied = await fetch(f.base + "/api/identity/login", {
    redirect: "manual",
    headers: { "X-Forwarded-For": "9.9.9.9" },
  });
  assert.equal(denied.status, 429);
  assert.ok(Number(denied.headers.get("retry-after")) > 0);
});
test("real HTTP: identity write and execution budgets; read/list do not spend execution quota", async (t) => {
  let accepted = 0;
  // Explicit adapter verifies host admission only, never claims real provider execution.
  const executionFactory: ExecutionFactory = () => ({
    start() {},
    async stop() {},
    async handle(req, res) {
      if (!req.url?.startsWith("/api/execution/")) return false;
      if (req.url.endsWith("/accept")) accepted++;
      res.writeHead(200);
      res.end("{}");
      return true;
    },
  });
  const f = await fixture(
      t,
      { executionUser: 1, writeUser: 3 },
      executionFactory,
    ),
    user = await f.login();
  assert.equal(
    (await f.post(user, "/api/execution/accept", { prompt: "private" })).status,
    200,
  );
  assert.equal((await f.post(user, "/api/execution/list", {})).status, 200);
  assert.equal((await f.post(user, "/api/execution/retry", {})).status, 429);
  assert.equal(accepted, 1);
  assert.equal(
    (await f.post(user, "/api/identity/createTeam", { name: "quota" })).status,
    200,
  );
  assert.equal(
    (await f.post(user, "/api/identity/createTeam", { name: "over quota" }))
      .status,
    429,
  );
});
test("real PG/SSE: connection quota releases; graceful shutdown closes streams; redeploy preserves users and published resources", async (t) => {
  const f = await fixture(t, { sseUser: 1 }),
    user = await f.login();
  const team = (
    await (
      await f.post(user, "/api/identity/createTeam", { name: "持久团队" })
    ).json()
  ).data;
  const actor = {
    userId: user.user.id,
    teamId: team.id,
    role: "admin" as const,
  };
  const { skill, draft } = await f.app.library.createSkill(actor, {
    name: "持久技能",
    description: "",
    maintainerIds: [],
    content: {
      files: [
        { path: "SKILL.md", mediaType: "text/markdown", content: "# retained" },
      ],
    },
  });
  const version = await f.app.library.publishDraft(actor, {
    draftId: draft.id,
    expectedRevision: draft.revision,
    expectedBaseVersionId: null,
    changeSummary: "one",
    idempotencyKey: randomUUID(),
  });
  const session = await f.app.runtime.createSession(actor);
  const task = await f.app.runtime.createTask(actor, session.id, randomUUID());
  const open = () =>
    fetch(f.base + `/api/events?teamId=${team.id}`, {
      headers: { Cookie: user.cookie },
    });
  const stream = await open();
  assert.equal(stream.status, 200);
  assert.equal((await open()).status, 429);
  const reader = stream.body!.getReader();
  await reader.read();
  await reader.cancel();
  // Wait for server-side disconnect notification, not an arbitrary long sleep.
  let next: Response | undefined;
  for (let i = 0; i < 20; i++) {
    next = await open();
    if (next.status === 200) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(next!.status, 200);
  const nextReader = next!.body!.getReader();
  await nextReader.read();
  const restarted = await f.restart();
  assert.equal(await f.app.isReady(), false);
  assert.equal(
    (await restarted.library.getVersion(actor, version.id)).content.files[0]
      .content,
    "# retained",
  );
  assert.equal(
    (await restarted.runtime.getTask(actor, task.taskId)).versions[skill.id],
    version.id,
  );
  assert.equal(
    (
      await fetch(f.base + "/api/identity/session", {
        headers: { Cookie: user.cookie },
      })
    ).status,
    200,
  );
  assert.ok(f.records.some((r) => r.event === "shutdown.completed"));
  // Stream may finish cleanly or be reset by the adapter's cancellation.
  try {
    while (!(await nextReader.read()).done) {}
  } catch {}
});
test("migration mismatch fails before listen and preserves ledger", async (t) => {
  const root = new Pool({ connectionString: databaseUrl }),
    schema = "ops_fail_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
  });
  try {
    await pool.query(
      "CREATE TABLE production_migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT now())",
    );
    await pool.query(
      "INSERT INTO production_migrations(version,checksum) VALUES(1,'tampered')",
    );
    await assert.rejects(
      createProductionApplication({
        pool,
        publicOrigin: "http://localhost",
        mode: "test",
        testProvider: {
          name: "test",
          authorizationUrl: () => "",
          exchange: async () => ({
            subject: "x",
            displayName: "x",
            verifiedEmail: null,
          }),
        },
        webDir: "/unused",
      }),
      /Unsupported or modified/,
    );
    assert.equal(
      (await pool.query("SELECT checksum FROM production_migrations")).rows[0]
        .checksum,
      "tampered",
    );
    assert.equal(
      (await pool.query("SELECT to_regclass('users') AS name")).rows[0].name,
      null,
    );
  } finally {
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  }
});

test(
  "shutdown closes unused TCP while draining an active write response",
  { timeout: 5000 },
  async (t) => {
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory: ExecutionFactory = () => ({
      start() {},
      async stop() {},
      async handle(req, res) {
        if (req.url !== "/api/execution/accept") return false;
        entered();
        await gate;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"saved":true}');
        return true;
      },
    });
    const f = await fixture(t, {}, factory),
      user = await f.login();
    const idle = createConnection({
      host: "127.0.0.1",
      port: Number(new URL(f.base).port),
    });
    await new Promise<void>((done, reject) => {
      idle.once("connect", done);
      idle.once("error", reject);
    });
    const idleClosed = new Promise<void>((done) =>
      idle.once("close", () => done()),
    );
    const request = f.post(user, "/api/execution/accept", {});
    await enteredPromise;
    const closing = f.app.close();
    release();
    const response = await request;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { saved: true });
    await Promise.all([closing, idleClosed]);
  },
);
