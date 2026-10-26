import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import {
  createLibraryService,
  checksum,
  type LibraryOptions,
} from "../index.ts";
import { threeWay } from "../content.ts";
import {
  DomainError,
  type Actor,
  type SkillContent,
  type Proposal,
  type MergeInput,
} from "../../../contracts/index.ts";
const author: Actor = {
  userId: "author",
  teamId: "team-a",
  role: "contributor",
};
const reviewer: Actor = {
  userId: "reviewer",
  teamId: "team-a",
  role: "viewer",
};
const admin: Actor = { userId: "admin", teamId: "team-a", role: "admin" };
const viewer: Actor = { userId: "viewer", teamId: "team-a", role: "viewer" };
const other: Actor = { userId: "author", teamId: "team-b", role: "admin" };
const content = (
  text = "one\ntwo\nthree\n",
  extra: SkillContent["files"] = [],
): SkillContent => ({
  files: [
    { path: "SKILL.md", content: text, mediaType: "text/markdown" },
    ...extra,
  ],
});
const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;
function fixture(t: any, config: Partial<LibraryOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "library-service-"));
  const path = join(dir, "service.sqlite");
  const service = createLibraryService({ databasePath: path, ...config });
  t.after(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { service, path };
}
async function initial(
  service: ReturnType<typeof createLibraryService>,
  body = content(),
) {
  const { skill, draft } = await service.createSkill(author, {
    name: "测试技能",
    description: "说明",
    maintainerIds: [reviewer.userId, author.userId],
    content: body,
  });
  const proposal = await service.submitProposal(author, {
    draftId: draft.id,
    expectedRevision: 1,
    changeSummary: "首次生效",
    idempotencyKey: "initial-submit",
  });
  const input = await mergeInput(service, proposal, "initial-merge");
  const version = await service.mergeProposal(reviewer, input);
  return { skill, draft, proposal, version, input };
}
async function mergeInput(
  service: ReturnType<typeof createLibraryService>,
  proposal: Proposal,
  key: string,
): Promise<MergeInput> {
  const preview = await service.previewMerge(reviewer, proposal.id);
  return {
    proposalId: proposal.id,
    expectedRevision: proposal.revision,
    expectedCurrentVersionId: preview.currentVersionId,
    confirmationToken: preview.confirmationToken,
    idempotencyKey: key,
  };
}
async function proposalFor(
  service: ReturnType<typeof createLibraryService>,
  skillId: string,
  body: SkillContent,
  key: string,
) {
  let d = await service.createDraft(author, skillId);
  d = await service.saveDraft(author, {
    draftId: d.id,
    expectedRevision: d.revision,
    content: body,
  });
  return service.submitProposal(author, {
    draftId: d.id,
    expectedRevision: d.revision,
    changeSummary: key,
    idempotencyKey: key,
  });
}
async function worker(t: any, path: string): Promise<ChildProcess> {
  const child = fork(new URL("./process-worker.ts", import.meta.url), [path], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let errors = "";
  child.stderr?.on("data", (chunk) => (errors += chunk));
  const ready = await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => {
      throw new Error(errors);
    }),
  ]);
  assert.equal((ready[0] as any).ready, true);
  return child;
}
async function call(child: ChildProcess, message: object): Promise<any> {
  const result = once(child, "message");
  child.send(message);
  return (await result)[0];
}

