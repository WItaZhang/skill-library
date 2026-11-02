import { readFileSync } from "node:fs";
import { isIP } from "node:net";

export type Environment = Record<string, string | undefined>;
export function secret(
  env: Environment,
  key: string,
  required = true,
): string | undefined {
  if (env[key] && env[`${key}_FILE`])
    throw new Error(`${key}: set value OR _FILE, not both`);
  const value = env[`${key}_FILE`]
    ? readFileSync(env[`${key}_FILE`]!, "utf8").replace(/\r?\n$/, "")
    : env[key];
  if (required && !value) throw new Error(`${key} is required`);
  return value || undefined;
}
function integer(
  env: Environment,
  key: string,
  fallback: number,
  min: number,
  max: number,
) {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${key} must be ${min}..${max}`);
  return value;
}
export function loadConfig(env: Environment = process.env) {
  const databaseUrl = secret(env, "DATABASE_URL")!;
  let db: URL;
  try {
    db = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(db.protocol) ||
    !db.hostname ||
    db.pathname.length < 2
  )
    throw new Error("DATABASE_URL must identify a PostgreSQL database");
  const publicOrigin = env.PUBLIC_ORIGIN ?? "";
  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be an HTTPS origin");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== publicOrigin ||
    origin.username ||
    origin.password
  )
    throw new Error("PUBLIC_ORIGIN must be an exact HTTPS origin without path");
  if (env.NODE_ENV && env.NODE_ENV !== "production")
    throw new Error("Production entry requires NODE_ENV=production");
  if (
    env.EXECUTION_ENABLED &&
    !["true", "false"].includes(env.EXECUTION_ENABLED)
  )
    throw new Error("EXECUTION_ENABLED must be true or false");
  const executionEnabled = env.EXECUTION_ENABLED === "true";
  const trustedProxyIps = (env.TRUSTED_PROXY_IPS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (trustedProxyIps.some((x) => !isIP(x)))
    throw new Error(
      "TRUSTED_PROXY_IPS must contain exact IP addresses, never arbitrary hops/CIDRs",
    );
  const metricsToken = secret(env, "METRICS_TOKEN")!;
  if (metricsToken.length < 32)
    throw new Error("METRICS_TOKEN must have at least 32 characters");
  const apiKey = secret(env, "ANTHROPIC_API_KEY", executionEnabled);
  const model = env.EXECUTION_MODEL;
  const workspaceId = env.ANTHROPIC_WORKSPACE_ID || undefined;
  if (workspaceId && !/^[a-zA-Z0-9_-]{1,100}$/.test(workspaceId))
    throw new Error(
      "ANTHROPIC_WORKSPACE_ID must be a valid workspace identifier",
    );
  if (executionEnabled && (!model || !/^[a-zA-Z0-9._:-]{1,150}$/.test(model)))
    throw new Error("EXECUTION_MODEL is required when execution is enabled");
  return {
    databaseUrl,
    publicOrigin,
    github: {
      clientId: secret(env, "GITHUB_CLIENT_ID")!,
      clientSecret: secret(env, "GITHUB_CLIENT_SECRET")!,
    },
    metricsToken,
    trustedProxyIps,
    execution: executionEnabled
      ? { apiKey: apiKey!, model: model!, workspaceId }
      : undefined,
    port: integer(env, "PORT", 8080, 1, 65535),
    poolMax: integer(env, "PG_POOL_MAX", 10, 2, 50),
    shutdownMs: integer(env, "SHUTDOWN_TIMEOUT_MS", 20000, 1000, 60000),
    release: /^[a-zA-Z0-9._-]{1,100}$/.test(env.RELEASE_SHA ?? "")
      ? env.RELEASE_SHA!
      : "unknown",
  };
}
