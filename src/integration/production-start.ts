import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createProductionApplication } from "./production-server.ts";
const { DATABASE_URL, PUBLIC_ORIGIN, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } =
  process.env;
if (
  !DATABASE_URL ||
  !PUBLIC_ORIGIN ||
  !GITHUB_CLIENT_ID ||
  !GITHUB_CLIENT_SECRET
)
  throw new Error(
    "正式模式需要 DATABASE_URL、HTTPS PUBLIC_ORIGIN 和 GitHub OAuth 凭证。",
  );
const pool = new Pool({ connectionString: DATABASE_URL });
const app = await createProductionApplication({
  pool,
  publicOrigin: PUBLIC_ORIGIN,
  github: { clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET },
  webDir: fileURLToPath(new URL("../modules/product/dist/", import.meta.url)),
});
app.server.listen(Number(process.env.PORT || 8080), "0.0.0.0", () =>
  console.log("团队技能库已启动。"),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
