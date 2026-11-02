import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { loadConfig, secret } from "../config.ts";
import { WindowLimiter, clientIp, isWrite } from "../rate-limit.ts";
import { authorizedMetrics, routeLabel, safeErrorCode } from "../telemetry.ts";
const env = {
  DATABASE_URL: "postgresql://app:secret@db/app",
  PUBLIC_ORIGIN: "https://skills.example.test",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "oauth-secret",
  METRICS_TOKEN: "a".repeat(32),
};
test("production config rejects missing/insecure/malformed settings; secrets can only have one source", () => {
  assert.equal(loadConfig(env).port, 8080);
  for (const patch of [
    { PUBLIC_ORIGIN: "http://localhost" },
    { PUBLIC_ORIGIN: "https://a.test/path" },
    { PORT: "NaN" },
    { EXECUTION_ENABLED: "yes" },
    { EXECUTION_ENABLED: "true" },
    { METRICS_TOKEN: "short" },
    { TRUSTED_PROXY_IPS: "0.0.0.0/0" },
    { NODE_ENV: "test" },
    { DATABASE_URL: "sqlite:///tmp/x" },
  ])
    assert.throws(() => loadConfig({ ...env, ...patch }));
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
  const dir = mkdtempSync(join(tmpdir(), "operations-secret-"));
  try {
    const file = join(dir, "secret");
    writeFileSync(file, "opaque-value\n", { mode: 0o600 });
    assert.equal(secret({ TOKEN_FILE: file }, "TOKEN"), "opaque-value");
    assert.throws(() => secret({ TOKEN: "a", TOKEN_FILE: file }, "TOKEN"));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("fixed windows expire; principal churn cannot evict an active budget", () => {
  let now = 0;
  const limiter = new WindowLimiter(2, () => now);
  assert.equal(limiter.take("a", 1, 1000), 0);
  assert.equal(limiter.take("a", 1, 1000), 1);
  assert.equal(limiter.take("b", 1, 1000), 0);
  assert.equal(limiter.take("c", 1, 1000), 1);
  assert.equal(limiter.take("a", 1, 1000), 1);
  now = 1001;
  assert.equal(limiter.take("c", 1, 1000), 0);
  assert.equal(limiter.take("a", 1, 1000), 0);
});
test("only exact trusted proxy peer and single canonical IP can affect client address", () => {
  const request = (peer: string, forwarded: string) =>
    ({
      socket: { remoteAddress: peer },
      headers: { "x-forwarded-for": forwarded },
    }) as unknown as IncomingMessage;
  assert.equal(
    clientIp(request("::ffff:127.0.0.1", "1.2.3.4"), []),
    "127.0.0.1",
  );
  assert.equal(
    clientIp(request("127.0.0.1", "1.2.3.4"), ["127.0.0.1"]),
    "1.2.3.4",
  );
  assert.equal(
    clientIp(request("127.0.0.1", "1.2.3.4, 5.6.7.8"), ["127.0.0.1"]),
    "127.0.0.1",
  );
  assert.equal(
    clientIp(request("127.0.0.1", "attacker"), ["127.0.0.1"]),
    "127.0.0.1",
  );
});
test("write classification and metric/error labels are bounded and secret-free", () => {
  assert.equal(isWrite("/api/library/saveDraft", "POST"), true);
  assert.equal(isWrite("/api/execution/accept", "POST"), true);
  assert.equal(isWrite("/api/execution/list", "POST"), false);
  assert.equal(isWrite("/api/library/listSkills", "POST"), false);
  assert.equal(routeLabel("/api/identity/callback"), "callback");
  assert.equal(routeLabel("/secret-token"), "static");
  assert.equal(safeErrorCode(new Error("secret-password")), "INTERNAL");
  assert.equal(safeErrorCode({ code: "secret-token" }), "INTERNAL");
  assert.equal(
    authorizedMetrics("Bearer " + env.METRICS_TOKEN, env.METRICS_TOKEN),
    true,
  );
  assert.equal(authorizedMetrics("Bearer wrong", env.METRICS_TOKEN), false);
});
