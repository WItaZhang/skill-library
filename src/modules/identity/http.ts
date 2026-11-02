import type { IncomingMessage, ServerResponse } from "node:http";
import { DomainError } from "../../contracts/index.ts";
import type { IdentityService } from "./types.ts";
const methods = [
  "createTeam",
  "listTeams",
  "invite",
  "accept",
  "listMembers",
  "changeRole",
  "removeMember",
] as const;
async function body(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new DomainError("VALIDATION", "请求必须使用 JSON");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new DomainError("VALIDATION", "请求内容过大");
    chunks.push(Buffer.from(chunk));
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    if ("actor" in parsed || "user" in parsed) throw new Error();
    return parsed;
  } catch {
    throw new DomainError("VALIDATION", "请求内容无效");
  }
}
export function createIdentityHttpHandler({
  identity,
}: {
  identity: IdentityService;
}) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> => {
    const path = new URL(req.url ?? "/", "http://identity.invalid").pathname;
    if (!path.startsWith("/api/identity/")) return false;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = (status: number, data: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
    };
    try {
      const method = path.slice("/api/identity/".length);
      if (
        req.method === "GET" &&
        (method === "login" || method === "callback")
      ) {
        const result = await identity[method](req);
        res.writeHead(302, {
          Location: result.location,
          "Set-Cookie": result.cookies,
        });
        res.end();
      } else if (req.method === "GET" && method === "session")
        json(200, { data: await identity.session(req) });
      else if (
        req.method === "POST" &&
        (method === "logout" || (methods as readonly string[]).includes(method))
      ) {
        await identity.assertCsrf(req);
        const input = await body(req);
        if (method === "logout") {
          const result = await identity.logout(req);
          res.setHeader("Set-Cookie", result.cookies);
          json(200, { data: null });
        } else {
          const result = await identity[method as (typeof methods)[number]](
            req,
            input,
          );
          json(200, { data: result ?? null });
        }
      } else
        json(404, {
          error: { code: "NOT_FOUND", message: "接口不存在或请求方法无效" },
        });
    } catch (error) {
      const known = error instanceof DomainError;
      const code = known ? error.code : "UNAVAILABLE";
      const status =
        code === "FORBIDDEN"
          ? 403
          : code === "NOT_FOUND"
            ? 404
            : code === "CONFLICT"
              ? 409
              : code === "VALIDATION"
                ? 400
                : 503;
      json(status, {
        error: {
          code,
          message: known ? error.message : "服务暂时不可用，请稍后重试",
        },
      });
    }
    return true;
  };
}
