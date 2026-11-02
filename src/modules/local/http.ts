import type { IncomingMessage, ServerResponse } from "node:http";
import { DomainError, type Actor } from "../../contracts/index.ts";
import type { IdentityService } from "../identity/types.ts";
import type { createLocalFiles } from "./files.ts";

export function createLocalFilesHandler(
  identity: IdentityService,
  actor: Actor,
  files: ReturnType<typeof createLocalFiles>,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://local.invalid").pathname;
    if (!path.startsWith("/api/local/")) return false;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (path === "/api/local/instance" && req.method === "GET") {
      res.end(JSON.stringify({ instance: actor.userId }));
      return true;
    }
    try {
      await identity.assertCsrf(req);
      const trusted = await identity.resolveActor(req);
      if (
        trusted.userId !== actor.userId ||
        trusted.teamId !== actor.teamId ||
        trusted.role !== "admin"
      )
        throw new DomainError("FORBIDDEN", "本机目录仅对库的所有者开放");
      if (
        req.method !== "POST" ||
        !req.headers["content-type"]?.startsWith("application/json")
      )
        throw new DomainError("VALIDATION", "请求格式无效");
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) throw new DomainError("VALIDATION", "请求过大");
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new DomainError("VALIDATION", "请求格式无效");
      }
      let data;
      if (path === "/api/local/scan") data = await files.scan();
      else if (
        path === "/api/local/import" &&
        typeof input?.directory === "string"
      )
        data = await files.importDirectory(input.directory);
      else if (
        path === "/api/local/sync" &&
        typeof input?.skillId === "string" &&
        typeof input?.versionId === "string"
      )
        data = await files.sync(input.skillId, input.versionId);
      else if (
        path === "/api/local/pull" &&
        typeof input?.skillId === "string" &&
        typeof input?.checksum === "string"
      )
        data = await files.pull(input.skillId, input.checksum);
      else throw new DomainError("NOT_FOUND", "接口不存在");
      res.end(JSON.stringify({ data }));
    } catch (error) {
      const known = error instanceof DomainError;
      res.statusCode = known
        ? error.code === "FORBIDDEN"
          ? 403
          : error.code === "NOT_FOUND"
            ? 404
            : error.code === "CONFLICT"
              ? 409
              : 400
        : 503;
      res.end(
        JSON.stringify({
          error: {
            code: known ? error.code : "UNAVAILABLE",
            message: known
              ? error.message
              : "本机文件操作失败，原文件和备份仍可在本机查看",
          },
        }),
      );
    }
    return true;
  };
}
