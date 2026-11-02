import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IdentityService } from "../identity/types.ts";
import type { Telemetry } from "./telemetry.ts";

export interface Limits {
  apiIp: number;
  loginIp: number;
  writeIp: number;
  writeUser: number;
  executionIp: number;
  executionUser: number;
  sseIp: number;
  sseUser: number;
  sseTotal: number;
  windowMs: number;
  maxKeys: number;
}
export const defaultLimits: Limits = {
  apiIp: 600,
  loginIp: 15,
  writeIp: 180,
  writeUser: 90,
  executionIp: 30,
  executionUser: 10,
  sseIp: 30,
  sseUser: 6,
  sseTotal: 200,
  windowMs: 60000,
  maxKeys: 20000,
};
const normalize = (ip: string) => (ip.startsWith("::ffff:") ? ip.slice(7) : ip);
/** Only an explicitly trusted direct peer may send ONE canonical forwarded address.
 * Caddy must overwrite X-Forwarded-For with {remote_host}; chains are never trusted. */
export function clientIp(req: IncomingMessage, trusted: string[]) {
  const peer = normalize(req.socket.remoteAddress ?? "unknown");
  if (!trusted.map(normalize).includes(peer)) return peer;
  const forwarded = req.headers["x-forwarded-for"];
  return typeof forwarded === "string" && isIP(forwarded.trim())
    ? normalize(forwarded.trim())
    : peer;
}
export class WindowLimiter {
  private entries = new Map<string, { count: number; until: number }>();
  private maxKeys: number;
  private now: () => number;
  constructor(maxKeys = 20000, now = Date.now) {
    this.maxKeys = maxKeys;
    this.now = now;
  }
  take(key: string, max: number, windowMs: number) {
    const now = this.now();
    let item = this.entries.get(key);
    if (item && now >= item.until) {
      this.entries.delete(key);
      item = undefined;
    }
    if (!item) {
      if (this.entries.size >= this.maxKeys) {
        for (const [key, value] of this.entries)
          if (now >= value.until) this.entries.delete(key);
        // Never evict active entries: churn must not reset another principal's budget.
        if (this.entries.size >= this.maxKeys)
          return Math.ceil(windowMs / 1000);
      }
      item = { count: 0, until: now + windowMs };
      this.entries.set(key, item);
    }
    if (item.count >= max)
      return Math.max(1, Math.ceil((item.until - now) / 1000));
    item.count++;
    return 0;
  }
}
const readMethods = new Set([
  "listSkills",
  "getSkill",
  "listVersions",
  "getVersion",
  "compareVersions",
  "getDraft",
  "catalogSnapshot",
  "listUpdateEvents",
  "listAudit",
  "listManagedSkills",
  "listDrafts",
  "getTask",
  "resolveSkill",
  "listInvocations",
  "getSessionUpdates",
  "listTeams",
  "listMembers",
]);
export function isWrite(path: string, method?: string) {
  if (method !== "POST") return false;
  if (path.startsWith("/api/execution/"))
    return !["get", "list"].includes(path.split("/").at(-1)!);
  return !readMethods.has(path.split("/").at(-1)!);
}
export function createAdmission(options: {
  identity: IdentityService;
  telemetry: Telemetry;
  trustedProxyIps?: string[];
  limits?: Partial<Limits>;
}) {
  const limits = { ...defaultLimits, ...options.limits },
    limiter = new WindowLimiter(limits.maxKeys);
  const connections = new Map<string, number>();
  let total = 0;
  const deny = (res: ServerResponse, bucket: string, retry = 60) => {
    options.telemetry.limit(bucket);
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": String(retry),
    });
    // Keep shared DomainError compatibility; clients may inspect HTTP 429 and Retry-After.
    res.end(
      JSON.stringify({
        error: { code: "UNAVAILABLE", message: "请求过于频繁，请稍后重试。" },
      }),
    );
    return false;
  };
  const take = (
    res: ServerResponse,
    bucket: string,
    key: string,
    max: number,
  ) => {
    const retry = limiter.take(`${bucket}:${key}`, max, limits.windowMs);
    return retry ? deny(res, bucket, retry) : true;
  };
  return async (req: IncomingMessage, res: ServerResponse, path: string) => {
    if (!path.startsWith("/api/")) return true;
    const ip = clientIp(req, options.trustedProxyIps ?? []);
    if (!take(res, "api_ip", ip, limits.apiIp)) return false;
    if (
      ["/api/identity/login", "/api/identity/callback"].includes(path) &&
      !take(res, "login_ip", ip, limits.loginIp)
    )
      return false;
    const write = isWrite(path, req.method),
      cost =
        req.method === "POST" &&
        ["/api/execution/accept", "/api/execution/retry"].includes(path),
      sse = path === "/api/events" && req.method === "GET";
    if (write && !take(res, "write_ip", ip, limits.writeIp)) return false;
    if (cost && !take(res, "execution_ip", ip, limits.executionIp))
      return false;
    if (!write && !sse) return true;
    // Cookie is resolved from DB; X-Team-Id/body actors cannot buy a fresh user quota.
    const session = await options.identity.session(req);
    if (!session) return true; // Module's authentication returns the usual 403.
    const user = session.user.id;
    if (write && !take(res, "write_user", user, limits.writeUser)) return false;
    if (cost && !take(res, "execution_user", user, limits.executionUser))
      return false;
    if (sse) {
      const ipKey = `ip:${ip}`,
        userKey = `user:${user}`;
      if (
        total >= limits.sseTotal ||
        (connections.get(ipKey) ?? 0) >= limits.sseIp ||
        (connections.get(userKey) ?? 0) >= limits.sseUser
      )
        return deny(res, "sse");
      connections.set(ipKey, (connections.get(ipKey) ?? 0) + 1);
      connections.set(userKey, (connections.get(userKey) ?? 0) + 1);
      total++;
      options.telemetry.sse(1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        for (const k of [ipKey, userKey]) {
          const n = connections.get(k)! - 1;
          n ? connections.set(k, n) : connections.delete(k);
        }
        total--;
        options.telemetry.sse(-1);
      };
      res.once("close", release);
      res.once("finish", release);
    }
    return true;
  };
}
