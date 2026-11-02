import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
  access,
  chmod,
  open,
  rm,
} from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import {
  migrate,
  createPostgresLibraryService,
} from "../modules/persistence/index.ts";
import { createLocalFiles, recoverLocalSync } from "../modules/local/files.ts";
import { dumpDatabase } from "../modules/operations/backup.ts";
import {
  readConfig,
  dataDir,
  connectionString,
  type LocalConfig,
} from "./config.ts";
const exec = promisify(execFile);
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const command = process.argv[2] ?? "open";
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);

async function initialize(): Promise<LocalConfig> {
  if (await exists(join(dataDir, "config.json"))) return readConfig();
  const directories: string[] = [];
  for (const root of [
    join(homedir(), ".codex/skills"),
    join(homedir(), ".agents/skills"),
    join(homedir(), ".claude/skills"),
  ]) {
    if (!(await exists(root))) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (
        entry.name.startsWith(".") ||
        !(await exists(join(root, entry.name, "SKILL.md")))
      )
        continue;
      const directory = await realpath(join(root, entry.name));
      if (!directories.includes(directory)) directories.push(directory);
    }
  }
  const pgBin = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
  if (!(await exists(join(pgBin, "initdb"))))
    throw new Error("需要 PostgreSQL 17，请设置 PG_BIN 指向它的 bin 目录");
  const config: LocalConfig = {
    port: 18880,
    databasePort: 55433,
    pgBin,
    displayName: process.env.SKILL_LIBRARY_DISPLAY_NAME ?? userInfo().username,
    databasePassword: randomBytes(32).toString("base64url"),
    accessKey: randomBytes(32).toString("base64url"),
    actor: { userId: randomUUID(), teamId: randomUUID(), role: "admin" },
    directories,
  };
  await writeFile(
    join(dataDir, "config.json"),
    JSON.stringify(config, null, 2),
    { mode: 0o600, flag: "wx" },
  );
  return config;
}
async function startDatabase(config: LocalConfig) {
  const pgData = join(dataDir, "postgres");
  if (!(await exists(join(pgData, "PG_VERSION")))) {
    const pw = join(dataDir, ".bootstrap-password");
    await writeFile(pw, config.databasePassword + "\n", { mode: 0o600 });
    try {
      await exec(join(config.pgBin, "initdb"), [
        "-D",
        pgData,
        "-U",
        "skill_library",
        "--auth=scram-sha-256",
        "--encoding=UTF8",
        "--locale=C",
        `--pwfile=${pw}`,
      ]);
    } finally {
      await rm(pw, { force: true });
    }
    await mkdir(join(dataDir, "socket"), { mode: 0o700, recursive: true });
    const settings = `\nlisten_addresses = '127.0.0.1'\nport = ${config.databasePort}\nunix_socket_directories = '${join(dataDir, "socket").replaceAll("'", "''")}'\n`;
    await writeFile(join(pgData, "postgresql.auto.conf"), settings, {
      mode: 0o600,
    });
  }
  const running = await exec(join(config.pgBin, "pg_ctl"), [
    "-D",
    pgData,
    "status",
  ]).then(
    () => true,
    () => false,
  );
  if (!running)
    await exec(join(config.pgBin, "pg_ctl"), [
      "-D",
      pgData,
      "-l",
      join(dataDir, "postgres.log"),
      "-w",
      "start",
    ]);
  const admin = new Pool({
    connectionString: connectionString(config).replace(
      /\/skill_library$/,
      "/postgres",
    ),
  });
  try {
    if (
      !(
        await admin.query(
          "SELECT 1 FROM pg_database WHERE datname='skill_library'",
        )
      ).rowCount
    )
      await admin.query("CREATE DATABASE skill_library");
  } finally {
    await admin.end();
  }
}
async function bootstrap(config: LocalConfig, pool: Pool) {
  await migrate(pool);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "INSERT INTO users(id,display_name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
      [config.actor.userId, config.displayName],
    );
    await c.query(
      "INSERT INTO auth_identities(id,user_id,provider,provider_subject) VALUES($1,$2,'local-device',$3) ON CONFLICT(provider,provider_subject) DO NOTHING",
      [randomUUID(), config.actor.userId, config.actor.userId],
    );
    await c.query(
      "INSERT INTO teams(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING",
      [config.actor.teamId, `${config.displayName} 的技能库`],
    );
    await c.query(
      "INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(team_id,user_id) DO NOTHING",
      [config.actor.teamId, config.actor.userId],
    );
    await c.query("COMMIT");
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}
async function ready(config: LocalConfig) {
  try {
    const response = await fetch(
      `http://127.0.0.1:${config.port}/api/local/instance`,
      { signal: AbortSignal.timeout(1500) },
    );
    if (
      !response.ok ||
      (await response.json()).instance !== config.actor.userId
    )
      return false;
    return await fetch(`http://127.0.0.1:${config.port}/readyz`, {
      signal: AbortSignal.timeout(1500),
    }).then((r) => r.ok);
  } catch {
    return false;
  }
}
async function startServer(config: LocalConfig) {
  if (await ready(config)) return;
  await access(
    fileURLToPath(
      new URL("../modules/product/dist/index.html", import.meta.url),
    ),
  );
  const log = await open(join(dataDir, "application.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./server.ts", import.meta.url))],
    {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, SKILL_LIBRARY_DATA_DIR: dataDir },
    },
  );
  child.unref();
  await log.close();
  await writeFile(join(dataDir, "server.pid"), String(child.pid), {
    mode: 0o600,
  });
  for (let i = 0; i < 60; i++) {
    if (await ready(config)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("本机服务未就绪，请查看私有数据目录里的 application.log");
}

try {
  const config = await initialize();
  if (command === "stop") {
    const pidPath = join(dataDir, "server.pid");
    if (await exists(pidPath)) {
      const pid = Number(await readFile(pidPath, "utf8"));
      const processName = await exec("ps", [
        "-p",
        String(pid),
        "-o",
        "command=",
      ]).then(
        (r) => r.stdout,
        () => "",
      );
      if (
        processName.includes(
          fileURLToPath(new URL("./server.ts", import.meta.url)),
        )
      ) {
        process.kill(pid, "SIGTERM");
        const alive = () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        for (let i = 0; i < 150 && alive(); i++)
          await new Promise((r) => setTimeout(r, 200));
        if (alive())
          throw new Error(
            "网页服务仍在结束操作，数据库保持运行，请稍后重试停止",
          );
      }
      await rm(pidPath);
    }
    await exec(join(config.pgBin, "pg_ctl"), [
      "-D",
      join(dataDir, "postgres"),
      "-m",
      "fast",
      "-w",
      "stop",
    ]);
    console.log("已停止本机技能库，数据已保留。");
  } else if (command === "status") {
    console.log(
      JSON.stringify({
        ready: await ready(config),
        url: `http://127.0.0.1:${config.port}`,
        dataDir,
      }),
    );
  } else {
    await startDatabase(config);
    const pool = new Pool({ connectionString: connectionString(config) });
    try {
      await bootstrap(config, pool);
      if (["import", "scan"].includes(command)) {
        await recoverLocalSync(dataDir);
        const library = createPostgresLibraryService({ pool });
        const files = createLocalFiles({
          pool,
          library,
          actor: config.actor,
          directories: config.directories,
          dataDir,
        });
        for (const row of await files.scan()) {
          if (command === "import" && row.status === "new") {
            await files.importDirectory(row.directory);
            console.log(
              `已导入 ${row.name}（${"files" in row ? row.files : 0} 个文件）`,
            );
          } else
            console.log(
              `${row.name}: ${row.status}${row.error ? ` — ${row.error}` : ""}`,
            );
        }
      } else if (command === "backup") {
        process.env.PG_BIN = config.pgBin;
        await mkdir(join(dataDir, "database-backups"), {
          mode: 0o700,
          recursive: true,
        });
        const target = join(
          dataDir,
          "database-backups",
          `${new Date().toISOString().replaceAll(":", "-")}.dump`,
        );
        await dumpDatabase(connectionString(config), target);
        console.log(`数据库已备份：${target}`);
      } else if (["start", "open"].includes(command)) {
        await startServer(config);
        if (command === "open")
          await exec("open", [
            `http://127.0.0.1:${config.port}/#local-key=${config.accessKey}`,
          ]);
        console.log(`技能库已就绪：http://127.0.0.1:${config.port}`);
      } else
        throw new Error(
          "支持的命令：open、start、stop、status、scan、import、backup",
        );
    } finally {
      await pool.end();
    }
  }
} catch (error) {
  // Tool subprocess errors can include connection details. Never dump error objects.
  console.error(
    error instanceof Error && !("cmd" in error)
      ? error.message
      : "本机启动操作失败，请检查 PostgreSQL 和私有日志。",
  );
  process.exitCode = 1;
}