test("first publication, immutable complete resources, history diff, restoration and durable audit", async (t) => {
  const { service, path } = fixture(t);
  const body = content("hello [guide](refs/guide.txt)\n", [
    { path: "refs/guide.txt", content: "old", mediaType: "text/plain" },
  ]);
  const { skill, version } = await initial(service, body);
  assert.equal(
    version.checksum,
    checksum({ files: [...body.files].reverse() }),
  );
  const p = await proposalFor(
    service,
    skill.id,
    content("hello [guide](refs/guide.txt)\n", [
      { path: "refs/guide.txt", content: "new", mediaType: "text/plain" },
    ]),
    "resource",
  );
  const v2 = await service.mergeProposal(
    reviewer,
    await mergeInput(service, p, "resource-merge"),
  );
  assert.equal(
    (await service.getVersion(viewer, version.id)).content.files.find(
      (f) => f.path === "refs/guide.txt",
    )!.content,
    "old",
  );
  assert.equal(
    (await service.compareVersions(viewer, version.id, v2.id))[0].path,
    "refs/guide.txt",
  );
  assert.deepEqual(
    (await service.listVersions(viewer, skill.id)).map((v) => v.number),
    [2, 1],
  );
  const restoration = await service.createDraft(author, skill.id, version.id);
  assert.equal(restoration.baseVersionId, v2.id);
  assert.deepEqual(restoration.content, version.content);
  const restored = await service.submitProposal(author, {
    draftId: restoration.id,
    expectedRevision: 1,
    changeSummary: "恢复",
    idempotencyKey: "restore",
  });
  const v3 = await service.mergeProposal(
    reviewer,
    await mergeInput(service, restored, "restore-merge"),
  );
  assert.equal(v3.number, 3);
  assert.equal(v3.checksum, version.checksum);
  assert.equal(
    (await service.listAudit(admin)).filter(
      (e) => e.action === "proposal.merge",
    ).length,
    3,
  );
  assert.equal((await service.listSkills(viewer, "测试")).length, 1);
  const db = new DatabaseSync(path);
  assert.throws(
    () =>
      db.prepare("UPDATE versions SET data=data WHERE id=?").run(version.id),
    /immutable/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM versions WHERE id=?").run(version.id),
    /immutable/,
  );
  db.close();
});

test("unpublished skills hidden; role, private draft, cross-team objects/events/audit isolation", async (t) => {
  const { service } = fixture(t);
  await assert.rejects(
    service.createSkill(viewer, {
      name: "x",
      description: "",
      maintainerIds: ["reviewer"],
      content: content(),
    }),
    code("FORBIDDEN"),
  );
  const { skill, draft } = await service.createSkill(author, {
    name: "x",
    description: "",
    maintainerIds: ["reviewer"],
    content: content(),
  });
  assert.deepEqual(await service.listSkills(viewer), []);
  assert.deepEqual((await service.catalogSnapshot(author)).versions, {});
  await assert.rejects(service.getSkill(viewer, skill.id), code("NOT_FOUND"));
  await assert.rejects(service.getDraft(reviewer, draft.id), code("FORBIDDEN"));
  await assert.rejects(service.getDraft(other, draft.id), code("NOT_FOUND"));
  const p = await service.submitProposal(author, {
    draftId: draft.id,
    expectedRevision: 1,
    changeSummary: "first",
    idempotencyKey: "submit",
  });
  await assert.rejects(service.getProposal(other, p.id), code("NOT_FOUND"));
  await assert.rejects(service.previewMerge(other, p.id), code("NOT_FOUND"));
  const v = await service.mergeProposal(
    reviewer,
    await mergeInput(service, p, "merge"),
  );
  for (const action of [
    () => service.getVersion(other, v.id),
    () => service.getSkill(other, skill.id),
    () => service.listVersions(other, skill.id),
    () => service.createDraft(other, skill.id),
  ])
    await assert.rejects(action(), code("NOT_FOUND"));
  assert.deepEqual(await service.listSkills(other), []);
  assert.deepEqual(await service.listProposals(other), []);
  assert.deepEqual(await service.listUpdateEvents(other, 0), []);
  assert.deepEqual(await service.listAudit(other), []);
  await assert.rejects(
    service.createDraft(viewer, skill.id),
    code("FORBIDDEN"),
  );
  await assert.rejects(
    service.setMaintainers(author, skill.id, ["author"]),
    code("FORBIDDEN"),
  );
  await assert.rejects(service.listAudit(viewer), code("FORBIDDEN"));
});

