import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  DomainError,
  type Actor,
  type LibraryService,
  type Skill,
  type Draft,
  type SkillVersion,
  type SkillContent,
  type DraftUpdatePreview,
  type SkillUpdateEvent,
  type AuditEntry,
} from "../../contracts/index.ts";
import {
  checksum,
  compare,
  digest,
  emptyContent,
  fail,
  nonempty,
  revision,
  threeWay,
  validateContent,
} from "./content.ts";
export { checksum } from "./content.ts";

export interface LibraryOptions {
  databasePath: string;
  /** Trusted host must authenticate before calling the service. This optional synchronous
   * gate can additionally reject revoked membership/roles on every operation. */
  authorizeActor?: (actor: Readonly<Actor>) => boolean;
  isTeamMember?: (teamId: string, userId: string) => boolean;
  canEditScripts?: (actor: Readonly<Actor>, path: string) => boolean;
  /** Extra platform format/policy validation; throw DomainError to reject. Never executes files. */
  validatePackage?: (actor: Readonly<Actor>, content: SkillContent) => void;
  /** Testing/operations fault hook; throwing rolls the entire transaction back. */
  faultInjector?: (
    stage:
      | "after_version"
      | "after_pointer"
      | "after_draft"
      | "after_request"
      | "after_event"
      | "after_audit",
  ) => void;
}
type StoredSkill = Skill & { creatorId: string };
type Entity = { id: string; teamId: string };
const now = () => new Date().toISOString();
const id = () => randomUUID();

