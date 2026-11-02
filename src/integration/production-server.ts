import { createServer } from "node:http";
import type { Socket } from "node:net";
import { readFile, stat, realpath } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import type { Pool } from "pg";
import {
  createIdentityService,
  createIdentityHttpHandler,
} from "../modules/identity/index.ts";
import type { IdentityOptions } from "../modules/identity/types.ts";
import {
  migrate,
  createPostgresLibraryService,
  createPostgresRuntimeService,
} from "../modules/persistence/index.ts";
import { createProductionLibraryHandler } from "./production-http.ts";
import {
  createTelemetry,
  authorizedMetrics,
  safeErrorCode,
  type LogSink,
} from "../modules/operations/telemetry.ts";
import {
  createAdmission,
  type Limits,
} from "../modules/operations/rate-limit.ts";
import type { ExecutionFactory } from "../modules/operations/execution.ts";

/** Production composition has no demo authentication or SQLite fallback. Caller owns Pool. */
export async function createProductionApplication(
  options: IdentityOptions & {
    pool: Pool;
    webDir: string;
    pollIntervalMs?: number;
    executionFactory?: ExecutionFactory;
    operations?: {
      logger?: LogSink;
      metricsToken?: string;
      trustedProxyIps?: string[];
      limits?: Partial<Limits>;
      shutdownMs?: number;
    };
  },
) {
  const telemetry = createTelemetry(options.operations?.logger);
  const identity = createIdentityService(options);
  // Complete migration before returning a listenable server. No partial availability.
  await migrate(options.pool);
  const library = createPostgresLibraryService({ pool: options.pool });
  const runtime = createPostgresRuntimeService({ pool: options.pool });
  const identities = createIdentityHttpHandler({ identity });
  const transport = createProductionLibraryHandler({
    library,
    runtime,
    resolveActor: (req) => identity.resolveActor(req),
    assertCsrf: (req) => identity.assertCsrf(req),
    publicOrigin: options.publicOrigin,
    pollIntervalMs: options.pollIntervalMs,
  });
  const execution = await options.executionFactory?.({
    pool: options.pool,
    identity,
    onError: (code) => telemetry.executionFailure(code),
  });
  const admit = createAdmission({ identity, telemetry, ...options.operations });
  let closing = false,
    lastReady = true,
    readiness: Promise<boolean> | undefined,
    readyUntil = 0;
  async function isReady() {
    if (closing) return false;
    if (Date.now() < readyUntil) return lastReady;
    if (!readiness)
      readiness = (async () => {
        try {
          const query = { text: "SELECT 1", query_timeout: 1500 };
          await options.pool.query(query);
          lastReady = true;
        } catch (e) {
          lastReady = false;
          telemetry.write({
            event: "database.unavailable",
            level: "error",
            code: safeErrorCode(e),
          });
        } finally {
          readyUntil = Date.now() + 1000;
          readiness = undefined;
        }
        return lastReady && !closing;
      })();
    return readiness;
  }
  const sockets = new Map<Socket, number>();
  const server = createServer(
    {
      requestTimeout: 15000,
      headersTimeout: 10000,
      keepAliveTimeout: 5000,
      maxHeaderSize: 16384,
    },
    async (req, res) => {
      const socket = req.socket;
      sockets.set(socket, (sockets.get(socket) ?? 0) + 1);
      let released = false;
      const releaseSocket = () => {
        if (released) return;
        released = true;
        if (!sockets.has(socket)) return;
        const active = Math.max(0, sockets.get(socket)! - 1);
        sockets.set(socket, active);
        if (closing && active === 0) socket.end();
      };
      res.once("finish", releaseSocket);
      res.once("close", releaseSocket);
      let path: string;
      try {
        path = new URL(req.url ?? "/", options.publicOrigin).pathname;
      } catch {
        path = "/invalid";
      }
      const requestId = telemetry.begin(req, res, path);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      if (options.publicOrigin.startsWith("https:"))
        res.setHeader("Strict-Transport-Security", "max-age=31536000");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(body));
      };
      try {
        if (path === "/healthz" && req.method === "GET") {
          json(200, { status: "ok" });
          return;
        }
        if (path === "/readyz" && req.method === "GET") {
          const ready = await isReady();
          json(ready ? 200 : 503, { status: ready ? "ready" : "unavailable" });
          return;
        }
        if (path === "/metrics" && req.method === "GET") {
          if (
            !authorizedMetrics(
              req.headers.authorization,
              options.operations?.metricsToken,
            )
          ) {
            json(404, {
              error: { code: "NOT_FOUND", message: "接口不存在。" },
            });
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/plain; version=0.0.4",
            "Cache-Control": "no-store",
          });
          res.end(telemetry.render(lastReady && !closing, options.pool));
          return;
        }
        if (closing) {
          res.setHeader("Connection", "close");
          json(503, {
            error: {
              code: "UNAVAILABLE",
              message: "服务正在重新部署，请稍后重试。",
            },
            requestId,
          });
          return;
        }
        if (!(await admit(req, res, path))) return;
        if (await identities(req, res)) return;
        if (await execution?.handle(req, res)) return;
        if (path.startsWith("/api/execution/")) {
          json(503, {
            error: {
              code: "UNAVAILABLE",
              message: "执行服务尚未配置，请联系管理员。",
            },
            requestId,
          });
          return;
        }
        if (await transport.handle(req, res)) return;
        if (path.startsWith("/api/") || req.method !== "GET") {
          json(404, { error: { code: "NOT_FOUND", message: "接口不存在。" } });
          return;
        }
        const root = await realpath(resolve(options.webDir));
        let file = resolve(
          root,
          path === "/" ? "index.html" : `.${decodeURIComponent(path)}`,
        );
        if (!file.startsWith(root + sep)) {
          json(404, { error: { code: "NOT_FOUND", message: "文件不存在。" } });
          return;
        }
        // Also refuse symlink escapes, even if an artifact unexpectedly contains one.
        file = await realpath(file);
        if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) {
          json(404, { error: { code: "NOT_FOUND", message: "文件不存在。" } });
          return;
        }
        const types: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".svg": "image/svg+xml",
        };
        const data = await readFile(file);
        res.writeHead(200, {
          "Content-Type": types[extname(file)] ?? "application/octet-stream",
          "Cache-Control":
            extname(file) === ".html" ? "no-store" : "public, max-age=3600",
        });
        res.end(data);
      } catch (error) {
        if (res.headersSent || res.destroyed) {
          res.destroy();
          return;
        }
        if (error instanceof URIError) {
          json(400, { error: { code: "VALIDATION", message: "路径无效。" } });
          return;
        }
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          ["ENOENT", "ENOTDIR"].includes(String(error.code))
        ) {
          json(404, { error: { code: "NOT_FOUND", message: "文件不存在。" } });
          return;
        }
        telemetry.write({
          event: "request.failure",
          level: "error",
          requestId,
          code: safeErrorCode(error),
        });
        json(503, {
          error: { code: "UNAVAILABLE", message: "服务暂时不可用，请重试。" },
          requestId,
        });
      }
    },
  );
  server.on("connection", (socket) => {
    sockets.set(socket, 0);
    socket.once("close", () => sockets.delete(socket));
    if (closing) socket.destroy();
  });
  server.maxRequestsPerSocket = 1000;
  server.once("listening", () => execution?.start());
  const onPoolError = (e: Error) => {
    lastReady = false;
    readyUntil = 0;
    telemetry.write({
      event: "database.pool_error",
      level: "error",
      code: safeErrorCode(e),
    });
  };
  options.pool.on("error", onPoolError);
  let closePromise: Promise<void> | undefined;
  return {
    server,
    identity,
    library,
    runtime,
    telemetry,
    isReady,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      lastReady = false;
      telemetry.write({ event: "shutdown.started", level: "info" });
      closePromise = (async () => {
        transport.closeEvents();
        const drained = new Promise<void>((done, reject) => {
          if (!server.listening) {
            done();
            return;
          }
          server.close((e) => (e ? reject(e) : done()));
          server.closeIdleConnections();
          // Node 24 can retain a client's replacement TCP connection which has sent no
          // HTTP request yet. Close these idle sockets without cutting off active writes.
          for (const [socket, active] of sockets)
            if (active === 0) socket.destroy();
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([drained, execution?.stop()]),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                server.closeAllConnections();
                reject(new Error("Shutdown deadline exceeded"));
              }, options.operations?.shutdownMs ?? 20000);
            }),
          ]);
          telemetry.write({ event: "shutdown.completed", level: "info" });
        } finally {
          if (timer) clearTimeout(timer);
          transport.close();
          options.pool.off("error", onPoolError);
        }
      })();
      return closePromise;
    },
  };
}