test("self-review prohibited for maintainer/admin; maintenance and membership revocation checked on merge", async (t) => {
  const revoked = new Set<string>();
  const { service } = fixture(t, {
    authorizeActor: (a) => !revoked.has(a.userId),
    isTeamMember: (_team, user) => !revoked.has(user),
  });
  const { skill } = await initial(service);
  const p = await proposalFor(service, skill.id, content("changed"), "change");
  assert.equal(
    (await service.previewMerge({ ...author, role: "admin" }, p.id)).proposalId,
    p.id,
  );
  await assert.rejects(service.previewMerge(viewer, p.id), code("FORBIDDEN"));
  await assert.rejects(
    service.reviewProposal(
      { ...author, role: "admin" },
      {
        proposalId: p.id,
        expectedRevision: p.revision,
        action: "reject",
        comment: "self",
      },
    ),
    code("FORBIDDEN"),
  );
  const input = await mergeInput(service, p, "merge");
  await assert.rejects(
    service.mergeProposal({ ...author, role: "admin" }, input),
    code("FORBIDDEN"),
  );
  await service.setMaintainers(admin, skill.id, ["author"]);
  await assert.rejects(
    service.mergeProposal(reviewer, input),
    code("FORBIDDEN"),
  );
  await service.setMaintainers(admin, skill.id, ["reviewer"]);
  revoked.add("reviewer");
  await assert.rejects(
    service.mergeProposal(reviewer, input),
    code("FORBIDDEN"),
  );
  let d = await service.createDraft(author, skill.id);
  d = await service.saveDraft(author, {
    draftId: d.id,
    expectedRevision: 1,
    content: content("x"),
  });
  await assert.rejects(
    service.submitProposal(author, {
      draftId: d.id,
      expectedRevision: d.revision,
      changeSummary: "x",
      idempotencyKey: "x",
    }),
    code("VALIDATION"),
  );
  await assert.rejects(
    service.setMaintainers(admin, skill.id, []),
    code("VALIDATION"),
  );
});

test("draft compare-and-swap across connections, independent drafts, immutable proposals and superseded approval", async (t) => {
  const { service, path } = fixture(t);
  const second = createLibraryService({ databasePath: path });
  t.after(() => second.close());
  const { skill } = await initial(service);
  const d = await service.createDraft(author, skill.id);
  const independent = await second.createDraft(
    { ...author, userId: "another" },
    skill.id,
  );
  const updated = await service.saveDraft(author, {
    draftId: d.id,
    expectedRevision: 1,
    content: content("changed"),
  });
  await assert.rejects(
    second.saveDraft(author, {
      draftId: d.id,
      expectedRevision: 1,
      content: content("lost"),
    }),
    code("STALE_REVISION"),
  );
  assert.equal(
    (await second.getDraft(author, d.id)).content.files[0].content,
    "changed",
  );
  assert.equal(independent.content.files[0].content, "one\ntwo\nthree\n");
  const submit = {
    draftId: d.id,
    expectedRevision: updated.revision,
    changeSummary: "change",
    idempotencyKey: "p",
  };
  const p = await service.submitProposal(author, submit);
  assert.equal((await second.submitProposal(author, submit)).id, p.id);
  await assert.rejects(
    service.submitProposal(author, { ...submit, changeSummary: "different" }),
    code("CONFLICT"),
  );
  const oldInput = await mergeInput(service, p, "old");
  const newer = await second.saveDraft(author, {
    draftId: d.id,
    expectedRevision: 2,
    content: content("newer"),
  });
  assert.equal(
    (await service.getProposal(author, p.id)).content.files[0].content,
    "changed",
  );
  const p2 = await second.submitProposal(author, {
    ...submit,
    expectedRevision: newer.revision,
    idempotencyKey: "p2",
  });
  assert.equal((await service.getProposal(author, p.id)).status, "withdrawn");
  await assert.rejects(
    service.mergeProposal(reviewer, oldInput),
    code("STALE_REVISION"),
  );
  await assert.rejects(
    service.reviewProposal(reviewer, {
      proposalId: p.id,
      expectedRevision: p.revision,
      action: "reject",
      comment: "old",
    }),
    code("STALE_REVISION"),
  );
  await assert.rejects(
    service.mergeProposal(reviewer, {
      ...(await mergeInput(service, p2, "new")),
      expectedRevision: 2,
    }),
    code("STALE_REVISION"),
  );
});

