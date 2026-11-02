import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, chmod, link, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

/** libpq credentials stay in the child environment, never argv/log output. */
export function pgEnvironment(connectionString: string) {
  const url = new URL(connectionString);
  if (!["postgresql:", "postgres:"].includes(url.protocol))
    throw new Error("PostgreSQL URL required");
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: "5",
  };
  // These are the supported deployment connection parameters. Reject silent TLS changes.
  const names: Record<string, string> = {
    sslmode: "PGSSLMODE",
    sslrootcert: "PGSSLROOTCERT",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    options: "PGOPTIONS",
    application_name: "PGAPPNAME",
    channel_binding: "PGCHANNELBINDING",
  };
  for (const [key, value] of url.searchParams) {
    if (!names[key])
      throw new Error(`Unsupported libpq connection option: ${key}`);
    (env as Record<string, string>)[names[key]] = value;
  }
  return env;
}
async function pgTool(tool: string, args: string[], connectionString: string) {
  const command = process.env.PG_BIN ? join(process.env.PG_BIN, tool) : tool;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env: pgEnvironment(connectionString),
      stdio: ["ignore", "ignore", "pipe"],
    });
    // Diagnostic text can contain URLs, row data or prompts. Only the executable + status leave this boundary.
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill("SIGTERM"), 300000);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(
        new Error(
          `${tool} could not start; check PG_BIN and PostgreSQL client installation`,
        ),
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${tool} failed (exit ${code}); inspect server diagnostics in a protected operator session`,
            ),
          );
    });
  });
}
export async function dumpDatabase(connectionString: string, path: string) {
  const partial = path + ".partial";
  // Private file created before pg_dump opens it. Existing backups are never overwritten.
  await writeFile(partial, "", { flag: "wx", mode: 0o600 });
  try {
    await pgTool(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-acl", "--file", partial],
      connectionString,
    );
    await chmod(partial, 0o600);
    await link(partial, path);
    await unlink(partial);
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
}
/** Target MUST be a separately created empty database; caller validates it. Never --clean. */
export async function restoreDatabase(connectionString: string, path: string) {
  const db = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  await pgTool(
    "pg_restore",
    [
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-acl",
      "--dbname",
      db,
      path,
    ],
    connectionString,
  );
}
const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
/** Per-table row digests include every field (including JSONB/resources), without writing sensitive rows. */
export async function databaseFingerprint(pool: Pool) {
  const tables = (
    await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename",
    )
  ).rows.map((r) => r.tablename as string);
  const result: Record<string, { rows: number; sha256: string }> = {};
  for (const table of tables) {
    const rows = (
      await pool.query(
        `SELECT row_to_json(t)::text AS row FROM ${identifier(table)} t ORDER BY row_to_json(t)::text COLLATE "C"`,
      )
    ).rows;
    const hash = createHash("sha256");
    for (const r of rows) hash.update(r.row + "\n");
    result[table] = { rows: rows.length, sha256: hash.digest("hex") };
  }
  const sequences = (
    await pool.query(
      "SELECT sequencename FROM pg_sequences WHERE schemaname=current_schema() ORDER BY sequencename",
    )
  ).rows;
  for (const { sequencename } of sequences) {
    const row = (
      await pool.query(
        `SELECT last_value,is_called FROM ${identifier(sequencename)}`,
      )
    ).rows[0];
    result[`sequence:${sequencename}`] = {
      rows: 1,
      sha256: createHash("sha256").update(JSON.stringify(row)).digest("hex"),
    };
  }
  return result;
}