/** Synchronous SQLite transactions are deliberately kept free of awaits/host I/O. */
export function createLibraryService(
  options: LibraryOptions,
): LibraryService & { close(): void } {
  nonempty(options.databasePath, "数据库路径", 4096);
  const db = new DatabaseSync(options.databasePath);
  db.exec(
    `PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;`,
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_schema(version INTEGER NOT NULL);
    INSERT INTO service_schema SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM service_schema);
    CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY, team TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, team TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, team TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY, team TEXT NOT NULL, data TEXT NOT NULL,
      skill TEXT GENERATED ALWAYS AS (json_extract(data,'$.skillId')) STORED,
      number INTEGER GENERATED ALWAYS AS (json_extract(data,'$.number')) STORED, UNIQUE(skill,number));
    CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, team TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, team TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests(team TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(team,actor,operation,key));
    CREATE TABLE IF NOT EXISTS previews(token TEXT PRIMARY KEY, team TEXT NOT NULL, actor TEXT NOT NULL, fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS draft_previews(token TEXT PRIMARY KEY, team TEXT NOT NULL, actor TEXT NOT NULL, snapshot TEXT NOT NULL, fingerprint TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS skills_team ON skills(team);
    CREATE INDEX IF NOT EXISTS drafts_team ON drafts(team);
    CREATE INDEX IF NOT EXISTS proposals_team ON proposals(team);
    CREATE INDEX IF NOT EXISTS versions_team ON versions(team);
    CREATE INDEX IF NOT EXISTS events_team_sequence ON events(team,sequence);
    CREATE INDEX IF NOT EXISTS audit_team ON audit(team);
    CREATE TRIGGER IF NOT EXISTS versions_no_update BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;
    CREATE TRIGGER IF NOT EXISTS versions_no_delete BEFORE DELETE ON versions BEGIN SELECT RAISE(ABORT,'immutable version'); END;
    CREATE TRIGGER IF NOT EXISTS proposals_snapshot BEFORE UPDATE ON proposals
      WHEN json_extract(NEW.data,'$.content') != json_extract(OLD.data,'$.content')
        OR json_extract(NEW.data,'$.revision') != json_extract(OLD.data,'$.revision')
        OR json_extract(NEW.data,'$.authorId') != json_extract(OLD.data,'$.authorId')
        OR json_extract(NEW.data,'$.skillId') != json_extract(OLD.data,'$.skillId')
        OR json_extract(NEW.data,'$.changeSummary') != json_extract(OLD.data,'$.changeSummary')
        OR json_extract(NEW.data,'$.baseVersionId') IS NOT json_extract(OLD.data,'$.baseVersionId')
      BEGIN SELECT RAISE(ABORT,'immutable proposal snapshot'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
    CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable event'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'immutable audit'); END;
  `);
  if (
    ![1, 2].includes((
      db.prepare("SELECT version FROM service_schema").get() as {
        version: number;
      }
    ).version)
  ) {
    db.close();
    fail("UNAVAILABLE", "数据库版本不受支持");
  }
  db.exec("UPDATE service_schema SET version=2 WHERE version=1");
  let closed = false;
  type Table = "skills" | "drafts" | "proposals" | "versions" | "audit";
  const all = <T>(table: Table, actor: Actor): T[] =>
    db
      .prepare(`SELECT data FROM ${table} WHERE team=? ORDER BY rowid`)
      .all(actor.teamId)
      .map((r) => JSON.parse(r.data as string));
  const get = <T>(table: Table, actor: Actor, key: string): T => {
    nonempty(key, "对象ID");
    const row = db
      .prepare(`SELECT data FROM ${table} WHERE id=? AND team=?`)
      .get(key, actor.teamId);
    if (!row) fail("NOT_FOUND", "内容不存在或不可访问");
    return JSON.parse(row!.data as string);
  };
  const insert = <T extends Entity>(table: Table, value: T) =>
    db
      .prepare(`INSERT INTO ${table}(id,team,data) VALUES(?,?,?)`)
      .run(value.id, value.teamId, JSON.stringify(value));
  const update = <T extends Entity>(table: Table, value: T) =>
    db
      .prepare(`UPDATE ${table} SET data=? WHERE id=? AND team=?`)
      .run(JSON.stringify(value), value.id, value.teamId);
  const actorCheck = (actor: Actor) => {
    if (!actor || !["viewer", "contributor", "admin"].includes(actor.role))
      fail("FORBIDDEN", "身份无效或权限已撤销");
    nonempty(actor.userId, "用户ID");
    nonempty(actor.teamId, "团队ID");
    if (options.authorizeActor && !options.authorizeActor({ ...actor }))
      fail("FORBIDDEN", "身份无效或权限已撤销");
    if (
      options.isTeamMember &&
      !options.isTeamMember(actor.teamId, actor.userId)
    )
      fail("FORBIDDEN", "您已不是此团队成员");
  };
  const transaction = async <T>(
    actor: Actor,
    write: boolean,
    body: () => T,
  ): Promise<T> => {
    if (closed) fail("UNAVAILABLE", "服务已关闭");
    actorCheck(actor);
    let begun = false;
    try {
      db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
      begun = true;
      const value = body();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      if (begun) db.exec("ROLLBACK");
      if (error instanceof DomainError) throw error;
      throw new DomainError("UNAVAILABLE", "暂时无法完成操作，请重试", {
        cause: error instanceof Error ? error.name : "unknown",
      });
    }
  };
  const edit = (actor: Actor, skill?: StoredSkill) => {
    if (actor.role === "viewer" && !skill?.maintainerIds.includes(actor.userId))
      fail("FORBIDDEN", "您没有修改权限");
  };
  const skillGet = (actor: Actor, key: string): StoredSkill => {
    const s = get<StoredSkill>("skills", actor, key);
    if (
      !s.currentVersionId &&
      s.creatorId !== actor.userId &&
      !s.maintainerIds.includes(actor.userId) &&
      actor.role !== "admin"
    )
      fail("NOT_FOUND", "技能尚未生效");
    return s;
  };
  const publicSkill = ({ creatorId: _, ...s }: StoredSkill): Skill => s;
  const ownDraft = (actor: Actor, key: string) => {
    const d = get<Draft>("drafts", actor, key);
    const s = skillGet(actor, d.skillId);
    edit(actor, s);
    if (d.authorId !== actor.userId) fail("FORBIDDEN", "只能访问自己的草稿");
    return d;
  };
  const versionGet = (actor: Actor, key: string) => {
    const v = get<SkillVersion>("versions", actor, key);
    skillGet(actor, v.skillId);
    if (checksum(v.content) !== v.checksum)
      fail("RESOURCE_MISSING", "历史版本资源校验失败");
    return v;
  };
  const checkRevision = (actual: number, expected: number) => {
    revision(expected);
    if (actual !== expected)
      fail("STALE_REVISION", "内容已更新，请重新加载后确认", {
        currentRevision: actual,
      });
  };
  const maintainers = (actor: Actor, users: string[]) => {
    if (!Array.isArray(users) || users.length > 100)
      fail("VALIDATION", "维护者清单无效");
    for (const user of users) {
      nonempty(user, "维护者ID");
      if (options.isTeamMember && !options.isTeamMember(actor.teamId, user))
        fail("VALIDATION", "维护者必须是有效团队成员");
    }
    return [...new Set(users)];
  };
  const contentCheck = (
    actor: Actor,
    content: SkillContent,
    before = emptyContent(),
    complete = false,
  ) => {
    const normalized = validateContent(content, complete);
    for (const change of compare(before, normalized)) {
      const file =
        normalized.files.find((f) => f.path === change.path) ??
        before.files.find((f) => f.path === change.path);
      if (
        /\.(?:js|mjs|cjs|ts|py|sh|bash|ps1|rb|pl)$/i.test(change.path) ||
        /javascript|python|shellscript/.test(file?.mediaType ?? "")
      ) {
        if (!options.canEditScripts?.(actor, change.path))
          fail("FORBIDDEN", "脚本修改需要平台授权", { path: change.path });
      }
    }
    if (complete) options.validatePackage?.(actor, structuredClone(normalized));
    return normalized;
  };
  const audit = (
    actor: Actor,
    action: string,
    objectId: string,
    metadata: Record<string, unknown> = {},
  ) =>
    insert<AuditEntry>("audit", {
      id: id(),
      teamId: actor.teamId,
      actorId: actor.userId,
      action,
      objectId,
      createdAt: now(),
      metadata,
    });
  const replay = <T>(
    actor: Actor,
    operation: string,
    input: { idempotencyKey: string },
    produce: () => T,
  ): T => {
    nonempty(input.idempotencyKey, "请求标识", 256);
    const fingerprint = digest(input);
    const row = db
      .prepare(
        "SELECT fingerprint,result FROM requests WHERE team=? AND actor=? AND operation=? AND key=?",
      )
      .get(actor.teamId, actor.userId, operation, input.idempotencyKey);
    if (row) {
      if (row.fingerprint !== fingerprint)
        fail("CONFLICT", "此请求标识已用于不同内容");
      return JSON.parse(row.result as string);
    }
    const result = produce();
    db.prepare("INSERT INTO requests VALUES(?,?,?,?,?,?)").run(
      actor.teamId,
      actor.userId,
      operation,
      input.idempotencyKey,
      fingerprint,
      JSON.stringify(result),
    );
    options.faultInjector?.("after_request");
    return result;
  };
  const visible = (actor: Actor, s: StoredSkill) =>
    s.currentVersionId ||
    s.creatorId === actor.userId ||
    s.maintainerIds.includes(actor.userId) ||
    actor.role === "admin";
  const objectInput = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      fail("VALIDATION", "请求参数无效");
  };
  const service: LibraryService & { close(): void } = {
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
    listSkills: (actor, query) =>
      transaction(actor, false, () => {
        if (query !== undefined && typeof query !== "string")
          fail("VALIDATION", "搜索条件无效");
        return all<StoredSkill>("skills", actor)
          .filter(
            (s) =>
              visible(actor, s) &&
              (!query ||
                s.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
          )
          .map(publicSkill);
      }),
    getSkill: (actor, key) =>
      transaction(actor, false, () => publicSkill(skillGet(actor, key))),
    createSkill: (actor, input) =>
      transaction(actor, true, () => {
        objectInput(input);
        edit(actor);
        nonempty(input?.name, "名称", 200);
        if (
          typeof input.description !== "string" ||
          input.description.length > 4000
        )
          fail("VALIDATION", "描述无效");
        const content = contentCheck(actor, input.content);
        const createdAt = now();
        const s: StoredSkill = {
          id: id(),
          teamId: actor.teamId,
          name: input.name.trim(),
          description: input.description,
          maintainerIds: maintainers(actor, input.maintainerIds),
          currentVersionId: null,
          createdAt,
          creatorId: actor.userId,
        };
        const d: Draft = {
          id: id(),
          skillId: s.id,
          teamId: actor.teamId,
          authorId: actor.userId,
          baseVersionId: null,
          revision: 1,
          content,
          updatedAt: createdAt,
        };
        insert("skills", s);
        insert("drafts", d);
        audit(actor, "skill.create", s.id, { draftId: d.id });
        return { skill: publicSkill(s), draft: d };
      }),
    setMaintainers: (actor, key, users) =>
      transaction(actor, true, () => {
        if (actor.role !== "admin")
          fail("FORBIDDEN", "只有团队管理员可以配置维护者");
        const s = skillGet(actor, key);
        const previous = s.maintainerIds;
        s.maintainerIds = maintainers(actor, users);
        update("skills", s);
        audit(actor, "skill.maintainers", s.id, {
          previous,
          current: s.maintainerIds,
        });
        return publicSkill(s);
      }),
    listVersions: (actor, key) =>
      transaction(actor, false, () => {
        skillGet(actor, key);
        return all<SkillVersion>("versions", actor)
          .filter((v) => v.skillId === key)
          .sort((a, b) => b.number - a.number)
          .map((v) => versionGet(actor, v.id));
      }),
    getVersion: (actor, key) =>
      transaction(actor, false, () => versionGet(actor, key)),
    compareVersions: (actor, before, after) =>
      transaction(actor, false, () => {
        const a = versionGet(actor, before),
          b = versionGet(actor, after);
        if (a.skillId !== b.skillId)
          fail("VALIDATION", "只能比较同一技能的版本");
        return compare(a.content, b.content);
      }),
    createDraft: (actor, key, source) =>
      transaction(actor, true, () => {
        const s = skillGet(actor, key);
        edit(actor, s);
        let content: SkillContent;
        if (source) {
          const v = versionGet(actor, source);
          if (v.skillId !== s.id) fail("VALIDATION", "历史版本不属于此技能");
          content = v.content;
        } else if (s.currentVersionId)
          content = versionGet(actor, s.currentVersionId).content;
        else {
          if (
            s.creatorId !== actor.userId &&
            !s.maintainerIds.includes(actor.userId)
          )
            fail("FORBIDDEN", "只有创建者或维护者可以访问首次草稿");
          const initial = all<Draft>("drafts", actor).find(
            (d) => d.skillId === key && d.authorId === s.creatorId,
          );
          if (!initial) fail("NOT_FOUND", "首次草稿不存在");
          content = initial!.content;
        }
        const d: Draft = {
          id: id(),
          skillId: key,
          teamId: actor.teamId,
          authorId: actor.userId,
          baseVersionId: s.currentVersionId,
          revision: 1,
          content,
          updatedAt: now(),
        };
        insert("drafts", d);
        audit(actor, source ? "draft.restore" : "draft.create", d.id, {
          skillId: key,
          sourceVersionId: source ?? null,
          baseVersionId: s.currentVersionId,
        });
        return d;
      }),
    getDraft: (actor, key) =>
      transaction(actor, false, () => ownDraft(actor, key)),
    saveDraft: (actor, input) =>
      transaction(actor, true, () => {
        objectInput(input);
        const d = ownDraft(actor, input.draftId);
        checkRevision(d.revision, input.expectedRevision);
        d.content = contentCheck(actor, input.content, d.content);
        d.revision++;
        d.updatedAt = now();
        update("drafts", d);
        audit(actor, "draft.save", d.id, { revision: d.revision });
        return d;
      }),
    publishDraft: (actor, input) =>
      transaction(actor, true, () => {
        objectInput(input);
        const d = ownDraft(actor, input.draftId);
        return replay(actor, "publish", input, () => {
          checkRevision(d.revision, input.expectedRevision);
          const s = skillGet(actor, d.skillId);
          if (d.baseVersionId !== input.expectedBaseVersionId || d.baseVersionId !== s.currentVersionId)
            fail("STALE_REVISION", "有新版本待处理，请查看更新并确认同步");
          nonempty(input.changeSummary, "修改说明", 2000);
          const current = s.currentVersionId ? versionGet(actor, s.currentVersionId) : null;
          const content = contentCheck(actor, d.content, current?.content, true);
          const v: SkillVersion = {
            id: id(), skillId: s.id, teamId: actor.teamId,
            number: (current?.number ?? 0) + 1, parentVersionId: s.currentVersionId,
            content, checksum: checksum(content), changeSummary: input.changeSummary.trim(),
            authorId: actor.userId, reviewerId: null, approvalMode: "automatic", createdAt: now(),
          };
          insert("versions", v);
          options.faultInjector?.("after_version");
          const previousVersionId = s.currentVersionId;
          s.currentVersionId = v.id;
          update("skills", s);
          options.faultInjector?.("after_pointer");
          d.baseVersionId = v.id;
          d.content = content;
          d.revision++;
          d.updatedAt = now();
          update("drafts", d);
          options.faultInjector?.("after_draft");
          const event = { id: id(), teamId: actor.teamId, skillId: s.id,
            previousVersionId, versionId: v.id, createdAt: now() };
          db.prepare("INSERT INTO events(id,team,data) VALUES(?,?,?)").run(event.id, actor.teamId, JSON.stringify(event));
          options.faultInjector?.("after_event");
          audit(actor, "draft.publish", d.id, { previousVersionId, versionId: v.id,
            revision: input.expectedRevision, checksum: v.checksum, idempotencyKey: input.idempotencyKey });
          options.faultInjector?.("after_audit");
          return v;
        });
      }),
    previewDraftUpdate: (actor, input) =>
      transaction(actor, true, () => {
        objectInput(input);
        const d = ownDraft(actor, input.draftId);
        checkRevision(d.revision, input.expectedRevision);
        const s = skillGet(actor, d.skillId);
        const localContent = contentCheck(actor, input.content, d.content);
        const baseContent = d.baseVersionId ? versionGet(actor, d.baseVersionId).content : emptyContent();
        const latestContent = s.currentVersionId ? versionGet(actor, s.currentVersionId).content : emptyContent();
        const merged = threeWay(baseContent, latestContent, localContent);
        const result: DraftUpdatePreview = {
          draftId: d.id, draftRevision: d.revision, baseVersionId: d.baseVersionId,
          targetVersionId: s.currentVersionId, baseContent, localContent, latestContent,
          candidateContent: merged.content, conflicts: merged.conflicts,
          localDiff: compare(baseContent, localContent), remoteDiff: compare(baseContent, latestContent),
          confirmationToken: id(),
        };
        const snapshot = JSON.stringify(result);
        db.prepare("INSERT INTO draft_previews VALUES(?,?,?,?,?)").run(result.confirmationToken,
          actor.teamId, actor.userId, snapshot, digest(result));
        return result;
      }),
    applyDraftUpdate: (actor, input) =>
      transaction(actor, true, () => {
        objectInput(input);
        const d = ownDraft(actor, input.draftId);
        return replay(actor, "apply_update", input, () => {
          checkRevision(d.revision, input.expectedRevision);
          const s = skillGet(actor, d.skillId);
          if (s.currentVersionId !== input.targetVersionId)
            fail("STALE_REVISION", "已有新版本，请重新查看更新");
          nonempty(input.confirmationToken, "更新确认标识");
          const row = db.prepare("SELECT snapshot,fingerprint FROM draft_previews WHERE token=? AND team=? AND actor=?")
            .get(input.confirmationToken, actor.teamId, actor.userId);
          if (!row) fail("STALE_REVISION", "更新预览无效，请重新查看更新");
          const preview = JSON.parse(row!.snapshot as string) as DraftUpdatePreview;
          if (digest(preview) !== row!.fingerprint || preview.draftId !== d.id ||
              preview.draftRevision !== d.revision || preview.baseVersionId !== d.baseVersionId ||
              preview.targetVersionId !== input.targetVersionId)
            fail("STALE_REVISION", "更新预览已失效，请重新查看更新");
          d.content = contentCheck(actor, input.resolvedContent, d.content);
          d.baseVersionId = input.targetVersionId;
          d.revision++;
          d.updatedAt = now();
          update("drafts", d);
          options.faultInjector?.("after_draft");
          audit(actor, "draft.update", d.id, { revision: d.revision, baseVersionId: d.baseVersionId });
          options.faultInjector?.("after_audit");
          return d;
        });
      }),
    catalogSnapshot: (actor) =>
      transaction(actor, false, () => ({
        teamId: actor.teamId,
        versions: Object.fromEntries(
          all<StoredSkill>("skills", actor)
            .filter((s) => s.currentVersionId)
            .map((s) => [s.id, s.currentVersionId!]),
        ),
        capturedAt: now(),
      })),
    listUpdateEvents: (actor, after) =>
      transaction(actor, false, () => {
        if (!Number.isSafeInteger(after) || after < 0)
          fail("VALIDATION", "事件游标无效");
        return db
          .prepare(
            "SELECT sequence,data FROM events WHERE team=? AND sequence>? ORDER BY sequence",
          )
          .all(actor.teamId, after)
          .map(
            (r) =>
              ({
                ...JSON.parse(r.data as string),
                sequence: Number(r.sequence),
              }) as SkillUpdateEvent,
          );
      }),
    listAudit: (actor) =>
      transaction(actor, false, () => {
        if (actor.role !== "admin")
          fail("FORBIDDEN", "只有团队管理员可以查看审计记录");
        return all<AuditEntry>("audit", actor);
      }),
  };
  return service;
}
