import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DomainError,
  type Actor,
  type RuntimeService,
} from "../contracts/index.ts";
import type { ProductionLibraryService } from "../contracts/production.ts";
import { createLibraryHttpHandler } from "../modules/broadcast/server.ts";

/** Explicit additive transport; never dispatch a user-selected service property. */
export function createProductionLibraryHandler(options: {
  library: ProductionLibraryService;
  runtime: RuntimeService;
  resolveActor: (req: IncomingMessage) => Promise<Actor>;
  assertCsrf: (req: IncomingMessage) => Promise<void>;
  publicOrigin: string;
  pollIntervalMs?: number;
}) {
  const legacy = createLibraryHttpHandler({
    ...options,
    allowedOrigins: [options.publicOrigin],
  });
  const service = options.library;
  const routes = new Map<
    string,
    {
      min: number;
      max: number;
      run: (actor: Actor, args: any[]) => Promise<unknown>;
    }
  >([
    [
      "listManagedSkills",
      {
        min: 0,
        max: 1,
        run: (a, args) => service.listManagedSkills(a, args[0]),
      },
    ],
    [
      "listDrafts",
      { min: 1, max: 1, run: (a, args) => service.listDrafts(a, args[0]) },
    ],
    [
      "updateSkill",
      { min: 1, max: 1, run: (a, args) => service.updateSkill(a, args[0]) },
    ],
    [
      "archiveSkill",
      { min: 1, max: 1, run: (a, args) => service.archiveSkill(a, args[0]) },
    ],
    [
      "restoreSkill",
      { min: 1, max: 1, run: (a, args) => service.restoreSkill(a, args[0]) },
    ],
  ]);
  const runtimeRoutes = new Map<
    string,
    {
      min: number;
      max: number;
      run: (actor: Actor, args: any[]) => Promise<unknown>;
    }
  >([
    [
      "createSession",
      { min: 0, max: 0, run: (a) => options.runtime.createSession(a) },
    ],
    [
      "createTask",
      {
        min: 2,
        max: 2,
        run: (a, v) => options.runtime.createTask(a, v[0], v[1]),
      },
    ],
    [
      "getTask",
      { min: 1, max: 1, run: (a, v) => options.runtime.getTask(a, v[0]) },
    ],
    [
      "createChildTask",
      {
        min: 2,
        max: 2,
        run: (a, v) => options.runtime.createChildTask(a, v[0], v[1]),
      },
    ],
    [
      "resolveSkill",
      {
        min: 2,
        max: 2,
        run: (a, v) => options.runtime.resolveSkill(a, v[0], v[1]),
      },
    ],
    [
      "recordInvocation",
      {
        min: 2,
        max: 2,
        run: (a, v) => options.runtime.recordInvocation(a, v[0], v[1]),
      },
    ],
    [
      "listInvocations",
      {
        min: 1,
        max: 1,
        run: (a, v) => options.runtime.listInvocations(a, v[0]),
      },
    ],
    [
      "getSessionUpdates",
      {
        min: 1,
        max: 1,
        run: (a, v) => options.runtime.getSessionUpdates(a, v[0]),
      },
    ],
    [
      "setPreference",
      { min: 1, max: 1, run: (a, v) => options.runtime.setPreference(a, v[0]) },
    ],
  ]);
  function error(res: ServerResponse, e: unknown) {
    const domain =
      e instanceof DomainError
        ? e
        : new DomainError("UNAVAILABLE", "服务暂时不可用，请重试。");
    const status = {
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      STALE_REVISION: 409,
      CONFLICT: 409,
      VALIDATION: 400,
      RESOURCE_MISSING: 422,
      UNAVAILABLE: 503,
    }[domain.code];
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({ error: { code: domain.code, message: domain.message } }),
    );
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", options.publicOrigin).pathname;
    if (
      !path.startsWith("/api/library/") &&
      !path.startsWith("/api/management/") &&
      !path.startsWith("/api/runtime/") &&
      path !== "/api/events"
    )
      return false;
    try {
      if (req.method === "POST") await options.assertCsrf(req);
      if (
        !path.startsWith("/api/management/") &&
        !path.startsWith("/api/runtime/")
      ) {
        legacy(req, res);
        return true;
      }
      const route = path.startsWith("/api/runtime/")
        ? runtimeRoutes.get(path.slice("/api/runtime/".length))
        : routes.get(path.slice("/api/management/".length));
      if (!route || req.method !== "POST")
        throw new DomainError("NOT_FOUND", "接口不存在。");
      if (req.headers["x-skill-library"] !== "1")
        throw new DomainError("FORBIDDEN", "请求来源无效。");
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw new DomainError("VALIDATION", "需要 JSON 请求。");
      const actor = await options.resolveActor(req);
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => req.destroy(), 10000);
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 65536) throw new DomainError("VALIDATION", "请求过大。");
          chunks.push(Buffer.from(chunk));
        }
      } finally {
        clearTimeout(timer);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new DomainError("VALIDATION", "请求格式无效。");
      }
      if (
        !body ||
        Object.keys(body).length !== 1 ||
        !Array.isArray(body.args) ||
        body.args.length < route.min ||
        body.args.length > route.max
      )
        throw new DomainError("VALIDATION", "请求参数无效。");
      const result = await route.run(actor, body.args);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ result }));
    } catch (e) {
      if (!res.headersSent && !res.destroyed) error(res, e);
      else res.destroy();
    }
    return true;
  }
  return { handle, close: () => legacy.close() };
}
