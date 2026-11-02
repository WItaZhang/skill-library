import test from "node:test";
import {once} from "node:events";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, fixtureProvider, deferred } from "./helpers.ts";
import { createExecutionRepository } from "../../persistence/execution.ts";
import { ProviderError } from "../provider.ts";
import { createStore } from "../../persistence/store.ts";

test("acceptance rollback removes snapshot, session and queue together; retries are idempotent", async (t) => {
  const f = await fixture(t);
  const input = f.input();
  await f.pool.query(
    "CREATE FUNCTION fail_accept() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fault'; END $$; CREATE TRIGGER fail_accept AFTER INSERT ON execution_requests FOR EACH ROW EXECUTE FUNCTION fail_accept()",
  );
  await assert.rejects(f.service.accept(f.a, input), { code: "UNAVAILABLE" });
  for (const table of [
    "runtime_sessions",
    "runtime_tasks",
    "execution_requests",
    "execution_receipts",
  ])
    assert.equal(
      (await f.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count,
      "0",
    );
  await f.pool.query("DROP TRIGGER fail_accept ON execution_requests");
  const values = await Promise.all([
    f.service.accept(f.a, input),
    f.make().accept(f.a, input),
  ]);
  assert.equal(values[0].id, values[1].id);
  assert.equal(
    (await f.pool.query("SELECT count(*) FROM runtime_tasks")).rows[0].count,
    "1",
  );
  await assert.rejects(f.service.accept(f.a, { ...input, prompt: "changed" }), {
    code: "CONFLICT",
  });
  await assert.rejects(
    f.service.accept(f.a, { ...f.input(), skillIds: [randomUUID()] }),
    { code: "VALIDATION" },
  );
  assert.equal(
    (await f.pool.query("SELECT count(*) FROM runtime_tasks")).rows[0].count,
    "1",
  );
});

test("concurrent workers claim once, remote call holds no team lock, new task gets latest while child/retry pins complete resources", async (t) => {
  const started = deferred<void>(),
    release = deferred<void>();
  let calls = 0;
  const seen: string[][] = [];
  const provider = {
    ...fixtureProvider,
    async execute(input: Parameters<typeof fixtureProvider.execute>[0]) {
      calls++;
      seen.push(input.skills[0].content.files.map((f) => f.content));
      started.resolve();
      await release.promise;
      return fixtureProvider.execute(input);
    },
  };
  const f = await fixture(t, provider);
  const original = await f.service.accept(f.a, f.input());
  const worker = f.service.runOnce();
  await started.promise;
  const v2 = await f.publish("v2"); // Would deadlock here if the remote call retained the team transaction.
  assert.equal(await f.make().runOnce(), false);
  release.resolve();
  await worker;
  assert.equal(calls, 1);
  assert.deepEqual(seen[0], ["v1", "resource v1"]);
  const complete = await f.service.get(f.a, original.id);
  assert.equal(complete.status, "succeeded");
  assert.equal(complete.result?.text, "v1");
  const fresh = await f.service.accept(f.a, f.input("fresh"));
  assert.equal(fresh.snapshot.versions[f.skill.id], v2.id);
  const child = await f.service.accept(f.a, {
    ...f.input("child"),
    parentTaskId: original.taskId,
  });
  assert.equal(child.snapshot.versions[f.skill.id], f.version.id);
  assert.deepEqual(child.snapshot.versions, original.snapshot.versions);
  await f.service.runOnce();
  await f.service.runOnce();
  assert.equal(calls, 3);
});

test("failed attempt explicit idempotent retry uses same task and version; cap blocks extra calls", async (t) => {
  let calls = 0;
  const f = await fixture(
    t,
    {
      ...fixtureProvider,
      async execute() {
        calls++;
        throw new ProviderError(
          "PROVIDER_RATE_LIMIT",
          false,
          "fixture-rate-limit",
        );
      },
    },
    { maxAttempts: 2 },
  );
  const original = await f.service.accept(f.a, f.input());
  await f.service.runOnce();
  await f.publish("v2");
  const retry = { executionId: original.id, idempotencyKey: randomUUID() };
  await Promise.all([f.service.retry(f.a, retry), f.make().retry(f.a, retry)]);
  await f.service.runOnce();
  const result = await f.service.get(f.a, original.id);
  assert.equal(result.taskId, original.taskId);
  assert.equal(result.snapshot.versions[f.skill.id], f.version.id);
  assert.deepEqual(
    result.attempts.map((a) => a.number),
    [1, 2],
  );
  assert.equal(calls, 2);
  await assert.rejects(
    f.service.retry(f.a, { ...retry, idempotencyKey: randomUUID() }),
    { code: "CONFLICT" },
  );
  assert.equal((await f.service.retry(f.a, retry)).id, original.id);
  assert.equal(await f.service.runOnce(), false);
});

test("claimed crash recovers without remote call; dispatched crash becomes uncertain; late result is fenced", async (t) => {
  const f = await fixture(t);
  const repo = () =>
    createExecutionRepository({
      pool: f.pool,
      provider: fixtureProvider.name,
      model: fixtureProvider.model,
      maxAttempts: 3,
      leaseMs: 1000,
    });
  const r = await f.service.accept(f.a, f.input());
  const first = await repo().claim();
  assert.ok(first);
  await f.pool.query(
    "UPDATE execution_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [first.attemptId],
  );
  assert.equal(await f.service.recover(), 1);
  assert.equal((await f.service.get(f.a, r.id)).status, "queued");
  assert.equal(await repo().begin(first), null);
  const second = await repo().claim();
  assert.ok(second);
  await repo().begin(second);
  await f.pool.query(
    "UPDATE execution_attempts SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [second.attemptId],
  );
  await f.service.recover();
  assert.equal((await f.service.get(f.a, r.id)).status, "uncertain");
  assert.equal(await f.service.runOnce(), false);
  await assert.rejects(
    f.service.retry(f.a, { executionId: r.id, idempotencyKey: randomUUID() }),
    { code: "CONFLICT" },
  );
  await f.service.retry(f.a, {
    executionId: r.id,
    idempotencyKey: randomUUID(),
    acknowledgeUncertain: true,
  });
  await f.service.runOnce();
  assert.equal(
    await repo().finish(second, {
      status: "succeeded",
      text: "late obsolete output",
    }),
    false,
  );
  const final = await f.service.get(f.a, r.id);
  assert.equal(final.result?.text, "v1");
  assert.equal(final.attempts.length, 3);
  assert.equal(
    (await f.pool.query("SELECT count(*) FROM execution_results")).rows[0]
      .count,
    "1",
  );
});

test("timeouts and stop bound noncooperative providers; no automatic retry", async (t) => {
  const f = await fixture(
    t,
    { ...fixtureProvider, execute: async () => new Promise(() => {}) },
    { timeoutMs: 40, leaseMs: 500 },
  );
  const r = await f.service.accept(f.a, f.input());
  await f.service.runOnce();
  assert.equal((await f.service.get(f.a, r.id)).status, "uncertain");
  assert.equal(await f.service.runOnce(), false);
  const started = deferred<void>();
  const s = f.make({
    ...fixtureProvider,
    execute: async () => {
      started.resolve();
      return new Promise(() => {});
    },
  });
  const r2 = await s.accept(f.a, f.input("shutdown"));
  s.start();
  await started.promise;
  await s.stop();
  assert.equal((await s.get(f.a, r2.id)).status, "uncertain");
});

test("cancellation fences late response; explicitly acknowledged retry preserves version", async (t) => {
  const started = deferred<void>(),
    release = deferred<void>();
  const f = await fixture(t, {
    ...fixtureProvider,
    async execute(i) {
      started.resolve();
      await release.promise;
      return fixtureProvider.execute(i);
    },
  });
  const r = await f.service.accept(f.a, f.input());
  const run = f.service.runOnce();
  await started.promise;
  await f.service.cancel(f.a, r.id);
  release.resolve();
  await run;
  const cancelled = await f.service.get(f.a, r.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.result, null);
  await assert.rejects(
    f.service.retry(f.a, { executionId: r.id, idempotencyKey: randomUUID() }),
    { code: "CONFLICT" },
  );
  await f.service.retry(f.a, {
    executionId: r.id,
    idempotencyKey: randomUUID(),
    acknowledgeUncertain: true,
  });
  await f.service.runOnce();
  assert.equal((await f.service.get(f.a, r.id)).status, "succeeded");
});

test("owner/team isolation and actual role recheck; revoked queued and running tasks never publish results", async (t) => {
  const started = deferred<void>(),
    release = deferred<void>();
  let calls = 0;
  const f = await fixture(t, {
    ...fixtureProvider,
    async execute(i) {
      calls++;
      started.resolve();
      await release.promise;
      return fixtureProvider.execute(i);
    },
  });
  await assert.rejects(f.service.accept({ ...f.v, role: "admin" }, f.input()), {
    code: "FORBIDDEN",
  });
  const r = await f.service.accept(f.b, f.input());
  await assert.rejects(f.service.get(f.a, r.id), { code: "NOT_FOUND" });
  await assert.rejects(f.service.get(f.other, r.id), { code: "NOT_FOUND" });
  const queued = await f.service.accept(f.b, f.input("queued"));
  const run = f.service.runOnce();
  await started.promise;
  await f.pool.query(
    "UPDATE team_memberships SET status='removed' WHERE user_id=$1",
    [f.b.userId],
  );
  await assert.rejects(f.service.get(f.b, r.id), { code: "FORBIDDEN" });
  release.resolve();
  await run;
  await f.service.recover();
  assert.equal(await f.service.runOnce(), false);
  assert.equal(calls, 1);
  for (const id of [r.id, queued.id])
    assert.equal(
      (
        await f.pool.query(
          "SELECT status FROM execution_requests WHERE id=$1",
          [id],
        )
      ).rows[0].status,
      "cancelled",
    );
  assert.equal(
    (await f.pool.query("SELECT count(*) FROM execution_results")).rows[0]
      .count,
    "0",
  );
});

test("checksum mismatch prevents dispatch; result and relation constraints reject tampering", async (t) => {
  const f = await fixture(t);
  const r = await f.service.accept(f.a, f.input());
  await f.pool.query("ALTER TABLE versions DISABLE TRIGGER versions_immutable");
  await f.pool.query(
    "UPDATE versions SET data=jsonb_set(data,'{content,files,0,content}','\"corrupt\"') WHERE id=$1",
    [f.version.id],
  );
  await f.pool.query("ALTER TABLE versions ENABLE TRIGGER versions_immutable");
  await f.service.runOnce();
  const final = await f.service.get(f.a, r.id);
  assert.equal(final.status, "failed");
  assert.equal(final.attempts[0].errorCode, "RESOURCE_MISSING");
  await assert.rejects(
    f.pool.query("UPDATE execution_requests SET prompt='mutated' WHERE id=$1", [
      r.id,
    ]),
    { code: "23514" },
  );
  await assert.rejects(
    f.pool.query(
      "INSERT INTO execution_results(attempt_id,team_id,execution_id,text) VALUES($1,$2,$3,$4)",
      [randomUUID(), f.other.teamId, r.id, "foreign"],
    ),
    { code: "23503" },
  );
  await assert.rejects(
    f.pool.query(
      "UPDATE execution_skills SET team_id=$1 WHERE execution_id=$2",
      [f.other.teamId, r.id],
    ),
    { code: "23514" },
  );
});

test("nested unit-of-work cannot cross actor or upgrade readonly, queue is bounded", async (t) => {
  const f = await fixture(t);
  const outer = createStore(f.pool),
    inner = createStore(f.pool);
  await assert.rejects(
    outer.transaction(f.a, false, () =>
      inner.transaction(f.a, true, async () => true),
    ),
    { code: "FORBIDDEN" },
  );
  await assert.rejects(
    outer.transaction(f.a, true, () =>
      inner.transaction(f.b, true, async () => true),
    ),
    { code: "FORBIDDEN" },
  );
  for (let i = 0; i < 10; i++)
    await f.service.accept(f.a, f.input(`task ${i}`));
  await assert.rejects(f.service.accept(f.a, f.input("over limit")), {
    code: "CONFLICT",
  });
});

test("independent worker process crash after dispatch recovers as uncertain without duplicate generation", async (t) => {
  const { fork } = await import("node:child_process");
  const f = await fixture(t);
  const r = await f.service.accept(f.a, f.input());
  const child = fork(
    new URL("./process-worker.ts", import.meta.url),
    [
      JSON.stringify({
        options: `-c search_path=${f.schema}`,
        executionId: r.id,
      }),
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  t.after(() => {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  });
  assert.equal((await once(child, "message"))[0], "ready");
  const dispatched = once(child, "message");
  child.send("run");
  assert.equal((await dispatched)[0], "dispatched");
  const exit = once(child, "exit");
  child.kill("SIGKILL");
  await exit;
  // Make lease expiry deterministic; the process really died, no fixture response is delivered.
  await f.pool.query(
    "UPDATE execution_attempts SET lease_expires_at=now()-interval '1 second' WHERE execution_id=$1",
    [r.id],
  );
  const freshProcessService = f.make();
  assert.equal(await freshProcessService.recover(), 1);
  assert.equal(await freshProcessService.runOnce(), false);
  const final = await freshProcessService.get(f.a, r.id);
  assert.equal(final.status, "uncertain");
  assert.equal(final.attempts.length, 1);
  assert.equal(final.result, null);
});

test("targeted runOnce only runs the explicitly accepted demo task; received provider request id survives timeout", async (t) => {
  const provider = {
    ...fixtureProvider,
    async execute(input: Parameters<typeof fixtureProvider.execute>[0]) {
      await input.onRequestId?.("req_observed_before_timeout");
      return new Promise<never>(() => {});
    },
  };
  const f = await fixture(t, provider, { timeoutMs: 40, leaseMs: 500 });
  const older = await f.service.accept(f.a, f.input("older")),
    target = await f.service.accept(f.a, f.input("demo target"));
  await f.service.runOnce(target.id);
  assert.equal((await f.service.get(f.a, older.id)).status, "queued");
  const result = await f.service.get(f.a, target.id);
  assert.equal(result.status, "uncertain");
  assert.equal(
    result.attempts[0].providerRequestId,
    "req_observed_before_timeout",
  );
});

test("shutdown during resource preparation never dispatches and has no unhandled abort rejection", async (t) => {
  const f = await fixture(t);
  const r = await f.service.accept(f.a, f.input());
  // Stop synchronously while claim's initial recovery query is in flight.
  const work = f.service.runOnce(r.id);
  await f.service.stop();
  await work;
  const result = await f.service.get(f.a, r.id);
  assert.notEqual(result.status, "succeeded");
  assert.equal(
    (await f.pool.query("SELECT count(*) FROM execution_results")).rows[0]
      .count,
    "0",
  );
});