test("three-way disjoint line edits require fresh confirmation; overlap and attachment conflicts preserve all sides", async (t) => {
  const { service } = fixture(t);
  const { skill } = await initial(service);
  const a = await proposalFor(
    service,
    skill.id,
    content("ONE\ntwo\nthree\n"),
    "a",
  );
  const b = await proposalFor(
    service,
    skill.id,
    content("one\ntwo\nTHREE\n"),
    "b",
  );
  const old = await mergeInput(service, b, "b-merge");
  await service.mergeProposal(
    reviewer,
    await mergeInput(service, a, "a-merge"),
  );
  await assert.rejects(
    service.mergeProposal(reviewer, old),
    code("STALE_REVISION"),
  );
  const fresh = await service.previewMerge(reviewer, b.id);
  assert.deepEqual(fresh.conflicts, []);
  assert.equal(fresh.content.files[0].content, "ONE\ntwo\nTHREE\n");
  await assert.rejects(
    service.mergeProposal(reviewer, {
      ...old,
      expectedCurrentVersionId: fresh.currentVersionId,
    }),
    code("STALE_REVISION"),
  );
  await assert.rejects(
    service.mergeProposal(reviewer, {
      ...old,
      expectedCurrentVersionId: fresh.currentVersionId,
      confirmationToken: "invented",
    }),
    code("STALE_REVISION"),
  );
  await service.mergeProposal(reviewer, {
    ...old,
    expectedCurrentVersionId: fresh.currentVersionId,
    confirmationToken: fresh.confirmationToken,
  });
  const c = await proposalFor(
    service,
    skill.id,
    content("C\ntwo\nTHREE\n"),
    "c",
  );
  const d = await proposalFor(
    service,
    skill.id,
    content("D\ntwo\nTHREE\n"),
    "d",
  );
  await service.mergeProposal(
    reviewer,
    await mergeInput(service, c, "c-merge"),
  );
  const conflict = await service.previewMerge(reviewer, d.id);
  const authorConflict = await service.previewMerge(author, d.id);
  assert.deepEqual(authorConflict.conflicts, conflict.conflicts);
  await assert.rejects(
    service.mergeProposal(author, {
      proposalId: d.id,
      expectedRevision: d.revision,
      expectedCurrentVersionId: authorConflict.currentVersionId,
      confirmationToken: authorConflict.confirmationToken,
      idempotencyKey: "author-cannot-self-merge",
    }),
    code("FORBIDDEN"),
  );
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].base, "ONE\ntwo\nTHREE\n");
  await assert.rejects(
    service.mergeProposal(reviewer, await mergeInput(service, d, "d-merge")),
    code("CONFLICT"),
  );
  const file = (value: string) =>
    content("main", [
      { path: "data.json", content: value, mediaType: "application/json" },
    ]);
  const attachment = threeWay(file("base"), file("latest"), file("mine"));
  assert.deepEqual(attachment.conflicts, [
    { path: "data.json", base: "base", current: "latest", proposed: "mine" },
  ]);
  assert.equal(
    threeWay(content("a\nb\n"), content("A\nb\n"), content("a\nB\n")).content
      .files[0].content,
    "A\nB\n",
  );
  assert.equal(
    threeWay(content("a\nb\n"), content("x\na\nb\n"), content("a\nb\ny\n"))
      .content.files[0].content,
    "x\na\nb\ny\n",
  );
});

