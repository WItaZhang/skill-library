import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createProductionApplication } from "../integration/production-server.ts";
import { createLocalFiles, recoverLocalSync } from "../modules/local/files.ts";
import { createLocalFilesHandler } from "../modules/local/http.ts";
import { readConfig, dataDir, connectionString } from "./config.ts";

const config = await readConfig();
await recoverLocalSync(dataDir);
const pool = new Pool({
  connectionString: connectionString(config),
  max: 6,
  connectionTimeoutMillis: 3000,
  statement_timeout: 30000,
});
const app = await createProductionApplication({
  pool,
  mode: "local",
  publicOrigin: `http://127.0.0.1:${config.port}`,
  localAccess: {
    userId: config.actor.userId,
    keyHash: createHash("sha256").update(config.accessKey).digest("hex"),
  },
  webDir: fileURLToPath(new URL("../modules/product/dist", import.meta.url)),
  localFilesFactory: ({ identity, library }) =>
    createLocalFilesHandler(
      identity,
      config.actor,
      createLocalFiles({
        pool,
        library,
        actor: config.actor,
        directories: config.directories,
        dataDir,
      }),
    ),
});
app.server.listen(config.port, "127.0.0.1", () =>
  console.log(JSON.stringify({ event: "local.started", port: config.port })),
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    try {
      await app.close();
    } finally {
      await pool.end();
    }
  });
app.server.on("error", async () => {
  console.error("本机服务无法启动，请检查端口和本地日志");
  await pool.end();
  process.exitCode = 1;
});
