/** Isolated, disposable UI demo. Not authentication, durable storage, or Agent execution. */
import {
  DomainError,
  type Actor,
  type Draft,
  type Invocation,
  type LibraryService,
  type MergePreview,
  type Proposal,
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
  const drafts: Draft[] = [],
    proposals: Proposal[] = [
      {
        id: "proposal-review",
        skillId: "weekly",
        teamId: "demo-team",
        authorId: "lin",
        baseVersionId: "weekly-v2",
        revision: 1,
        content: body(
          versions.find((v) => v.id === "weekly-v2")!.content.files[0].content +
            "\n## 输出格式\n本周进展 / 风险 / 下周计划\n",
        ),
        changeSummary: "让周报输出更容易扫描",
        status: "pending",
        createdAt: now(),
      },
      {
        id: "proposal-conflict",
        skillId: "research",
        teamId: "demo-team",
        authorId: "qianqian",
        baseVersionId: "research-v1",
        revision: 1,
        content: body("# 深度研究助手\n\n先列出三个关键问题，再逐条研究。\n"),
        changeSummary: "调整研究步骤（含冲突演示）",
        status: "pending",
        createdAt: now(),
      },
    ];
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
    previews = new Map<string, MergePreview>();
  const access = (actor: Actor) => {
    if (actor.teamId !== "demo-team")
      throw new DomainError("FORBIDDEN", "演示仅包含演示团队。");
  };
  const find = <T extends { id: string }>(items: T[], itemId: string) => {
    const found = items.find((x) => x.id === itemId);
    if (!found) throw new DomainError("NOT_FOUND", "找不到此记录。");
    return found;
  };
  const edit = (a: Actor) => {
    access(a);
    if (a.role === "viewer")
      throw new DomainError("FORBIDDEN", "需要贡献者权限。");
  };
  const owned = (a: Actor, d: Draft) => {
    edit(a);
    if (d.authorId !== a.userId)
      throw new DomainError("FORBIDDEN", "只能编辑自己的草稿。");
  };
  const revision = (actual: number, expected: number) => {
    if (actual !== expected)
      throw new DomainError("STALE_REVISION", "修订已更新。");
  };
  const review = (a: Actor, p: Proposal) => {
    access(a);
    if (
      p.authorId === a.userId ||
      !find(skills, p.skillId).maintainerIds.includes(a.userId)
    )
      throw new DomainError("FORBIDDEN", "必须由另一位维护者评审。");
    if (p.status !== "pending")
      throw new DomainError("STALE_REVISION", "提案已结束。");
  };
  const validate = (c: SkillContent) => {
    if (
      !c.files.some((f) => f.path === "SKILL.md" && f.content.trim()) ||
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
      edit(a);
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
      validate(input.content);
      d.content = copy(input.content);
      d.revision++;
      d.updatedAt = now();
      return copy(d);
    },
    async submitProposal(a, input) {
      if (receipts.has(input.idempotencyKey))
        return copy(receipts.get(input.idempotencyKey) as Proposal);
      const d = find(drafts, input.draftId);
      owned(a, d);
      revision(d.revision, input.expectedRevision);
      validate(d.content);
      if (
        !input.changeSummary.trim() ||
        (d.baseVersionId &&
          equal(d.content, find(versions, d.baseVersionId).content))
      )
        throw new DomainError(
          "VALIDATION",
          "请填写修改说明，并确保内容有变化。",
        );
      for (const p of proposals)
        if (
          (p as Proposal & { draftId?: string }).draftId === d.id &&
          !["merged", "withdrawn"].includes(p.status)
        )
          p.status = "withdrawn";
      const p: Proposal & { draftId: string } = {
        ...copy(d),
        id: id("proposal"),
        draftId: d.id,
        changeSummary: input.changeSummary,
        status: "pending",
        createdAt: now(),
      };
      proposals.unshift(p);
      receipts.set(input.idempotencyKey, p);
      return copy(p);
    },
    async listProposals(a, s) {
      access(a);
      return copy(proposals.filter((p) => !s || p.skillId === s));
    },
    async getProposal(a, p) {
      access(a);
      return copy(find(proposals, p));
    },
    async reviewProposal(a, input) {
      const p = find(proposals, input.proposalId);
      review(a, p);
      revision(p.revision, input.expectedRevision);
      p.status = input.action === "reject" ? "rejected" : "changes_requested";
      p.reviewComment = input.comment;
      return copy(p);
    },
    async withdrawProposal(a, pid, expected) {
      const p = find(proposals, pid);
      access(a);
      if (p.authorId !== a.userId || p.status === "merged")
        throw new DomainError("FORBIDDEN", "只能撤回自己的未生效修改。");
      revision(p.revision, expected);
      p.status = "withdrawn";
      return copy(p);
    },
    async previewMerge(a, pid) {
      access(a);
      const target = find(proposals, pid);
      if (
        !["pending", "changes_requested", "conflicted"].includes(target.status)
      )
        throw new DomainError("STALE_REVISION", "提案已结束。");
      if (
        target.authorId !== a.userId &&
        !find(skills, target.skillId).maintainerIds.includes(a.userId)
      )
        throw new DomainError("FORBIDDEN", "只有作者或维护者可以预览合并。");
      const p = find(proposals, pid),
        s = find(skills, p.skillId);
      const base = p.baseVersionId
          ? find(versions, p.baseVersionId).content.files
          : [],
        current = s.currentVersionId
          ? find(versions, s.currentVersionId).content.files
          : [];
      const preview: MergePreview = {
        proposalId: pid,
        proposalRevision: p.revision,
        currentVersionId: s.currentVersionId,
        content: { files: [] },
        conflicts: [],
        confirmationToken: id("preview"),
      };
      for (const path of new Set(
        [...base, ...current, ...p.content.files].map((f) => f.path),
      )) {
        const b = base.find((f) => f.path === path),
          c = current.find((f) => f.path === path),
          mine = p.content.files.find((f) => f.path === path);
        if (!equal(b, c) && !equal(b, mine) && !equal(c, mine))
          preview.conflicts.push({
            path,
            base: b?.content,
            current: c?.content,
            proposed: mine?.content,
          });
        const chosen = equal(b, mine) ? c : mine;
        if (chosen) preview.content.files.push(copy(chosen));
      }
      previews.set(preview.confirmationToken, copy(preview));
      return preview;
    },
    async mergeProposal(a, input) {
      if (receipts.has(input.idempotencyKey))
        return copy(receipts.get(input.idempotencyKey) as SkillVersion);
      const p = find(proposals, input.proposalId);
      review(a, p);
      revision(p.revision, input.expectedRevision);
      const s = find(skills, p.skillId),
        preview = previews.get(input.confirmationToken);
      if (
        !preview ||
        preview.proposalId !== p.id ||
        preview.proposalRevision !== p.revision ||
        s.currentVersionId !== input.expectedCurrentVersionId ||
        preview.currentVersionId !== s.currentVersionId
      )
        throw new DomainError("STALE_REVISION", "请重新比较并确认。");
      if (preview.conflicts.length)
        throw new DomainError("CONFLICT", "仍有内容冲突。");
      validate(preview.content);
      const v: SkillVersion = {
        id: id("version"),
        skillId: s.id,
        teamId: a.teamId,
        number: versions.filter((v) => v.skillId === s.id).length + 1,
        parentVersionId: s.currentVersionId,
        content: copy(preview.content),
        checksum: await checksum(preview.content),
        changeSummary: p.changeSummary,
        authorId: p.authorId,
        reviewerId: a.userId,
        createdAt: now(),
      };
      versions.push(v);
      s.currentVersionId = v.id;
      p.status = "merged";
      p.mergedVersionId = v.id;
      receipts.set(input.idempotencyKey, v);
      return copy(v);
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
    async listUpdateEvents(a) {
      access(a);
      return [];
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
  return { library, runtime, actor: demoActor, sessionId: "demo-session" };
}