test("two independent OS processes race merge; loser must re-preview and no updates are lost", async (t) => {
  const { service, path } = fixture(t);
  const { skill } = await initial(service);
  const a = await proposalFor(
    service,
    skill.id,
    content("ONE\ntwo\nthree\n"),
    "a",
  );
  const b = await proposalFor(
    service,
    skill.id,
    content("one\ntwo\nTHREE\n"),
    "b",
  );
  const inputs = await Promise.all([
    mergeInput(service, a, "a-merge"),
    mergeInput(service, b, "b-merge"),
  ]);
  const workers = await Promise.all([worker(t, path), worker(t, path)]);
  const results = await Promise.all(
    workers.map((w, i) =>
      call(w, { operation: "merge", actor: reviewer, input: inputs[i] }),
    ),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.find((r) => !r.ok).code, "STALE_REVISION");
  const loser = results[0].ok ? b : a;
  const merged = await service.mergeProposal(
    reviewer,
    await mergeInput(service, loser, "loser-retry"),
  );
  assert.equal(merged.content.files[0].content, "ONE\ntwo\nTHREE\n");
  assert.equal((await service.listVersions(author, skill.id)).length, 3);
  assert.equal((await service.listUpdateEvents(author, 0)).length, 3);
});

test("duplicate merge across separate processes and restart returns one durable version/event", async (t) => {
  const { service, path } = fixture(t);
  const { skill } = await initial(service);
  const p = await proposalFor(service, skill.id, content("updated"), "p");
  const input = await mergeInput(service, p, "duplicate");
  const workers = await Promise.all([worker(t, path), worker(t, path)]);
  const results = await Promise.all(
    workers.map((w) => call(w, { operation: "merge", actor: reviewer, input })),
  );
  assert.ok(results.every((r) => r.ok));
  assert.equal(results[0].result.id, results[1].result.id);
  service.close();
  const reopened = createLibraryService({ databasePath: path });
  t.after(() => reopened.close());
  assert.equal(
    (await reopened.mergeProposal(reviewer, input)).id,
    results[0].result.id,
  );
  await assert.rejects(
    reopened.mergeProposal(reviewer, { ...input, expectedRevision: 999 }),
    code("CONFLICT"),
  );
  const fresh = await worker(t, path);
  const result = await call(fresh, {
    operation: "inspect",
    actor: author,
    skillId: skill.id,
  });
  assert.equal(result.result.versions.length, 2);
  assert.equal(result.result.events.length, 2);
  assert.equal(result.result.snapshot.versions[skill.id], results[0].result.id);
  const events = await reopened.listUpdateEvents(viewer, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].sequence, 2);
});

for (const stage of [
  "after_version",
  "after_pointer",
  "after_proposal",
  "after_event",
  "after_audit",
] as const)
  test(`fault rollback at ${stage} is atomic, including idempotency and audit`, async (t) => {
    let active = false;
    const { service, path } = fixture(t, {
      faultInjector: (s) => {
        if (active && s === stage) throw new Error("injected");
      },
    });
    const { skill, version } = await initial(service);
    const p = await proposalFor(service, skill.id, content("new"), "p");
    const input = await mergeInput(service, p, "merge");
    const before = (await service.listAudit(admin)).length;
    active = true;
    await assert.rejects(
      service.mergeProposal(reviewer, input),
      code("UNAVAILABLE"),
    );
    const independent = createLibraryService({ databasePath: path });
    t.after(() => independent.close());
    assert.equal(
      (await independent.getSkill(author, skill.id)).currentVersionId,
      version.id,
    );
    assert.equal((await independent.listVersions(author, skill.id)).length, 1);
    assert.equal(
      (await independent.getProposal(author, p.id)).status,
      "pending",
    );
    assert.equal((await independent.listUpdateEvents(author, 0)).length, 1);
    assert.equal((await independent.listAudit(admin)).length, before);
    active = false;
    assert.equal((await independent.mergeProposal(reviewer, input)).number, 2);
  });

