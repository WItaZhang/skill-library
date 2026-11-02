import type { Pool } from "pg";
import type { ProductionLibraryService, ProductionSkill } from "../../contracts/production.ts";
import { createStore } from "./store.ts";
export { migrate } from "./migrate.ts";
import { randomUUID } from "node:crypto";
import { DomainError, type Actor, type LibraryService, type Skill, type Draft, type SkillVersion, type SkillContent, type DraftUpdatePreview, type SkillUpdateEvent, type AuditEntry, } from "../../contracts/index.ts";
import { checksum, compare, canonicalDigest as digest, digest as legacyDigest, emptyContent, fail, nonempty, revision, threeWay, validateContent, } from "./content.ts";
export { checksum } from "./content.ts";
export interface LibraryOptions {
    pool: Pool;
    canEditScripts?: (actor: Readonly<Actor>, path: string) => boolean;
    /** Extra platform format/policy validation; throw DomainError to reject. Never executes files. */
    validatePackage?: (actor: Readonly<Actor>, content: SkillContent) => void;
    /** Testing/operations fault hook; throwing rolls the entire transaction back. */
    faultInjector?: (stage: "after_version" | "after_pointer" | "after_draft" | "after_request" | "after_event" | "after_audit") => void;
}
type StoredSkill = ProductionSkill & {
    creatorId: string;
};
type Entity = {
    id: string;
    teamId: string;
};
const now = () => new Date().toISOString();
const id = () => randomUUID();
/** The host owns the shared pool and authenticates user/session; roles are reloaded here. */
export function createPostgresLibraryService(options: LibraryOptions): ProductionLibraryService {
    const { query, transaction, all, get, insert, update } = createStore(options.pool);
    const edit = (actor: Actor, skill?: StoredSkill) => {
        if (skill?.archivedAt)
            fail("CONFLICT", "技能已归档，请先恢复");
        if (actor.role === "viewer" && !skill?.maintainerIds.includes(actor.userId))
            fail("FORBIDDEN", "您没有修改权限");
    };
    const skillGet = async (actor: Actor, key: string): Promise<StoredSkill> => {
        const s = await get<StoredSkill>("skills", actor, key);
        if (!s.currentVersionId &&
            s.creatorId !== actor.userId &&
            !s.maintainerIds.includes(actor.userId) &&
            actor.role !== "admin")
            fail("NOT_FOUND", "技能尚未生效");
        return s;
    };
    const publicSkill = ({ creatorId: _, ...s }: StoredSkill): ProductionSkill => s;
    const ownDraft = async (actor: Actor, key: string, writing = true) => {
        const d = await get<Draft>("drafts", actor, key);
        const s = await skillGet(actor, d.skillId);
        edit(actor, writing ? s : {...s,archivedAt:null});
        if (d.authorId !== actor.userId)
            fail("FORBIDDEN", "只能访问自己的草稿");
        return d;
    };
    const versionGet = async (actor: Actor, key: string) => {
        const v = await get<SkillVersion>("versions", actor, key);
        await skillGet(actor, v.skillId);
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
    const maintainers = async (actor: Actor, users: string[]) => {
        if (!Array.isArray(users) || users.length > 100)
            fail("VALIDATION", "维护者清单无效");
        for (const user of users) {
            nonempty(user, "维护者ID");
            if (!(await query("SELECT 1 FROM team_memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.user_id=$2 AND m.status='active' AND u.status='active'", [actor.teamId, user])).rowCount)
                fail("VALIDATION", "维护者必须是有效团队成员");
        }
        return [...new Set(users)];
    };
    const contentCheck = (actor: Actor, content: SkillContent, before = emptyContent(), complete = false) => {
        const normalized = validateContent(content, complete);
        for (const change of compare(before, normalized)) {
            const file = normalized.files.find((f) => f.path === change.path) ??
                before.files.find((f) => f.path === change.path);
            if (/\.(?:js|mjs|cjs|ts|py|sh|bash|ps1|rb|pl)$/i.test(change.path) ||
                /javascript|python|shellscript/.test(file?.mediaType ?? "")) {
                if (!options.canEditScripts?.(actor, change.path))
                    fail("FORBIDDEN", "脚本修改需要平台授权", { path: change.path });
            }
        }
        if (complete)
            options.validatePackage?.(actor, structuredClone(normalized));
        return normalized;
    };
    const audit = async (actor: Actor, action: string, objectId: string, metadata: Record<string, unknown> = {}) => await insert<AuditEntry>("audit", {
        id: id(),
        teamId: actor.teamId,
        actorId: actor.userId,
        action,
        objectId,
        createdAt: now(),
        metadata,
    });
    const replay = async <T>(actor: Actor, operation: string, input: {
        idempotencyKey: string;
    }, produce: () => Promise<T>): Promise<T> => {
        nonempty(input.idempotencyKey, "请求标识", 256);
        const fingerprint = digest(input);
        const row = (await query('SELECT fingerprint,result FROM requests WHERE team_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4', [actor.teamId, actor.userId, operation, input.idempotencyKey])).rows[0];
        if (row) {
            if (row.fingerprint !== fingerprint && row.fingerprint !== legacyDigest(input))
                fail("CONFLICT", "此请求标识已用于不同内容");
            return row.result;
        }
        const result = await produce();
        await query('INSERT INTO requests(id,team_id,actor_id,operation,key,fingerprint,result) VALUES($1,$2,$3,$4,$5,$6,$7)', [id(), actor.teamId, actor.userId, operation, input.idempotencyKey, fingerprint, JSON.stringify(result)]);
        options.faultInjector?.("after_request");
        return result;
    };
    const visible = (actor: Actor, s: StoredSkill) => s.currentVersionId ||
        s.creatorId === actor.userId ||
        s.maintainerIds.includes(actor.userId) ||
        actor.role === "admin";
    const objectInput = (input: unknown) => {
        if (!input || typeof input !== "object" || Array.isArray(input))
            fail("VALIDATION", "请求参数无效");
    };
    const manage = (actor:Actor, input:{skillId:string;expectedRevision:number}, action:'update'|'archive'|'restore', metadata?:{name:string;description:string}) => transaction(actor,true,async actor=>{
      objectInput(input);
      const s=await skillGet(actor,input.skillId);
      // Restoring must be possible while archived; use original editor permission rule.
      if(actor.role==='viewer'&&!s.maintainerIds.includes(actor.userId)) fail('FORBIDDEN','您没有修改权限');
      checkRevision(s.revision,input.expectedRevision);
      if(action==='update'){
        nonempty(metadata?.name,'名称',200);
        if(typeof metadata?.description!=='string'||metadata.description.length>4000) fail('VALIDATION','描述无效');
        s.name=metadata!.name.trim();s.description=metadata!.description;
      } else s.archivedAt=action==='archive'?now():null;
      s.revision++;
      await update('skills',s);await audit(actor,'skill.'+action,s.id,{revision:s.revision});return publicSkill(s);
    });
    const service: ProductionLibraryService = {
        listDrafts:(actor,skillId)=>transaction(actor,false,async actor=>{
          const s=await skillGet(actor,skillId);
          if(actor.role==='viewer'&&!s.maintainerIds.includes(actor.userId))fail('FORBIDDEN','您没有修改权限');
          return (await all<Draft>('drafts',actor)).filter(d=>d.skillId===skillId&&d.authorId===actor.userId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.id.localeCompare(a.id));
        }),
        updateSkill:(actor,input)=>manage(actor,input,'update',input),
        archiveSkill:(actor,input)=>manage(actor,input,'archive'),
        restoreSkill:(actor,input)=>manage(actor,input,'restore'),
        listManagedSkills:(actor,options={})=>transaction(actor,false,async actor=>{
          objectInput(options);
          if(options.query!==undefined&&typeof options.query!=='string') fail('VALIDATION','搜索条件无效');
          if(options.includeArchived!==undefined&&typeof options.includeArchived!=='boolean') fail('VALIDATION','归档条件无效');
          return (await all<StoredSkill>('skills',actor)).filter(s=>visible(actor,s)&&(options.includeArchived||!s.archivedAt)&&(!options.query||s.name.toLocaleLowerCase().includes(options.query.toLocaleLowerCase()))).map(publicSkill);
        }),
        listSkills: (actor, query) => transaction(actor, false, async (actor) => {
            if (query !== undefined && typeof query !== "string")
                fail("VALIDATION", "搜索条件无效");
            return (await all<StoredSkill>("skills", actor)).filter((s) => !s.archivedAt && visible(actor, s) &&
                (!query ||
                    s.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
                .map(publicSkill);
        }),
        getSkill: (actor, key) => transaction(actor, false, async (actor) => publicSkill(await skillGet(actor, key))),
        createSkill: (actor, input) => transaction(actor, true, async (actor) => {
            objectInput(input);
            edit(actor);
            nonempty(input?.name, "名称", 200);
            if (typeof input.description !== "string" ||
                input.description.length > 4000)
                fail("VALIDATION", "描述无效");
            const content = contentCheck(actor, input.content);
            const createdAt = now();
            const s: StoredSkill = {
                id: id(),
                teamId: actor.teamId,
                name: input.name.trim(),
                description: input.description,
                maintainerIds: await maintainers(actor, input.maintainerIds),
                currentVersionId: null,
                createdAt,
                creatorId: actor.userId,
                revision: 1, archivedAt: null,
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
            await insert("skills", s);
            await insert("drafts", d);
            await audit(actor, "skill.create", s.id, { draftId: d.id });
            return { skill: publicSkill(s), draft: d };
        }),
        setMaintainers: (actor, key, users) => transaction(actor, true, async (actor) => {
            if (actor.role !== "admin")
                fail("FORBIDDEN", "只有团队管理员可以配置维护者");
            const s = await skillGet(actor, key);
            const previous = s.maintainerIds;
            s.maintainerIds = await maintainers(actor, users);
            s.revision++;
            await update("skills", s);
            await audit(actor, "skill.maintainers", s.id, {
                previous,
                current: s.maintainerIds,
            });
            return publicSkill(s);
        }),
        listVersions: (actor, key) => transaction(actor, false, async (actor) => {
            await skillGet(actor, key);
            const versions=(await all<SkillVersion>("versions",actor)).filter(v=>v.skillId===key).sort((a,b)=>b.number-a.number);
            const result:SkillVersion[]=[];
            for(const v of versions)result.push(await versionGet(actor,v.id));
            return result;
        }),
        getVersion: (actor, key) => transaction(actor, false, async (actor) => await versionGet(actor, key)),
        compareVersions: (actor, before, after) => transaction(actor, false, async (actor) => {
            const a = await versionGet(actor, before), b = await versionGet(actor, after);
            if (a.skillId !== b.skillId)
                fail("VALIDATION", "只能比较同一技能的版本");
            return compare(a.content, b.content);
        }),
        createDraft: (actor, key, source) => transaction(actor, true, async (actor) => {
            const s = await skillGet(actor, key);
            edit(actor, s);
            let content: SkillContent;
            if (source) {
                const v = await versionGet(actor, source);
                if (v.skillId !== s.id)
                    fail("VALIDATION", "历史版本不属于此技能");
                content = v.content;
            }
            else if (s.currentVersionId)
                content = (await versionGet(actor, s.currentVersionId)).content;
            else {
                if (s.creatorId !== actor.userId &&
                    !s.maintainerIds.includes(actor.userId))
                    fail("FORBIDDEN", "只有创建者或维护者可以访问首次草稿");
                const initial = (await all<Draft>("drafts", actor)).find((d) => d.skillId === key && d.authorId === s.creatorId);
                if (!initial)
                    fail("NOT_FOUND", "首次草稿不存在");
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
            await insert("drafts", d);
            await audit(actor, source ? "draft.restore" : "draft.create", d.id, {
                skillId: key,
                sourceVersionId: source ?? null,
                baseVersionId: s.currentVersionId,
            });
            return d;
        }),
        getDraft: (actor, key) => transaction(actor, false, async (actor) => await ownDraft(actor, key, false)),
        saveDraft: (actor, input) => transaction(actor, true, async (actor) => {
            objectInput(input);
            const d = await ownDraft(actor, input.draftId);
            checkRevision(d.revision, input.expectedRevision);
            d.content = contentCheck(actor, input.content, d.content);
            d.revision++;
            d.updatedAt = now();
            await update("drafts", d);
            await audit(actor, "draft.save", d.id, { revision: d.revision });
            return d;
        }),
        publishDraft: (actor, input) => transaction(actor, true, async (actor) => {
            objectInput(input);
            const d = await ownDraft(actor, input.draftId);
            return replay(actor, "publish", input, async () => {
                checkRevision(d.revision, input.expectedRevision);
                const s = await skillGet(actor, d.skillId);
                if (d.baseVersionId !== input.expectedBaseVersionId || d.baseVersionId !== s.currentVersionId)
                    fail("STALE_REVISION", "有新版本待处理，请查看更新并确认同步");
                nonempty(input.changeSummary, "修改说明", 2000);
                const current = s.currentVersionId ? await versionGet(actor, s.currentVersionId) : null;
                const content = contentCheck(actor, d.content, current?.content, true);
                if (current && checksum(content) === current.checksum)
                    fail("VALIDATION", "没有修改内容，无法提交");
                const v: SkillVersion = {
                    id: id(), skillId: s.id, teamId: actor.teamId,
                    number: (current?.number ?? 0) + 1, parentVersionId: s.currentVersionId,
                    content, checksum: checksum(content), changeSummary: input.changeSummary.trim(),
                    authorId: actor.userId, reviewerId: null, approvalMode: "automatic", createdAt: now(),
                };
                await insert("versions", v);
                options.faultInjector?.("after_version");
                const previousVersionId = s.currentVersionId;
                s.currentVersionId = v.id;
                s.revision++;
                await update("skills", s);
                options.faultInjector?.("after_pointer");
                d.baseVersionId = v.id;
                d.content = content;
                d.revision++;
                d.updatedAt = now();
                await update("drafts", d);
                options.faultInjector?.("after_draft");
                const event = { id: id(), teamId: actor.teamId, skillId: s.id,
                    previousVersionId, versionId: v.id, createdAt: now() };
                await query("INSERT INTO events(id,team_id,data,created_at) VALUES($1,$2,$3,$4)", [event.id, actor.teamId, JSON.stringify(event), event.createdAt]);
                options.faultInjector?.("after_event");
                await audit(actor, "draft.publish", d.id, { previousVersionId, versionId: v.id,
                    revision: input.expectedRevision, checksum: v.checksum, idempotencyKey: input.idempotencyKey });
                options.faultInjector?.("after_audit");
                return v;
            });
        }),
        previewDraftUpdate: (actor, input) => transaction(actor, true, async (actor) => {
            objectInput(input);
            const d = await ownDraft(actor, input.draftId);
            checkRevision(d.revision, input.expectedRevision);
            const s = await skillGet(actor, d.skillId);
            const localContent = contentCheck(actor, input.content, d.content);
            const baseContent = d.baseVersionId ? (await versionGet(actor, d.baseVersionId)).content : emptyContent();
            const latestContent = s.currentVersionId ? (await versionGet(actor, s.currentVersionId)).content : emptyContent();
            const merged = threeWay(baseContent, latestContent, localContent);
            const result: DraftUpdatePreview = {
                draftId: d.id, draftRevision: d.revision, baseVersionId: d.baseVersionId,
                targetVersionId: s.currentVersionId, baseContent, localContent, latestContent,
                candidateContent: merged.content, conflicts: merged.conflicts,
                localDiff: compare(baseContent, localContent), remoteDiff: compare(baseContent, latestContent),
                confirmationToken: id(),
            };
            const snapshot = JSON.stringify(result);
            await query("INSERT INTO draft_previews(token,team_id,actor_id,snapshot,fingerprint) VALUES($1,$2,$3,$4,$5)", [result.confirmationToken, actor.teamId, actor.userId, snapshot, digest(result)]);
            return result;
        }),
        applyDraftUpdate: (actor, input) => transaction(actor, true, async (actor) => {
            objectInput(input);
            const d = await ownDraft(actor, input.draftId);
            return replay(actor, "apply_update", input, async () => {
                checkRevision(d.revision, input.expectedRevision);
                const s = await skillGet(actor, d.skillId);
                if (s.currentVersionId !== input.targetVersionId)
                    fail("STALE_REVISION", "已有新版本，请重新查看更新");
                nonempty(input.confirmationToken, "更新确认标识");
                const row = (await query("SELECT snapshot,fingerprint FROM draft_previews WHERE token=$1 AND team_id=$2 AND actor_id=$3", [input.confirmationToken, actor.teamId, actor.userId])).rows[0];
                if (!row)
                    fail("STALE_REVISION", "更新预览无效，请重新查看更新");
                const preview = row!.snapshot as DraftUpdatePreview;
                if (digest(preview) !== row!.fingerprint || preview.draftId !== d.id ||
                    preview.draftRevision !== d.revision || preview.baseVersionId !== d.baseVersionId ||
                    preview.targetVersionId !== input.targetVersionId)
                    fail("STALE_REVISION", "更新预览已失效，请重新查看更新");
                d.content = contentCheck(actor, input.resolvedContent, d.content);
                d.baseVersionId = input.targetVersionId;
                d.revision++;
                d.updatedAt = now();
                await update("drafts", d);
                options.faultInjector?.("after_draft");
                await audit(actor, "draft.update", d.id, { revision: d.revision, baseVersionId: d.baseVersionId });
                options.faultInjector?.("after_audit");
                return d;
            });
        }),
        catalogSnapshot: (actor) => transaction(actor, false, async (actor) => ({
            teamId: actor.teamId,
            versions: Object.fromEntries((await all<StoredSkill>("skills", actor)).filter((s) => s.currentVersionId && !s.archivedAt)
                .map((s) => [s.id, s.currentVersionId!])),
            capturedAt: now(),
        })),
        listUpdateEvents: (actor, after) => transaction(actor, false, async (actor) => {
            if (!Number.isSafeInteger(after) || after < 0)
                fail("VALIDATION", "事件游标无效");
            return (await query("SELECT sequence,data FROM events WHERE team_id=$1 AND sequence>$2 ORDER BY sequence", [actor.teamId, after])).rows.map(r => ({ ...r.data, sequence: Number(r.sequence) }) as SkillUpdateEvent);
        }),
        listAudit: (actor) => transaction(actor, false, async (actor) => {
            if (actor.role !== "admin")
                fail("FORBIDDEN", "只有团队管理员可以查看审计记录");
            return await all<AuditEntry>("audit", actor);
        }),
    };
    return service;
}
export {createPostgresRuntimeService, provisionalDefaults} from './runtime.ts';
export {importSqlite, type SqliteImportOptions} from './import-sqlite.ts';
