import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
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

/** Production composition has no demo authentication or SQLite fallback. Caller owns Pool. */
export async function createProductionApplication(
  options: IdentityOptions & {
    pool: Pool;
    webDir: string;
    pollIntervalMs?: number;
  },
) {
  const identity = createIdentityService(options);
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
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    try {
      if (await identities(req, res)) return;
      if (await transport.handle(req, res)) return;
      const path = new URL(req.url ?? "/", options.publicOrigin).pathname;
      if (path === "/healthz") {
        await options.pool.query("SELECT 1");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"status":"ok"}');
        return;
      }
      if (path.startsWith("/api/") || req.method !== "GET") {
        res.writeHead(404);
        res.end("接口不存在");
        return;
      }
      const root = resolve(options.webDir);
      const file = resolve(
        root,
        path === "/" ? "index.html" : `.${decodeURIComponent(path)}`,
      );
      if (!file.startsWith(root + sep)) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (!(await stat(file)).isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
      };
      res.writeHead(200, {
        "Content-Type": types[extname(file)] ?? "application/octet-stream",
        "Cache-Control":
          extname(file) === ".html" ? "no-store" : "public, max-age=3600",
      });
      res.end(await readFile(file));
    } catch {
      if (!res.headersSent) res.writeHead(503);
      res.end("服务暂时不可用，请重试。");
    }
  });
  return {
    server,
    identity,
    library,
    runtime,
    async close() {
      transport.close();
      await new Promise<void>((done, reject) =>
        server.close((e) => (e ? reject(e) : done())),
      );
    },
  };
}