test("review state transitions, request changes/resubmit, withdrawal and no-op submission", async (t) => {
  const { service } = fixture(t);
  const { skill } = await initial(service);
  let d = await service.createDraft(author, skill.id);
  await assert.rejects(
    service.submitProposal(author, {
      draftId: d.id,
      expectedRevision: 1,
      changeSummary: "none",
      idempotencyKey: "none",
    }),
    code("VALIDATION"),
  );
  d = await service.saveDraft(author, {
    draftId: d.id,
    expectedRevision: 1,
    content: content("change"),
  });
  await assert.rejects(
    service.submitProposal(author, {
      draftId: d.id,
      expectedRevision: 2,
      changeSummary: " ",
      idempotencyKey: "empty",
    }),
    code("VALIDATION"),
  );
  let p = await service.submitProposal(author, {
    draftId: d.id,
    expectedRevision: 2,
    changeSummary: "change",
    idempotencyKey: "p",
  });
  p = await service.reviewProposal(reviewer, {
    proposalId: p.id,
    expectedRevision: p.revision,
    action: "request_changes",
    comment: "请补充",
  });
  assert.equal(p.status, "changes_requested");
  assert.equal((await service.previewMerge(author, p.id)).proposalId, p.id);
  await assert.rejects(
    service.mergeProposal(
      reviewer,
      await mergeInput(service, p, "requested-changes-merge"),
    ),
    code("STALE_REVISION"),
  );
  d = await service.saveDraft(author, {
    draftId: d.id,
    expectedRevision: 2,
    content: content("revised"),
  });
  const next = await service.submitProposal(author, {
    draftId: d.id,
    expectedRevision: 3,
    changeSummary: "revision",
    idempotencyKey: "next",
  });
  assert.equal((await service.getProposal(author, p.id)).status, "withdrawn");
  await service.withdrawProposal(author, next.id, next.revision);
  await assert.rejects(
    service.previewMerge(reviewer, next.id),
    code("STALE_REVISION"),
  );
  const rejected = await proposalFor(
    service,
    skill.id,
    content("reject"),
    "reject",
  );
  await service.reviewProposal(reviewer, {
    proposalId: rejected.id,
    expectedRevision: rejected.revision,
    action: "reject",
    comment: "拒绝",
  });
  await assert.rejects(
    service.previewMerge(reviewer, rejected.id),
    code("STALE_REVISION"),
  );
});

test("input validation: normalized paths, references, types, scripts, malformed actor and revision", async (t) => {
  const { service } = fixture(t);
  const create = (body: SkillContent) =>
    service.createSkill(author, {
      name: "x",
      description: "",
      maintainerIds: ["reviewer"],
      content: body,
    });
  for (const path of [
    "../secret",
    "/absolute",
    "a/../b",
    "a//b",
    "a\\b",
    "./a",
    "a%2fb",
  ])
    await assert.rejects(
      create(
        content("main", [{ path, content: "x", mediaType: "text/plain" }]),
      ),
      code("VALIDATION"),
    );
  await assert.rejects(create({ files: [] }), code("VALIDATION"));
  await assert.rejects(
    create(
      content("main", [
        { path: "SKILL.md", content: "duplicate", mediaType: "text/plain" },
      ]),
    ),
    code("VALIDATION"),
  );
  await assert.rejects(
    create(content("[missing](refs/a.txt)")),
    code("RESOURCE_MISSING"),
  );
  await assert.rejects(
    create(content("[resource][ref]\n\n[ref]: absent.txt")),
    code("RESOURCE_MISSING"),
  );
  await assert.rejects(
    create(
      content("main", [
        { path: "pic.png", content: "binary", mediaType: "image/png" },
      ]),
    ),
    code("VALIDATION"),
  );
  await assert.rejects(
    create(
      content("main", [
        { path: "run.sh", content: "echo hi", mediaType: "text/plain" },
      ]),
    ),
    code("FORBIDDEN"),
  );
  await assert.rejects(create(content("\ud800")), code("VALIDATION"));
  await assert.rejects(
    service.listSkills({ ...author, role: "root" } as any),
    code("FORBIDDEN"),
  );
  await assert.rejects(
    service.createSkill(author, null as any),
    code("VALIDATION"),
  );
  await assert.rejects(
    service.listUpdateEvents(author, -1),
    code("VALIDATION"),
  );
  const { draft } = await create(content("[external](https://example.com)"));
  await assert.rejects(
    service.saveDraft(author, {
      draftId: draft.id,
      expectedRevision: NaN,
      content: content(),
    }),
    code("VALIDATION"),
  );
});

