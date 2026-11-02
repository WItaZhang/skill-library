import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createProductionApplication } from "./production-server.ts";
import { loadConfig } from "../modules/operations/config.ts";
import { jsonLog, safeErrorCode } from "../modules/operations/telemetry.ts";
import { productionExecutionFactory } from "../modules/operations/execution.ts";

let pool: Pool | undefined;
try {
  const config = loadConfig();
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    query_timeout: 16000,
    application_name: "skill-library",
  });
  const app = await createProductionApplication({
    pool,
    publicOrigin: config.publicOrigin,
    github: config.github,
    webDir: fileURLToPath(new URL("../modules/product/dist/", import.meta.url)),
    executionFactory: config.execution
      ? productionExecutionFactory(config.execution)
      : undefined,
    operations: {
      metricsToken: config.metricsToken,
      trustedProxyIps: config.trustedProxyIps,
      shutdownMs: config.shutdownMs,
    },
  });
  let stopping = false;
  async function shutdown(signal: string, fatal = false) {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      jsonLog({
        time: new Date().toISOString(),
        level: "error",
        event: "shutdown.timeout",
      });
      process.exit(1);
    }, config.shutdownMs + 1000);
    try {
      await app.close();
      await pool!.end();
      clearTimeout(deadline);
      process.exitCode = fatal ? 1 : 0;
    } catch {
      jsonLog({
        time: new Date().toISOString(),
        level: "error",
        event: "shutdown.failed",
        code: signal,
      });
      process.exit(1);
    }
  }
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void shutdown(signal));
  process.once("uncaughtException", () => {
    jsonLog({
      time: new Date().toISOString(),
      level: "error",
      event: "process.uncaught_exception",
    });
    void shutdown("UNCAUGHT", true);
  });
  process.once("unhandledRejection", () => {
    jsonLog({
      time: new Date().toISOString(),
      level: "error",
      event: "process.unhandled_rejection",
    });
    void shutdown("UNHANDLED", true);
  });
  await new Promise<void>((done, reject) => {
    app.server.once("error", reject);
    app.server.listen(config.port, "0.0.0.0", done);
  });
  jsonLog({
    time: new Date().toISOString(),
    level: "info",
    event: "server.started",
    release: config.release,
  });
} catch (error) {
  // Configuration errors name the field; never dump exception messages containing URLs/secrets.
  jsonLog({
    time: new Date().toISOString(),
    level: "error",
    event: "startup.failed",
    code: safeErrorCode(error),
  });
  await pool?.end();
  process.exitCode = 1;
}
