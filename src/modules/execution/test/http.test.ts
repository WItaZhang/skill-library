import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { fixture } from "./helpers.ts";
import { createIdentityService } from "../../identity/service.ts";
import { createExecutionHttpHandler } from "../http.ts";
import { createExecutionClient } from "../client.ts";
import { DomainError } from "../../../contracts/index.ts";

test("real HTTP + PG identity cookie/CSRF, injection rejection, owner reads and cost hook", async (t) => {
  const f = await fixture(t);
  let handler: ReturnType<typeof createExecutionHttpHandler>;
  const server = createServer(async (req, res) => {
    try {
      if (!(await handler(req, res))) {
        res.statusCode = 404;
        res.end();
      }
    } catch {
      res.statusCode = 500;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const identity = createIdentityService({
    pool: f.pool,
    publicOrigin: origin,
    mode: "test",
    testProvider: {
      name: "fixture",
      authorizationUrl: () => "",
      exchange: async () => ({
        subject: "unused",
        displayName: "fixture",
        verifiedEmail: null,
      }),
    },
  });
  const token = randomBytes(32).toString("base64url"),
    hash = (v: string) => createHash("sha256").update(v).digest("hex");
  await f.pool.query(
    "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [randomUUID(), f.b.userId, hash(token)],
  );
  let forbid = false;
  const operations: string[] = [];
  handler = createExecutionHttpHandler({
    execution: f.service,
    identity,
    beforeRequest: ({ actor, operation }) => {
      assert.equal(actor.userId, f.b.userId);
      operations.push(operation);
      if (forbid) throw new DomainError("CONFLICT", "执行配额不足");
    },
  });
  const headers = {
    Cookie: `sl_session=${token}`,
    Origin: origin,
    "Content-Type": "application/json",
    "X-CSRF-Token": hash("csrf:" + token),
    "X-Team-Id": f.a.teamId,
  };
  const raw = (
    method: string,
    input: unknown,
    override: Record<string, string> = {},
  ) =>
    fetch(`${origin}/api/execution/${method}`, {
      method: "POST",
      headers: { ...headers, ...override },
      body: JSON.stringify(input),
    });
  assert.equal(
    (await raw("accept", f.input(), { "X-CSRF-Token": "invalid" })).status,
    403,
  );
  assert.equal((await raw("accept", { ...f.input(), actor: f.a })).status, 400);
  assert.equal((await raw("constructor", {})).status, 404);
  const transport: typeof fetch = (url, init) =>
    fetch(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers)),
        Cookie: headers.Cookie,
        Origin: origin,
      },
    });
  let closed = false;
  const client = createExecutionClient({
    baseUrl: origin,
    teamId: f.a.teamId,
    csrfToken: headers["X-CSRF-Token"],
    fetch: transport,
    onForbidden: () => {
      closed = true;
    },
  });
  const input = f.input();
  const accepted = await client.accept(input);
  assert.equal((await client.accept(input)).id, accepted.id);
  await f.service.runOnce();
  assert.equal((await client.get(accepted.id)).result?.text, "v1");
  assert.equal((await client.list()).length, 1);
  // Raw prompt bytes and JSON transport bytes differ for escaped characters.
  const maximumPrompt = "x" + "\u0001".repeat(16383);
  const maximum = await client.accept({ ...f.input(), prompt: maximumPrompt });
  assert.equal((await client.get(maximum.id)).prompt, maximumPrompt);
  await client.cancel(maximum.id);
  await assert.rejects(client.accept({ ...f.input(), prompt: maximumPrompt + "x" }), {
    code: "VALIDATION",
  });
  forbid = true;
  await assert.rejects(client.accept(f.input("rate limited")), {
    code: "CONFLICT",
  });
  forbid = false;
  assert.ok(operations.includes("accept"));
  assert.ok(operations.includes("get"));
  await f.pool.query(
    "UPDATE team_memberships SET role='viewer' WHERE user_id=$1",
    [f.b.userId],
  );
  await assert.rejects(client.list(), { code: "FORBIDDEN" });
  assert.equal(closed, true);
  await assert.rejects(client.get(accepted.id), { code: "FORBIDDEN" });
  client.dispose();
});
test("browser disposal rejects late response and sends immutable identity scope", async () => {
  let finish!: (r: Response) => void;
  let signal: AbortSignal | undefined;
  const client = createExecutionClient({
    teamId: "team",
    csrfToken: "csrf",
    fetch: async (_url, init) => {
      signal = init?.signal as AbortSignal;
      assert.equal(new Headers(init?.headers).get("X-Team-Id"), "team");
      return new Promise((r) => {
        finish = r;
      });
    },
  });
  const pending = client.list();
  client.dispose();
  assert.equal(signal?.aborted, true);
  finish(new Response(JSON.stringify({ data: ["private late data"] })));
  await assert.rejects(pending, { code: "FORBIDDEN" });
  await assert.rejects(client.list(), { code: "FORBIDDEN" });
});
