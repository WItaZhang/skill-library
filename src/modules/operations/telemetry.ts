import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type LogRecord = {
  time: string;
  level: "info" | "warn" | "error";
  event: string;
  requestId?: string;
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  code?: string;
  release?: string;
};
export type LogSink = (record: LogRecord) => void;
export const jsonLog: LogSink = (record) =>
  process.stdout.write(JSON.stringify(record) + "\n");
const buckets = [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60];
// Fixed labels: user-controlled method/path/query values never become logs or metric labels.
export function routeLabel(path: string) {
  if (["/healthz", "/readyz", "/metrics"].includes(path)) return path.slice(1);
  if (path === "/api/events") return "events";
  if (path === "/api/identity/login") return "login";
  if (path === "/api/identity/callback") return "callback";
  for (const part of [
    "identity",
    "library",
    "management",
    "runtime",
    "execution",
  ])
    if (path.startsWith(`/api/${part}/`)) return part;
  return path.startsWith("/api/") ? "unknown_api" : "static";
}
export function safeErrorCode(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  return [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "57P01",
    "57P03",
    "53300",
    "08006",
    "23505",
    "23503",
    "42P01",
  ].includes(code)
    ? code
    : "INTERNAL";
}
export function authorizedMetrics(
  header: string | undefined,
  token: string | undefined,
) {
  if (!token || !header) return false;
  const expected = Buffer.from(`Bearer ${token}`),
    actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function createTelemetry(sink: LogSink = jsonLog) {
  const counts = new Map<string, number>();
  const timings = new Map<
    string,
    { count: number; sum: number; buckets: number[] }
  >();
  const limited = new Map<string, number>();
  const started = Date.now();
  let active = 0,
    sse = 0;
  const write = (record: Omit<LogRecord, "time">) => {
    // A broken optional log sink must not fail a user request.
    try {
      sink({ time: new Date().toISOString(), ...record });
    } catch {
      /* stdout supervisor detects loss */
    }
  };
  return {
    write,
    begin(req: IncomingMessage, res: ServerResponse, path: string) {
      const requestId = randomUUID(),
        start = performance.now(),
        route = routeLabel(path);
      const method = ["GET", "POST", "HEAD", "OPTIONS"].includes(
        req.method ?? "",
      )
        ? req.method!
        : "OTHER";
      res.setHeader("X-Request-Id", requestId);
      active++;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        active--;
        const durationMs = performance.now() - start;
        const status = res.writableFinished ? res.statusCode : 499;
        const key = `route="${route}",method="${method}",status="${status}"`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const timing = timings.get(route) ?? {
          count: 0,
          sum: 0,
          buckets: buckets.map(() => 0),
        };
        const seconds = durationMs / 1000;
        timing.count++;
        timing.sum += seconds;
        buckets.forEach((b, i) => {
          if (seconds <= b) timing.buckets[i]++;
        });
        timings.set(route, timing);
        write({
          event: status >= 500 ? "http.error" : "http.request",
          level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
          requestId,
          route,
          method,
          status,
          durationMs: Math.round(durationMs * 100) / 100,
          ...(status >= 500 ? { code: "HTTP_5XX" } : {}),
        });
      };
      res.once("finish", finish);
      res.once("close", finish);
      return requestId;
    },
    limit(bucket: string) {
      limited.set(bucket, (limited.get(bucket) ?? 0) + 1);
    },
    sse(delta: number) {
      sse += delta;
    },
    render(
      ready: boolean,
      pool: { totalCount: number; idleCount: number; waitingCount: number },
    ) {
      const lines = [
        "# TYPE skill_http_requests_total counter",
        ...[...counts].map(([k, v]) => `skill_http_requests_total{${k}} ${v}`),
        "# TYPE skill_http_duration_seconds histogram",
      ];
      for (const [route, t] of timings) {
        buckets.forEach((b, i) =>
          lines.push(
            `skill_http_duration_seconds_bucket{route="${route}",le="${b}"} ${t.buckets[i]}`,
          ),
        );
        lines.push(
          `skill_http_duration_seconds_bucket{route="${route}",le="+Inf"} ${t.count}`,
          `skill_http_duration_seconds_sum{route="${route}"} ${t.sum}`,
          `skill_http_duration_seconds_count{route="${route}"} ${t.count}`,
        );
      }
      lines.push(
        "# TYPE skill_rate_limited_total counter",
        ...[...limited].map(
          ([k, v]) => `skill_rate_limited_total{bucket="${k}"} ${v}`,
        ),
        `skill_ready ${Number(ready)}`,
        `skill_active_requests ${active}`,
        `skill_sse_connections ${sse}`,
        `skill_uptime_seconds ${(Date.now() - started) / 1000}`,
        `skill_pg_connections ${pool.totalCount}`,
        `skill_pg_idle_connections ${pool.idleCount}`,
        `skill_pg_waiting_requests ${pool.waitingCount}`,
        `skill_process_rss_bytes ${process.memoryUsage().rss}`,
      );
      return lines.join("\n") + "\n";
    },
  };
}
export type Telemetry = ReturnType<typeof createTelemetry>;
