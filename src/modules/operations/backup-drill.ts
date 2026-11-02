import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import {
  migrate,
  createPostgresLibraryService,
  createPostgresRuntimeService,
} from "../persistence/index.ts";
import {
  databaseFingerprint,
  dumpDatabase,
  restoreDatabase,
} from "./backup.ts";
import type { Actor, Draft } from "../../contracts/index.ts";

const baseOnly = process.argv.includes("--base-only");
const adminUrl = process.env.DRILL_ADMIN_URL;
if (!adminUrl)
  throw new Error(
    "DRILL_ADMIN_URL required: role must create NEW temporary databases; never pass a business restore target",
  );
const suffix = randomUUID().replaceAll("-", "");
const sourceName = "ops_drill_source_" + suffix,
  targetName = "ops_drill_restore_" + suffix;
const connection = (name: string) => {
  const url = new URL(adminUrl);
  url.pathname = "/" + name;
  return url.href;
};
const admin = new Pool({
  connectionString: adminUrl,
  connectionTimeoutMillis: 3000,
});
const directory = await mkdtemp(join(tmpdir(), "skill-backup-drill-"));
let source: Pool | undefined,
  target: Pool | undefined,
  sourceCreated = false,
  targetCreated = false;
const started = performance.now();
try {
  // Names generated here, quoted, and never supplied by an operator. No existing DB is altered.
  await admin.query(`CREATE DATABASE "${sourceName}"`);
  sourceCreated = true;
  await admin.query(`CREATE DATABASE "${targetName}"`);
  targetCreated = true;
  source = new Pool({ connectionString: connection(sourceName) });
  target = new Pool({ connectionString: connection(targetName) });
  await migrate(source);
  const actor: Actor = {
    userId: randomUUID(),
    teamId: randomUUID(),
    role: "admin",
  };
  const member: Actor = {
    userId: randomUUID(),
    teamId: actor.teamId,
    role: "contributor",
  };
  await source.query("INSERT INTO teams(id,name) VALUES($1,$2)", [
    actor.teamId,
    "备份恢复演练",
  ]);
  for (const a of [actor, member]) {
    await source.query(
      "INSERT INTO users(id,display_name,email) VALUES($1,$2,$3)",
      [a.userId, "演练用户", `${a.userId}@example.test`],
    );
    await source.query(
      "INSERT INTO auth_identities(id,user_id,provider,provider_subject) VALUES($1,$2,$3,$4)",
      [randomUUID(), a.userId, "backup-test", a.userId],
    );
    await source.query(
      "INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,$3)",
      [a.teamId, a.userId, a.role],
    );
  }
  const library = createPostgresLibraryService({ pool: source }),
    runtime = createPostgresRuntimeService({ pool: source });
  const content = (text: string) => ({
    files: [{ path: "SKILL.md", content: text, mediaType: "text/markdown" }],
  });
  const publish = (draft: Draft) =>
    library.publishDraft(actor, {
      draftId: draft.id,
      expectedRevision: draft.revision,
      expectedBaseVersionId: draft.baseVersionId,
      changeSummary: "备份样本",
      idempotencyKey: randomUUID(),
    });
  const { skill, draft } = await library.createSkill(actor, {
    name: "恢复校验",
    description: "fixture data",
    maintainerIds: [],
    content: content("# v1"),
  });
  const v1 = await publish(draft);
  const saved = await library.createDraft(member, skill.id);
  await library.saveDraft(member, {
    draftId: saved.id,
    expectedRevision: saved.revision,
    content: content("# 未发布输入"),
  });
  const session = await runtime.createSession(actor),
    task = await runtime.createTask(actor, session.id, randomUUID());
  let executionId: string | undefined;
  let executionModule: any;
  const provider = {
    name: "backup-drill-fixture",
    model: "fixture-no-external-call",
    async execute() {
      return {
        text: "恢复演练固定结果（非真实模型）",
        providerRequestId: "backup-fixture-request",
      };
    },
  };
  if (!baseOnly) {
    executionModule = await import(
      new URL("../execution/index.ts", import.meta.url).href
    );
    const execution = executionModule.createExecutionService({
      pool: source,
      provider,
    });
    const accepted = await execution.accept(actor, {
      prompt: "备份演练（无外部调用）",
      skillIds: [skill.id],
      idempotencyKey: randomUUID(),
    });
    executionId = accepted.id;
    assert.equal(await execution.runOnce(), true);
    assert.equal((await execution.get(actor, executionId)).status, "succeeded");
    await execution.stop();
  }
  const d2 = await library.createDraft(actor, skill.id),
    s2 = await library.saveDraft(actor, {
      draftId: d2.id,
      expectedRevision: d2.revision,
      content: content("# v2"),
    });
  const v2 = await publish(s2);
  assert.equal(
    (await runtime.getTask(actor, task.taskId)).versions[skill.id],
    v1.id,
  );
  const before = await databaseFingerprint(source);
  for (const name of [
    "users",
    "auth_identities",
    "team_memberships",
    "versions",
    "drafts",
    "runtime_tasks",
    "runtime_task_versions",
    ...(!baseOnly
      ? [
          "execution_requests",
          "execution_attempts",
          "execution_results",
          "execution_receipts",
          "execution_skills",
        ]
      : []),
  ])
    assert.ok(before[name]?.rows > 0, `${name} needs real sample rows`);
  const dumpStart = performance.now(),
    archive = join(directory, "database.dump");
  const archiveSha256 = await dumpDatabase(connection(sourceName), archive),
    dumpMs = performance.now() - dumpStart;
  const restoreStart = performance.now();
  assert.equal(
    (
      await target.query(
        "SELECT count(*) FROM pg_tables WHERE schemaname='public'",
      )
    ).rows[0].count,
    "0",
  );
  await restoreDatabase(connection(targetName), archive);
  assert.deepEqual(await databaseFingerprint(target), before);
  await migrate(target); // Restored ledger and source checksums must agree.
  const restoredLibrary = createPostgresLibraryService({ pool: target }),
    restoredRuntime = createPostgresRuntimeService({ pool: target });
  assert.equal(
    (await restoredLibrary.getSkill(actor, skill.id)).currentVersionId,
    v2.id,
  );
  assert.equal(
    (await restoredLibrary.getDraft(member, saved.id)).content.files[0].content,
    "# 未发布输入",
  );
  assert.equal(
    (await restoredRuntime.resolveSkill(actor, task.taskId, skill.id)).id,
    v1.id,
  );
  if (executionId) {
    const execution = executionModule.createExecutionService({
      pool: target,
      provider,
    });
    const record = await execution.get(actor, executionId);
    assert.equal(record.status, "succeeded");
    assert.equal(record.snapshot.versions[skill.id], v1.id);
    assert.equal(record.attempts.length, 1);
    assert.equal(record.result.providerRequestId, "backup-fixture-request");
    await execution.stop();
  }
  // Verify sequence continues after restore by publishing another version.
  const d3 = await restoredLibrary.createDraft(actor, skill.id),
    s3 = await restoredLibrary.saveDraft(actor, {
      draftId: d3.id,
      expectedRevision: d3.revision,
      content: content("# v3 after restore"),
    });
  await restoredLibrary.publishDraft(actor, {
    draftId: s3.id,
    expectedRevision: s3.revision,
    expectedBaseVersionId: s3.baseVersionId,
    changeSummary: "恢复后可写",
    idempotencyKey: randomUUID(),
  });
  const report = {
    passed: true,
    mode: baseOnly
      ? "base-only; execution NOT checked"
      : "full; execution fixture, no external model",
    postgres: (await admin.query("SHOW server_version")).rows[0].server_version,
    archiveSha256,
    tables: before,
    dumpMs: Math.round(dumpMs),
    restoreAndVerifyMs: Math.round(performance.now() - restoreStart),
    totalMs: Math.round(performance.now() - started),
    sourceDatabase: sourceName,
    targetDatabase: targetName,
    cleanup:
      "finally closes pools and drops only these two generated databases",
  };
  if (process.env.DRILL_REPORT) {
    const file = resolve(process.env.DRILL_REPORT);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await source?.end();
  await target?.end();
  if (targetCreated) await admin.query(`DROP DATABASE "${targetName}"`);
  if (sourceCreated) await admin.query(`DROP DATABASE "${sourceName}"`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
