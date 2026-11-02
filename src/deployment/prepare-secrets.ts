import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
// Generates only local DB/monitoring secrets. OAuth/provider values are supplied separately.
const dir = resolve(process.argv[2] ?? "src/deployment/secrets");
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
async function create(name: string, value: string) {
  try {
    await writeFile(join(dir, name), value, { flag: "wx", mode: 0o444 });
  } catch (e) {
    if (!(e && typeof e === "object" && "code" in e && e.code === "EEXIST"))
      throw e;
  }
}
await create("postgres_admin_password", randomBytes(32).toString("hex"));
await create("app_db_password", randomBytes(32).toString("hex"));
await create("metrics_token", randomBytes(32).toString("hex"));
const password = (await readFile(join(dir, "app_db_password"), "utf8")).trim();
await create(
  "database_url",
  `postgresql://skill_library:${encodeURIComponent(password)}@db:5432/skill_library`,
);
await create("github_client_secret", "");
await create("anthropic_api_key", "");
console.log(
  "Local secret files prepared; set github_client_secret and (if enabled) anthropic_api_key. No values printed.",
);
