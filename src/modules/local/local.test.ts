import test from "node:test";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  stat,
  symlink,
  rename,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { migrate, createPostgresLibraryService } from "../persistence/index.ts";
import { createIdentityService } from "../identity/service.ts";
import { createProductionApplication } from "../../integration/production-server.ts";
import { createLocalFiles, readPackage, recoverLocalSync } from "./files.ts";
import { createLocalFilesHandler } from "./http.ts";
import type { Actor } from "../../contracts/index.ts";

test("local credentials cannot enable an HTTP production host or arbitrary origin", async () => {
  const pool = new Pool();
  const localAccess = { userId: randomUUID(), keyHash: "a".repeat(64) };
  assert.throws(() =>
    createIdentityService({
      pool,
      publicOrigin: "https://example.com",
      localAccess,
      github: { clientId: "x", clientSecret: "y" },
    }),
  );
  for (const publicOrigin of [
    "http://0.0.0.0:18880",
    "http://localhost:18880",
    "https://127.0.0.1:18880",
  ])
    assert.throws(() =>
      createIdentityService({ pool, publicOrigin, mode: "local", localAccess }),
    );
  await pool.end();
});

test(
  "real local library imports, publishes, detects conflicts, writes back and survives restart",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const schema = "local_" + randomUUID().replaceAll("-", "");
    const admin = new Pool({ connectionString: process.env.DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
      max: 6,
    });
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "skill-local-test-")),
    );
    const directory = join(root, "example"),
      dataDir = join(root, "private");
    await mkdir(join(directory, "references"), { recursive: true });
    await mkdir(dataDir);
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: example\ndescription: A personal skill\n---\n# Original\n\n[Guide](references/guide.md)\n",
    );
    await writeFile(join(directory, "references/guide.md"), "Original guide\n");
    await chmod(join(directory, "SKILL.md"), 0o640);
    const actor: Actor = {
      userId: randomUUID(),
      teamId: randomUUID(),
      role: "admin",
    };
    const key = "local-key-" + randomUUID();
    let app:
      Awaited<ReturnType<typeof createProductionApplication>> | undefined;
    try {
      await migrate(pool);
      await pool.query(
        "INSERT INTO users(id,display_name) VALUES($1,'Local user')",
        [actor.userId],
      );
      await pool.query(
        "INSERT INTO teams(id,name) VALUES($1,'Private library')",
        [actor.teamId],
      );
      await pool.query(
        "INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'admin')",
        [actor.teamId, actor.userId],
      );
      const library = createPostgresLibraryService({ pool });
      const directories = [directory];
      const files = createLocalFiles({
        pool,
        library,
        actor,
        directories,
        dataDir,
      });
      let skillId: string;
      await t.test(
        "import is atomic and idempotent, including all package resources",
        async () => {
          const [first, repeated] = await Promise.all([
            files.importDirectory(directory),
            files.importDirectory(directory),
          ]);
          skillId = first.skillId;
          assert.equal(repeated.skillId, skillId);
          assert.equal((await library.listSkills(actor)).length, 1);
          assert.equal((await library.listVersions(actor, skillId)).length, 1);
          assert.deepEqual(
            (await library.listVersions(actor, skillId))[0].content,
            await readPackage(directory),
          );
          await assert.rejects(files.importDirectory(root), /不在本机/);
        },
      );
      let versionId: string;
      await t.test(
        "publication does not change the source; explicit sync creates backups and preserves modes",
        async () => {
          const draft = await library.createDraft(actor, skillId);
          const saved = await library.saveDraft(actor, {
            draftId: draft.id,
            expectedRevision: draft.revision,
            content: {
              files: [
                {
                  path: "SKILL.md",
                  mediaType: "text/markdown",
                  content: "# Updated\n",
                },
                {
                  path: "notes.txt",
                  mediaType: "text/plain",
                  content: "New resource\n",
                },
              ],
            },
          });
          const version = await library.publishDraft(actor, {
            draftId: saved.id,
            expectedRevision: saved.revision,
            expectedBaseVersionId: saved.baseVersionId,
            changeSummary: "Update",
            idempotencyKey: randomUUID(),
          });
          versionId = version.id;
          assert.match(
            await readFile(join(directory, "SKILL.md"), "utf8"),
            /Original/,
          );
          const result = await files.sync(skillId, versionId);
          assert.equal(
            await readFile(join(directory, "SKILL.md"), "utf8"),
            "# Updated\n",
          );
          assert.equal(
            (await stat(join(directory, "SKILL.md"))).mode & 0o777,
            0o640,
          );
          assert.match(
            await readFile(join(result.backup!, "SKILL.md"), "utf8"),
            /Original/,
          );
          await assert.rejects(
            readFile(join(directory, "references/guide.md")),
            { code: "ENOENT" },
          );
          assert.equal(
            (await files.sync(skillId, versionId)).backup,
            undefined,
          );
        },
      );
      await t.test(
        "external edits block writes and can be recovered as a stale draft for explicit reconciliation",
        async () => {
          const draft = await library.createDraft(actor, skillId);
          const saved = await library.saveDraft(actor, {
            draftId: draft.id,
            expectedRevision: draft.revision,
            content: {
              files: [
                {
                  path: "SKILL.md",
                  mediaType: "text/markdown",
                  content: "# Web edit\n",
                },
              ],
            },
          });
          const latest = await library.publishDraft(actor, {
            draftId: saved.id,
            expectedRevision: saved.revision,
            expectedBaseVersionId: saved.baseVersionId,
            changeSummary: "Web change",
            idempotencyKey: randomUUID(),
          });
          await writeFile(join(directory, "SKILL.md"), "# External edit\n");
          await assert.rejects(files.sync(skillId, latest.id), /本机文件已被/);
          const [source] = await files.scan();
          assert.equal(source.status, "external");
          await assert.rejects(files.pull(skillId, "obsolete"), /再次变化/);
          const pulled = await files.pull(
            skillId,
            "checksum" in source ? source.checksum : "",
          );
          const restored = await library.getDraft(actor, pulled.draftId!);
          assert.equal(restored.baseVersionId, versionId);
          assert.match(
            restored.content.files.find((f) => f.path === "SKILL.md")!.content,
            /External/,
          );
          await assert.rejects(
            library.publishDraft(actor, {
              draftId: restored.id,
              expectedRevision: restored.revision,
              expectedBaseVersionId: restored.baseVersionId,
              changeSummary: "Must reconcile",
              idempotencyKey: randomUUID(),
            }),
            { code: "STALE_REVISION" },
          );
          assert.equal(
            await readFile(join(directory, "SKILL.md"), "utf8"),
            "# External edit\n",
          );
        },
      );
      await t.test(
        "binary files, symlinks and missing references fail without partial import",
        async () => {
          await writeFile(join(directory, "binary.bin"), Buffer.from([0, 255]));
          await assert.rejects(readPackage(directory), /二进制/);
          await rm(join(directory, "binary.bin"));
          await symlink(join(root, "outside"), join(directory, "escape"));
          await assert.rejects(readPackage(directory), /软链接/);
          await rm(join(directory, "escape"));
          await writeFile(join(directory, "bad.md"), "[missing](missing.txt)");
          await assert.rejects(readPackage(directory), {
            code: "RESOURCE_MISSING",
          });
          await rm(join(directory, "bad.md"));
        },
      );
      const origin = "http://127.0.0.1:18883";
      const start = async () => {
        app = await createProductionApplication({
          pool,
          publicOrigin: origin,
          mode: "local",
          localAccess: {
            userId: actor.userId,
            keyHash: createHash("sha256").update(key).digest("hex"),
          },
          webDir: fileURLToPath(new URL("../product/dist", import.meta.url)),
          operations: { logger: () => {} },
          localFilesFactory: ({ identity }) =>
            createLocalFilesHandler(identity, actor, files),
        });
        await new Promise<void>((resolve) =>
          app!.server.listen(18883, "127.0.0.1", resolve),
        );
      };
      await start();
      let cookie = "",
        csrf = "";
      const post = (
        method: string,
        input: unknown,
        extra: Record<string, string> = {},
      ) =>
        fetch(origin + method, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
            Cookie: cookie,
            "X-CSRF-Token": csrf,
            "X-Team-Id": actor.teamId,
            ...extra,
          },
          body: JSON.stringify(input),
        });
      await t.test(
        "HTTP requires local key, session, CSRF, exact host and origin",
        async () => {
          assert.equal((await post("/api/local/scan", {})).status, 403);
          assert.equal(
            (await post("/api/identity/localLogin", { key: "bad" })).status,
            403,
          );
          assert.equal(
            (
              await post(
                "/api/identity/localLogin",
                { key },
                { Origin: "https://attacker.invalid" },
              )
            ).status,
            403,
          );
          const forgedHostStatus = await new Promise<number | undefined>(
            (resolve, reject) => {
              const req = request(
                origin + "/healthz",
                { headers: { Host: "attacker.invalid" } },
                (res) => {
                  res.resume();
                  res.on("end", () => resolve(res.statusCode));
                },
              );
              req.on("error", reject);
              req.end();
            },
          );
          assert.equal(forgedHostStatus, 403);
          assert.equal(
            (
              await post(
                "/api/identity/localLogin",
                { key },
                { "Sec-Fetch-Site": "cross-site" },
              )
            ).status,
            403,
          );
          const login = await post("/api/identity/localLogin", { key });
          assert.equal(login.status, 200);
          cookie = login.headers.get("set-cookie")!.split(";")[0];
          const session = (
            await (
              await fetch(origin + "/api/identity/session", {
                headers: { Cookie: cookie },
              })
            ).json()
          ).data;
          assert.equal(session.user.id, actor.userId);
          csrf = session.csrfToken;
          assert.equal(
            (await post("/api/local/scan", {}, { "X-CSRF-Token": "bad" }))
              .status,
            403,
          );
          assert.equal((await post("/api/local/scan", {})).status, 200);
          assert.equal(
            (await post("/api/local/import", { directory: root })).status,
            409,
          );
        },
      );
      await t.test(
        "server restart preserves the real account, cookie session and skill history",
        async () => {
          await app!.close();
          await start();
          assert.equal((await post("/api/local/scan", {})).status, 200);
          assert.equal((await library.listVersions(actor, skillId)).length, 3);
          assert.equal((await post("/api/identity/logout", {})).status, 200);
          assert.equal((await post("/api/local/scan", {})).status, 403);
        },
      );
      await t.test(
        "Chrome imports a folder, edits and publishes a skill, then explicitly writes it back",
        async () => {
          const folder = join(root, "browser-skill");
          await mkdir(folder);
          await writeFile(join(folder, "SKILL.md"), "# Browser original\n");
          directories.push(folder);
          const browser = await chromium.launch({
            headless: true,
            executablePath:
              process.env.CHROME_PATH ??
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          });
          try {
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${origin}/#local-key=${key}`);
            await expect(
              page.getByRole("heading", { name: "技能库", exact: true }),
            ).toBeVisible();
            assert.equal(new URL(page.url()).hash, "");
            const navigation = page.getByRole("navigation", { name: "主导航" });
            await navigation.getByRole("button", { name: "本机目录" }).click();
            await page
              .locator(".local-source")
              .filter({ hasText: "browser-skill" })
              .getByRole("button", { name: "导入技能" })
              .click();
            await expect(page.getByRole("status")).toContainText(
              "已导入 browser-skill",
            );
            await navigation.getByRole("button", { name: /技能库/ }).click();
            await page
              .locator(".catalog-row")
              .filter({ hasText: "browser-skill" })
              .click();
            await page
              .getByRole("button", { name: "编辑技能", exact: true })
              .click();
            await page
              .getByRole("textbox", { name: "SKILL.md", exact: true })
              .fill("# Browser published\n");
            await page
              .getByRole("button", { name: "保存草稿", exact: true })
              .click();
            await expect(page.locator(".save-status")).toContainText(
              "草稿已保存",
            );
            await page.getByLabel("修改说明").fill("Update from browser");
            await page
              .getByRole("button", { name: "提交并生效", exact: true })
              .click();
            await expect(page.getByText("v2 已自动生效")).toBeVisible();
            assert.equal(
              await readFile(join(folder, "SKILL.md"), "utf8"),
              "# Browser original\n",
            );
            await navigation.getByRole("button", { name: "本机目录" }).click();
            page.once("dialog", (dialog) => void dialog.accept());
            await page
              .locator(".local-source")
              .filter({ hasText: "browser-skill" })
              .getByRole("button", { name: "写回已发布版本" })
              .click();
            await expect(page.getByRole("status")).toContainText("已写回 v2");
            assert.equal(
              await readFile(join(folder, "SKILL.md"), "utf8"),
              "# Browser published\n",
            );
            await page.reload();
            await expect(page.locator(".catalog-row")).toHaveCount(2);
            assert.deepEqual(errors, []);
          } finally {
            await browser.close();
          }
        },
      );
      await t.test(
        "interrupted directory swap restores the captured original on restart",
        async () => {
          const previous = join(root, "interrupted-original"),
            stage = join(root, "interrupted-stage");
          await rename(directory, previous);
          await mkdir(stage);
          await writeFile(
            join(dataDir, "pending-sync.json"),
            JSON.stringify({ directory, previous, stage }),
          );
          await recoverLocalSync(dataDir);
          assert.equal(
            await readFile(join(directory, "SKILL.md"), "utf8"),
            "# External edit\n",
          );
        },
      );
    } finally {
      await app?.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
