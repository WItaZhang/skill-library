import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { Pool } from "pg";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL required; process acceptance never skips PG");
async function freePort() {
  const s = createServer();
  await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((done) => s.close(() => done()));
  return port;
}
test(
  "actual production process: shared PG migration, execution module mounting without calls, SIGTERM, persistent restart",
  { timeout: 20000 },
  async () => {
    const root = new Pool({ connectionString: databaseUrl });
    const schema = "ops_process_" + randomUUID().replaceAll("-", "");
    await root.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: url.href });
    const children: ReturnType<typeof spawn>[] = [];
    const logs: string[] = [];
    async function start() {
      const port = await freePort();
      const child = spawn(
        process.execPath,
        [resolve("src/integration/production-start.ts")],
        {
          env: {
            ...process.env,
            NODE_ENV: "production",
            DATABASE_URL: url.href,
            DATABASE_URL_FILE: "",
            PUBLIC_ORIGIN: "https://process.example.test",
            PORT: String(port),
            GITHUB_CLIENT_ID: "fixture-no-oauth-call",
            GITHUB_CLIENT_SECRET: "fixture-no-oauth-call",
            GITHUB_CLIENT_SECRET_FILE: "",
            METRICS_TOKEN: "fixture-metrics-01234567890123456789",
            METRICS_TOKEN_FILE: "",
            EXECUTION_ENABLED: "true",
            ANTHROPIC_API_KEY: "fixture-no-provider-call",
            ANTHROPIC_API_KEY_FILE: "",
            EXECUTION_MODEL: "fixture-no-provider-call",
            SHUTDOWN_TIMEOUT_MS: "3000",
            RELEASE_SHA: "process-acceptance",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(child);
      const exited = new Promise<number | null>((done, reject) => {
        child.once("exit", done);
        child.once("error", reject);
      });
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(
          () => reject(new Error("production process did not become ready")),
          8000,
        );
        let buffer = "";
        child.stdout!.on("data", (chunk) => {
          const text = chunk.toString();
          logs.push(text);
          buffer += text;
          if (buffer.includes("server.started")) {
            clearTimeout(timer);
            done();
          }
        });
        child.stderr!.on("data", (chunk) => logs.push(chunk.toString()));
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`production process exited before ready: ${code}`));
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      return {
        base: `http://127.0.0.1:${port}`,
        async stop() {
          child.kill("SIGTERM");
          assert.equal(await exited, 0);
        },
      };
    }
    try {
      const first = await start();
      assert.equal((await fetch(first.base + "/readyz")).status, 200);
      assert.equal((await fetch(first.base + "/")).status, 200);
      assert.equal(
        (
          await fetch(first.base + "/api/execution/list", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
        403,
        "real execution handler mounted; no model request",
      );
      const userId = randomUUID();
      await pool.query("INSERT INTO users(id,display_name) VALUES($1,$2)", [
        userId,
        "进程重启保留",
      ]);
      await first.stop();
      const second = await start();
      assert.equal((await fetch(second.base + "/readyz")).status, 200);
      assert.equal(
        (
          await pool.query("SELECT display_name FROM users WHERE id=$1", [
            userId,
          ])
        ).rows[0].display_name,
        "进程重启保留",
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM execution_attempts")).rows[0]
          .count,
        "0",
        "startup never generates a model call",
      );
      await second.stop();
      assert.ok(logs.some((l) => l.includes("shutdown.completed")));
      assert.doesNotMatch(
        logs.join(""),
        /fixture-no-provider-call|fixture-no-oauth-call|fixture-metrics/,
      );
    } finally {
      await Promise.all(
        children
          .filter((c) => c.exitCode === null && c.signalCode === null)
          .map(
            (c) =>
              new Promise<void>((done) => {
                c.once("exit", () => done());
                c.kill("SIGKILL");
              }),
          ),
      );
      await pool.end();
      await root.query(`DROP SCHEMA ${schema} CASCADE`);
      await root.end();
    }
  },
);
