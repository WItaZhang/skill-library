/** Isolated, disposable UI demo. Not authentication, durable storage, or Agent execution. */
import {
  DomainError,
  type Actor,
  type Draft,
  type Invocation,
  type LibraryService,
  type DraftUpdatePreview,
  type SkillUpdateEvent,
  type SkillUpdateSource,
  type FileDiff,
  type RuntimeService,
  type SessionPreference,
  type Skill,
  type SkillContent,
  type SkillVersion,
  type TaskSnapshot,
} from "../../contracts";
const copy = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const body = (text: string): SkillContent => ({
  files: [{ path: "SKILL.md", content: text, mediaType: "text/markdown" }],
});
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
async function checksum(content: SkillContent) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify(
        [...content.files]
          .sort((a, b) => (a.path < b.path ? -1 : 1))
          .map(({ path, content, mediaType }) => ({
            path,
            content,
            mediaType,
          })),
      ),
    ),
  );
  return [...new Uint8Array(bytes)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export const demoActor: Actor = {
  userId: "qianqian",
  teamId: "demo-team",
  role: "admin",
};
export async function createDemo() {
  let serial = 10;
  const id = (prefix: string) => `${prefix}-${++serial}`;
  const skills: Skill[] = [
    [
      "research",
      "深度研究助手",
      "从问题出发，梳理来源，形成有据可查的研究结论。",
    ],
    ["weekly", "团队周报", "把零散的进展整理成清晰、可行动的团队周报。"],
    ["writing", "清晰写作", "让复杂的想法更容易理解，让每一句话都有用。"],
  ].map(([id, name, description]) => ({
    id,
    name,
    description,
    teamId: "demo-team",
    maintainerIds: ["qianqian", "lin"],
    currentVersionId: `${id}-v2`,
    createdAt: now(),
  }));
  const versions: SkillVersion[] = [];
  for (const s of skills)
    for (let n = 1; n <= 2; n++) {
      const content = body(
        `# ${s.name}\n\n## 目标\n${s.description}\n\n## 工作步骤\n1. 明确用户的目标与范围。\n2. 整理输入，检查关键信息。\n3. 给出清晰的结论与下一步。${n === 2 ? "\n4. 标注不确定性，并列出可核验的来源。" : ""}\n`,
      );
      versions.push({
        id: `${s.id}-v${n}`,
        skillId: s.id,
        teamId: "demo-team",
        number: n,
        parentVersionId: n === 1 ? null : `${s.id}-v1`,
        content,
        checksum: await checksum(content),
        changeSummary:
          n === 1 ? "建立团队使用规范" : "补充核验步骤与不确定性说明",
        authorId: "lin",
        reviewerId: "qianqian",
        createdAt: `2026-10-${20 + n}T08:00:00Z`,
      });
    }
  const drafts: Draft[] = [];
  const sessions = new Set(["demo-session"]),
    preferences: SessionPreference[] = [],
    tasks: TaskSnapshot[] = [
      {
        taskId: "demo-running-task",
        sessionId: "demo-session",
        teamId: "demo-team",
        actorId: "qianqian",
        versions: { research: "research-v1" },
        preferenceRevisions: { research: 0 },
        createdAt: now(),
      },
    ];
  const invocations: Invocation[] = [
    {
      id: "demo-invocation",
      taskId: "demo-running-task",
      sessionId: "demo-session",
      skillId: "research",
      versionId: "research-v1",
      checksum: versions[0].checksum,
      createdAt: now(),
    },
  ];
  const receipts = new Map<string, unknown>(),
    previews = new Map<string, DraftUpdatePreview>();
  const events: SkillUpdateEvent[] = [];
  const listeners = new Set<{
    actor: Actor;
    handlers: Parameters<SkillUpdateSource["subscribe"]>[1];
  }>();
  const updateSource: SkillUpdateSource = {
    subscribe(actor, handlers) {
      access(actor);
      const listener = { actor, handlers };
      listeners.add(listener);
      handlers.onReconnect();
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const access = (actor: Actor) => {
    if (actor.teamId !== "demo-team")
      throw new DomainError("FORBIDDEN", "演示仅包含演示团队。");
  };
  const find = <T extends { id: string }>(items: T[], itemId: string) => {
    const found = items.find((x) => x.id === itemId);
    if (!found) throw new DomainError("NOT_FOUND", "找不到此记录。");
    return found;
  };
  const edit = (a: Actor, skillId?: string) => {
    access(a);
    if (
      a.role === "viewer" &&
      (!skillId || !find(skills, skillId).maintainerIds.includes(a.userId))
    )
      throw new DomainError("FORBIDDEN", "需要贡献者权限。");
  };
  const owned = (a: Actor, d: Draft) => {
    edit(a, d.skillId);
    if (d.authorId !== a.userId)
      throw new DomainError("FORBIDDEN", "只能编辑自己的草稿。");
  };
  const revision = (actual: number, expected: number) => {
    if (actual !== expected)
      throw new DomainError("STALE_REVISION", "修订已更新。");
  };
  const validate = (c: SkillContent, strict = true) => {
    if (
      (strict &&
        !c.files.some((f) => f.path === "SKILL.md" && f.content.trim())) ||
      new Set(c.files.map((f) => f.path)).size !== c.files.length ||
      c.files.some(
        (f) =>
          !f.path ||
          f.path.startsWith("/") ||
          f.path.includes("..") ||
          f.path.includes("\\"),
      )
    )
      throw new DomainError(
        "VALIDATION",
        "需要非空 SKILL.md 与规范、唯一的资源路径。",
      );
  };
  const library: LibraryService = {
    async listSkills(a, q = "") {
      access(a);
      return copy(skills.filter((s) => s.name.includes(q)));
    },
    async getSkill(a, s) {
      access(a);
      return copy(find(skills, s));
    },
    async createSkill(a, input) {
      edit(a);
      validate(input.content);
      const skill: Skill = {
        ...input,
        id: id("skill"),
        teamId: a.teamId,
        currentVersionId: null,
        createdAt: now(),
      };
      skills.push(skill);
      const draft: Draft = {
        id: id("draft"),
        skillId: skill.id,
        teamId: a.teamId,
        authorId: a.userId,
        baseVersionId: null,
        revision: 1,
        content: copy(input.content),
        updatedAt: now(),
      };
      drafts.push(draft);
      return copy({ skill, draft });
    },
    async setMaintainers(a, s, userIds) {
      access(a);
      if (a.role !== "admin" || !userIds.length)
        throw new DomainError("FORBIDDEN", "请由管理员配置维护者。");
      const skill = find(skills, s);
      skill.maintainerIds = [...userIds];
      return copy(skill);
    },
    async listVersions(a, s) {
      access(a);
      return copy(
        versions
          .filter((v) => v.skillId === s)
          .sort((a, b) => b.number - a.number),
      );
    },
    async getVersion(a, v) {
      access(a);
      return copy(find(versions, v));
    },
    async compareVersions(a, before, after) {
      access(a);
      const b = find(versions, before).content.files,
        c = find(versions, after).content.files;
      return [...new Set([...b, ...c].map((f) => f.path))].flatMap((path) => {
        const before = b.find((f) => f.path === path)?.content,
          after = c.find((f) => f.path === path)?.content;
        return before === after
          ? []
          : [
              {
                path,
                kind:
                  before === undefined
                    ? ("added" as const)
                    : after === undefined
                      ? ("removed" as const)
                      : ("modified" as const),
                before,
                after,
              },
            ];
      });
    },
    async createDraft(a, s, source) {
      edit(a, s);
      const skill = find(skills, s);
      const draft: Draft = {
        id: id("draft"),
        skillId: s,
        teamId: a.teamId,
        authorId: a.userId,
        baseVersionId: skill.currentVersionId,
        revision: 1,
        content:
          source || skill.currentVersionId
            ? copy(find(versions, source || skill.currentVersionId!).content)
            : body(""),
        updatedAt: now(),
      };
      drafts.push(draft);
      return copy(draft);
    },
    async getDraft(a, d) {
      const draft = find(drafts, d);
      owned(a, draft);
      return copy(draft);
    },
    async saveDraft(a, input) {
      const d = find(drafts, input.draftId);
      owned(a, d);
      revision(d.revision, input.expectedRevision);
      validate(input.content, false);
      d.content = copy(input.content);
      d.revision++;
      d.updatedAt = now();
      return copy(d);
    },
    async publishDraft(a, input) {
      const d = find(drafts, input.draftId);
      owned(a, d);
      const receiptKey = `${a.userId}:publish:${input.idempotencyKey}`;
      const existing = receipts.get(receiptKey) as
        { input: unknown; value: SkillVersion } | undefined;
      if (existing) {
        if (!equal(existing.input, input))
          throw new DomainError("CONFLICT", "幂等键内容不同。");
        return copy(existing.value);
      }
      revision(d.revision, input.expectedRevision);
      const s = find(skills, d.skillId);
      if (
        d.baseVersionId !== s.currentVersionId ||
        input.expectedBaseVersionId !== d.baseVersionId
      )
        throw new DomainError("STALE_REVISION", "请先确认同步新版。");
      validate(d.content);
      if (!input.changeSummary.trim())
        throw new DomainError("VALIDATION", "请填写修改说明。");
      const digest = await checksum(d.content);
      // The demo also rechecks after the asynchronous digest.
      revision(d.revision, input.expectedRevision);
      if (s.currentVersionId !== d.baseVersionId)
        throw new DomainError("STALE_REVISION", "新版已生效。");
      const v: SkillVersion = {
        id: id("version"),
        skillId: s.id,
        teamId: a.teamId,
        number: versions.filter((v) => v.skillId === s.id).length + 1,
        parentVersionId: s.currentVersionId,
        content: copy(d.content),
        checksum: digest,
        changeSummary: input.changeSummary,
        authorId: a.userId,
        reviewerId: null,
        approvalMode: "automatic",
        createdAt: now(),
      };
      versions.push(v);
      s.currentVersionId = v.id;
      d.baseVersionId = v.id;
      d.revision++;
      d.updatedAt = now();
      receipts.set(receiptKey, { input: copy(input), value: copy(v) });
      const event: SkillUpdateEvent = {
        id: id("event"),
        sequence: events.length + 1,
        teamId: a.teamId,
        skillId: s.id,
        previousVersionId: v.parentVersionId,
        versionId: v.id,
        createdAt: now(),
      };
      events.push(event);
      for (const listener of listeners)
        if (listener.actor.teamId === a.teamId)
          listener.handlers.onUpdate(copy(event));
      return copy(v);
    },
    async previewDraftUpdate(a, input) {
      const d = find(drafts, input.draftId);
      owned(a, d);
      revision(d.revision, input.expectedRevision);
      validate(input.content, false);
      const s = find(skills, d.skillId);
      const baseContent = d.baseVersionId
        ? find(versions, d.baseVersionId).content
        : { files: [] };
      const latestContent = s.currentVersionId
        ? find(versions, s.currentVersionId).content
        : { files: [] };
      const diff = (before: SkillContent, after: SkillContent): FileDiff[] =>
        [
          ...new Set([...before.files, ...after.files].map((f) => f.path)),
        ].flatMap((path) => {
          const b = before.files.find((f) => f.path === path)?.content,
            c = after.files.find((f) => f.path === path)?.content;
          return b === c
            ? []
            : [
                {
                  path,
                  before: b,
                  after: c,
                  kind:
                    b === undefined
                      ? "added"
                      : c === undefined
                        ? "removed"
                        : "modified",
                },
              ];
        });
      const preview: DraftUpdatePreview = {
        draftId: d.id,
        draftRevision: d.revision,
        baseVersionId: d.baseVersionId,
        targetVersionId: s.currentVersionId,
        baseContent: copy(baseContent),
        latestContent: copy(latestContent),
        localContent: copy(input.content),
        candidateContent: { files: [] },
        localDiff: diff(baseContent, input.content),
        remoteDiff: diff(baseContent, latestContent),
        conflicts: [],
        confirmationToken: id("preview"),
      };
      for (const path of new Set(
        [
          ...baseContent.files,
          ...latestContent.files,
          ...input.content.files,
        ].map((f) => f.path),
      )) {
        const b = baseContent.files.find((f) => f.path === path),
          c = latestContent.files.find((f) => f.path === path),
          mine = input.content.files.find((f) => f.path === path);
        if (!equal(b, c) && !equal(b, mine) && !equal(c, mine))
          preview.conflicts.push({
            path,
            base: b?.content,
            current: c?.content,
            proposed: mine?.content,
          });
        const chosen = equal(b, mine) ? c : mine;
        if (chosen) preview.candidateContent.files.push(copy(chosen));
      }
      previews.set(preview.confirmationToken, copy(preview));
      return copy(preview);
    },
    async applyDraftUpdate(a, input) {
      const d = find(drafts, input.draftId);
      owned(a, d);
      const receiptKey = `${a.userId}:apply:${input.idempotencyKey}`;
      const existing = receipts.get(receiptKey) as
        { input: unknown; value: Draft } | undefined;
      if (existing) {
        if (!equal(existing.input, input))
          throw new DomainError("CONFLICT", "幂等键内容不同。");
        return copy(existing.value);
      }
      revision(d.revision, input.expectedRevision);
      const p = previews.get(input.confirmationToken),
        s = find(skills, d.skillId);
      if (
        !p ||
        p.draftId !== d.id ||
        p.draftRevision !== d.revision ||
        p.baseVersionId !== d.baseVersionId ||
        p.targetVersionId !== s.currentVersionId ||
        input.targetVersionId !== s.currentVersionId
      )
        throw new DomainError("STALE_REVISION", "请重新比较并确认。");
      validate(input.resolvedContent, false);
      d.content = copy(input.resolvedContent);
      d.baseVersionId = p.targetVersionId;
      d.revision++;
      d.updatedAt = now();
      receipts.set(receiptKey, { input: copy(input), value: copy(d) });
      return copy(d);
    },
    async catalogSnapshot(a) {
      access(a);
      return {
        teamId: a.teamId,
        versions: Object.fromEntries(
          skills
            .filter((s) => s.currentVersionId)
            .map((s) => [s.id, s.currentVersionId!]),
        ),
        capturedAt: now(),
      };
    },
    async listUpdateEvents(a, after) {
      access(a);
      return copy(events.filter((e) => e.sequence > after));
    },
    async listAudit(a) {
      access(a);
      return [];
    },
  };
  const session = (a: Actor, s: string) => {
    access(a);
    if (!sessions.has(s)) throw new DomainError("NOT_FOUND", "会话不存在。");
  };
  const runtime: RuntimeService = {
    async createSession(a) {
      access(a);
      const sid = id("session");
      sessions.add(sid);
      return { id: sid };
    },
    async createTask(a, s, tid) {
      session(a, s);
      const existing = tasks.find((t) => t.taskId === tid);
      if (existing) return copy(existing);
      const catalog = await library.catalogSnapshot(a);
      const t: TaskSnapshot = {
        taskId: tid,
        sessionId: s,
        teamId: a.teamId,
        actorId: a.userId,
        versions: catalog.versions,
        preferenceRevisions: {},
        createdAt: now(),
      };
      for (const p of preferences.filter((p) => p.sessionId === s)) {
        if (p.mode === "pinned") t.versions[p.skillId] = p.pinnedVersionId!;
        t.preferenceRevisions[p.skillId] = p.revision;
      }
      tasks.push(t);
      return copy(t);
    },
    async getTask(a, tid) {
      access(a);
      const t = tasks.find((t) => t.taskId === tid);
      if (!t) throw new DomainError("NOT_FOUND", "任务不存在。");
      return copy(t);
    },
    async createChildTask(a, parent, tid) {
      const existing = tasks.find((t) => t.taskId === tid);
      if (existing) return copy(existing);
      const t = {
        ...(await runtime.getTask(a, parent)),
        taskId: tid,
        parentTaskId: parent,
      };
      tasks.push(t);
      return copy(t);
    },
    async resolveSkill(a, tid, s) {
      const t = await runtime.getTask(a, tid);
      if (!t.versions[s])
        throw new DomainError(
          "RESOURCE_MISSING",
          "此任务没有该技能的固定版本。",
        );
      return library.getVersion(a, t.versions[s]);
    },
    async recordInvocation(a, tid, s) {
      const t = await runtime.getTask(a, tid),
        v = await runtime.resolveSkill(a, tid, s);
      const invocation: Invocation = {
        id: id("invocation"),
        taskId: tid,
        sessionId: t.sessionId,
        skillId: s,
        versionId: v.id,
        checksum: v.checksum,
        createdAt: now(),
      };
      invocations.push(invocation);
      return copy(invocation);
    },
    async listInvocations(a, s) {
      session(a, s);
      return copy(invocations.filter((i) => i.sessionId === s));
    },
    async getSessionUpdates(a, s) {
      session(a, s);
      const used = new Map(
        invocations
          .filter((i) => i.sessionId === s)
          .map((i) => [i.skillId, i.versionId]),
      );
      return [...used].flatMap(([skillId, usedVersionId]) => {
        const latestVersionId = find(skills, skillId).currentVersionId!;
        const preference =
          preferences.find((p) => p.sessionId === s && p.skillId === skillId) ||
          null;
        return latestVersionId === usedVersionId &&
          preference?.mode !== "pinned"
          ? []
          : [
              copy({
                sessionId: s,
                skillId,
                usedVersionId,
                latestVersionId,
                preference,
              }),
            ];
      });
    },
    async setPreference(a, input) {
      session(a, input.sessionId);
      let p = preferences.find(
        (p) => p.sessionId === input.sessionId && p.skillId === input.skillId,
      );
      revision(p?.revision ?? 0, input.expectedRevision);
      if (
        input.mode === "latest" &&
        find(skills, input.skillId).currentVersionId !== input.targetVersionId
      )
        throw new DomainError(
          "STALE_REVISION",
          "目标版本已有更新，请重新查看变化。",
        );
      if (
        input.mode === "pinned" &&
        !invocations.some(
          (i) =>
            i.sessionId === input.sessionId &&
            i.skillId === input.skillId &&
            i.versionId === input.targetVersionId,
        )
      )
        throw new DomainError("VALIDATION", "只能保留本会话实际使用过的版本。");
      if (!p) {
        p = {
          sessionId: input.sessionId,
          skillId: input.skillId,
          mode: "latest",
          pinnedVersionId: null,
          revision: 0,
        };
        preferences.push(p);
      }
      p.mode = input.mode;
      p.pinnedVersionId =
        input.mode === "pinned" ? input.targetVersionId : null;
      p.revision++;
      return copy(p);
    },
  };
  async function simulatePublication(skillId: string) {
    const author: Actor = {
      ...demoActor,
      userId: "another-demo-author",
      role: "contributor",
    };
    const d = await library.createDraft(author, skillId);
    const next = await library.saveDraft(author, {
      draftId: d.id,
      expectedRevision: d.revision,
      content: {
        files: [
          ...d.content.files,
          {
            path: `references/demo-${serial}.md`,
            content: "另一作者新增的演示说明",
            mediaType: "text/markdown",
          },
        ],
      },
    });
    await library.publishDraft(author, {
      draftId: next.id,
      expectedRevision: next.revision,
      expectedBaseVersionId: next.baseVersionId,
      changeSummary: "另一作者发布（本地演示）",
      idempotencyKey: id("publish"),
    });
  }
  return {
    library,
    runtime,
    actor: demoActor,
    sessionId: "demo-session",
    updateSource,
    simulatePublication,
  };
}