test("merge revalidates combined references; corrupt history is detected without fallback", async (t) => {
  const { service, path } = fixture(t);
  const { skill, version } = await initial(
    service,
    content("main", [
      { path: "a.txt", content: "data", mediaType: "text/plain" },
    ]),
  );
  const deletion = await proposalFor(
    service,
    skill.id,
    content("main"),
    "delete",
  );
  const reference = await proposalFor(
    service,
    skill.id,
    content("[data](a.txt)", [
      { path: "a.txt", content: "data", mediaType: "text/plain" },
    ]),
    "link",
  );
  await service.mergeProposal(
    reviewer,
    await mergeInput(service, deletion, "delete-merge"),
  );
  await assert.rejects(
    service.mergeProposal(
      reviewer,
      await mergeInput(service, reference, "link-merge"),
    ),
    code("RESOURCE_MISSING"),
  );
  const db = new DatabaseSync(path);
  db.exec("DROP TRIGGER versions_no_update");
  db.prepare(
    "UPDATE versions SET data=json_set(data,'$.checksum','broken') WHERE id=?",
  ).run(version.id);
  db.close();
  await assert.rejects(
    service.getVersion(viewer, version.id),
    code("RESOURCE_MISSING"),
  );
});

test("Markdown references respect code fences and space-containing paths; JSON format and platform policy checked", async (t) => {
  const { service } = fixture(t, {
    canEditScripts: () => true,
    validatePackage: (_actor, body) => {
      if (body.files.some((f) => f.content.includes("denied-by-host")))
        throw new DomainError("VALIDATION", "平台校验失败");
    },
  });
  const create = (body: SkillContent) =>
    service.createSkill(author, {
      name: "x",
      description: "",
      maintainerIds: ["reviewer"],
      content: body,
    });
  await create(
    content(
      "```md\n[example](not-a-resource)\n```\n`[example](absent)`\n[real](<my notes.txt>)",
      [{ path: "my notes.txt", content: "notes", mediaType: "text/plain" }],
    ),
  );
  await assert.rejects(
    create(content("[real](<missing notes.txt>)")),
    code("RESOURCE_MISSING"),
  );
  await assert.rejects(
    create(
      content("main", [
        {
          path: "data.json",
          content: "invalid",
          mediaType: "application/json",
        },
      ]),
    ),
    code("VALIDATION"),
  );
  await assert.rejects(create(content("denied-by-host")), code("VALIDATION"));
  const created = await create(
    content("[script](run.sh)", [
      { path: "run.sh", content: "echo hi", mediaType: "text/x-shellscript" },
    ]),
  );
  assert.equal(created.draft.content.files.length, 2);
});

test("complex text merges fail safely into conflicts without losing any side", () => {
  const lines = Array.from({ length: 2100 }, (_, i) => `base-${i}`).join("\n");
  const left = Array.from({ length: 2100 }, (_, i) => `left-${i}`).join("\n");
  const right = Array.from({ length: 2100 }, (_, i) => `right-${i}`).join("\n");
  const result = threeWay(content(lines), content(left), content(right));
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].base, lines);
  assert.equal(result.conflicts[0].current, left);
  assert.equal(result.conflicts[0].proposed, right);
});
