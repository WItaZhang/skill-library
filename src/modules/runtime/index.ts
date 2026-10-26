import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../../contracts/index.ts';
import type { Actor, RuntimeHost, RuntimeService, TaskSnapshot, SkillVersion, SessionPreference, PreferenceInput, Invocation, SessionUpdate, CatalogSnapshot } from '../../contracts/index.ts';

export interface RuntimeOptions { databasePath: string; host: RuntimeHost }
export const provisionalDefaults = Object.freeze({ D1: 'future-tasks-only', D2: 'session-skill-until-unpinned', D3: 'latest-unless-explicitly-pinned' });
const fail = (code: ConstructorParameters<typeof DomainError>[0], message: string): never => { throw new DomainError(code, message); };
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) fail('VALIDATION', '标识无效。');
}
function actorValid(actor: Actor) {
  if (!actor || !['viewer', 'contributor', 'admin'].includes(actor.role)) fail('FORBIDDEN', '身份无效。');
  id(actor.userId); id(actor.teamId);
}
export function contentChecksum(content: SkillVersion['content']): string {
  return createHash('sha256').update(JSON.stringify([...content.files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(({path,content,mediaType}) => ({path,content,mediaType})))).digest('hex');
}
function validateVersion(v: SkillVersion, actor: Actor, skillId: string, versionId: string) {
  if (!v || v.id !== versionId || v.skillId !== skillId || v.teamId !== actor.teamId) fail('FORBIDDEN', '技能版本不属于当前授权范围。');
  if (!v.content || !Array.isArray(v.content.files)) fail('RESOURCE_MISSING', '技能资源缺失，请重试。');
  const seen = new Set<string>();
  for (const file of v.content.files) {
    if (!file || typeof file.path !== 'string' || !file.path || /[\\\x00-\x1f:#?%]/.test(file.path) || file.path.startsWith('/') || file.path.split('/').some(x => !x || x === '.' || x === '..') || seen.has(file.path) || typeof file.content !== 'string' || typeof file.mediaType !== 'string' || !file.mediaType.trim()) fail('RESOURCE_MISSING', '技能资源路径或内容无效，请修复资源后重试。');
    seen.add(file.path);
  }
  if (!seen.has('SKILL.md') || !/^[a-f0-9]{64}$/.test(v.checksum) || contentChecksum(v.content) !== v.checksum) fail('RESOURCE_MISSING', '技能资源缺失或校验失败，请重试。');
}

/** Wave-one adapter: host catalog read and local SQLite commit are separate boundaries. */
export function createRuntimeService({databasePath, host}: RuntimeOptions): RuntimeService & { close(): void } {
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, team TEXT NOT NULL, owner TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES sessions(id), snapshot TEXT NOT NULL, checksums TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS preferences(session TEXT NOT NULL REFERENCES sessions(id), skill TEXT NOT NULL, value TEXT NOT NULL, target TEXT NOT NULL, PRIMARY KEY(session,skill));
    CREATE TABLE IF NOT EXISTS invocations(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, session TEXT NOT NULL REFERENCES sessions(id), task TEXT NOT NULL REFERENCES tasks(id), value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS invocation_session ON invocations(session,seq);
    CREATE TRIGGER IF NOT EXISTS immutable_tasks_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'immutable task'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_tasks_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'immutable task'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_invocations_update BEFORE UPDATE ON invocations BEGIN SELECT RAISE(ABORT,'immutable invocation'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_invocations_delete BEFORE DELETE ON invocations BEGIN SELECT RAISE(ABORT,'immutable invocation'); END;`);
  type SessionRow = { id: string; team: string; owner: string; epoch: number };
  type TaskRow = { snapshot: string; checksums: string };
  const session = (actor: Actor, sessionId: string): SessionRow => {
    actorValid(actor); id(sessionId);
    const row = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId) as SessionRow | undefined;
    if (!row) return fail('NOT_FOUND', '会话不存在。');
    if (row.team !== actor.teamId || row.owner !== actor.userId) fail('FORBIDDEN', '无权访问此会话。');
    return row;
  };
  const task = (actor: Actor, taskId: string) => {
    id(taskId);
    const row = db.prepare('SELECT snapshot,checksums FROM tasks WHERE id=?').get(taskId) as TaskRow | undefined;
    if (!row) return fail('NOT_FOUND', '任务不存在。');
    const snapshot = JSON.parse(row.snapshot) as TaskSnapshot;
    session(actor, snapshot.sessionId);
    return { snapshot, checksums: JSON.parse(row.checksums) as Record<string,string> };
  };
  const catalog = async (actor: Actor): Promise<CatalogSnapshot> => {
    actorValid(actor);
    const c = structuredClone(await host.catalogSnapshot(actor));
    if (!c || c.teamId !== actor.teamId) return fail('FORBIDDEN', '无权访问团队技能目录。');
    if (!c.versions || typeof c.versions !== 'object' || Array.isArray(c.versions) || typeof c.capturedAt !== 'string') return fail('VALIDATION', '技能目录无效。');
    for (const [s,v] of Object.entries(c.versions)) { id(s); id(v); }
    return c;
  };
  const version = async (actor: Actor, skillId: string, versionId: string) => {
    let v: SkillVersion;
    try { v = structuredClone(await host.getVersion(actor, versionId)); }
    catch (e) { if (e instanceof DomainError && e.code === 'NOT_FOUND') return fail('RESOURCE_MISSING', '固定版本资源不可用，请重试。'); throw e; }
    validateVersion(v, actor, skillId, versionId); return v;
  };
  const prefs = (sessionId: string) => (db.prepare('SELECT value,target FROM preferences WHERE session=? ORDER BY skill').all(sessionId) as {value:string;target:string}[]).map(r => ({value: JSON.parse(r.value) as SessionPreference, target: r.target}));
  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch(e) { db.exec('ROLLBACK'); throw e; }
  };
  const existing = (actor: Actor, taskId: string, sessionId: string, parentTaskId?: string) => {
    if (!db.prepare('SELECT 1 FROM tasks WHERE id=?').get(taskId)) return null;
    const saved = task(actor, taskId).snapshot;
    if (saved.sessionId !== sessionId || saved.parentTaskId !== parentTaskId) fail('CONFLICT', '任务标识已用于另一请求。');
    return saved;
  };
  const invocations = (sessionId: string) => (db.prepare('SELECT value FROM invocations WHERE session=? ORDER BY seq').all(sessionId) as {value:string}[]).map(r => JSON.parse(r.value) as Invocation);
  const service: RuntimeService & {close():void} = {
    close() { db.close(); },
    async createSession(actor) {
      await catalog(actor);
      const sessionId = randomUUID();
      db.prepare('INSERT INTO sessions(id,team,owner) VALUES(?,?,?)').run(sessionId,actor.teamId,actor.userId);
      return {id:sessionId};
    },
    async createTask(actor, sessionId, taskId) {
      session(actor,sessionId); id(taskId);
      for (let attempt=0; attempt<8; attempt++) {
        const epoch = session(actor,sessionId).epoch;
        const preferences = prefs(sessionId);
        const c = await catalog(actor);
        const saved = existing(actor,taskId,sessionId); if (saved) return saved;
        const versions = Object.assign(Object.create(null), c.versions) as Record<string,string>;
        const revisions: Record<string,number> = Object.create(null);
        for (const {value:p} of preferences) {
          if (!Object.hasOwn(versions,p.skillId)) continue;
          revisions[p.skillId] = p.revision;
          if (p.mode === 'pinned') versions[p.skillId] = p.pinnedVersionId!;
        }
        const checksums: Record<string,string> = Object.create(null);
        for (const [s,v] of Object.entries(versions)) checksums[s] = (await version(actor,s,v)).checksum;
        const result = transaction(() => {
          const prior = existing(actor,taskId,sessionId); if (prior) return prior;
          if (session(actor,sessionId).epoch !== epoch) return null;
          const snapshot: TaskSnapshot = {taskId,sessionId,teamId:actor.teamId,actorId:actor.userId,versions,preferenceRevisions:revisions,createdAt:new Date().toISOString()};
          db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run(taskId,sessionId,JSON.stringify(snapshot),JSON.stringify(checksums));
          return JSON.parse(JSON.stringify(snapshot)) as TaskSnapshot;
        });
        if (result) return result;
      }
      return fail('STALE_REVISION', '会话选择持续变化，请重试任务。');
    },
    async getTask(actor, taskId) { const t = task(actor,taskId); await catalog(actor); return t.snapshot; },
    async createChildTask(actor,parentTaskId,taskId) {
      const parent = task(actor,parentTaskId); id(taskId); await catalog(actor);
      return transaction(() => {
        const prior = existing(actor,taskId,parent.snapshot.sessionId,parentTaskId); if (prior) return prior;
        const snapshot = {...parent.snapshot,taskId,parentTaskId,createdAt:new Date().toISOString()};
        db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run(taskId,snapshot.sessionId,JSON.stringify(snapshot),JSON.stringify(parent.checksums)); return snapshot;
      });
    },
    async resolveSkill(actor,taskId,skillId) {
      id(skillId); const t = task(actor,taskId);
      if (!Object.hasOwn(t.snapshot.versions,skillId)) return fail('NOT_FOUND', '此技能不在任务接受时的目录中。');
      const v = await version(actor,skillId,t.snapshot.versions[skillId]!);
      if (v.checksum !== t.checksums[skillId]) return fail('RESOURCE_MISSING', '固定版本内容已变化，无法安全继续，请重试。');
      return v;
    },
    async recordInvocation(actor,taskId,skillId) {
      const v = await service.resolveSkill(actor,taskId,skillId);
      const t = task(actor,taskId).snapshot;
      // Read authoritative current state even for a first invocation after publication.
      await catalog(actor);
      const invocation: Invocation = {id:randomUUID(),taskId,sessionId:t.sessionId,skillId,versionId:v.id,checksum:v.checksum,createdAt:new Date().toISOString()};
      db.prepare('INSERT INTO invocations(id,session,task,value) VALUES(?,?,?,?)').run(invocation.id,t.sessionId,taskId,JSON.stringify(invocation)); return invocation;
    },
    async listInvocations(actor,sessionId) { session(actor,sessionId); await catalog(actor); return invocations(sessionId); },
    async getSessionUpdates(actor,sessionId) {
      session(actor,sessionId); const c = await catalog(actor);
      const used = new Map<string,Invocation>(); for (const i of invocations(sessionId)) used.set(i.skillId,i);
      const preferences = new Map(prefs(sessionId).map(p => [p.value.skillId,p]));
      const updates: SessionUpdate[] = [];
      for (const [skillId,i] of used) {
        if (!Object.hasOwn(c.versions,skillId)) continue;
        const latestVersionId = c.versions[skillId]!;
        const p = preferences.get(skillId);
        const usedVersionId = p?.value.mode === 'pinned' ? p.value.pinnedVersionId! : i.versionId;
        if (usedVersionId === latestVersionId || (p?.value.mode === 'latest' && p.target === latestVersionId)) continue;
        updates.push({sessionId,skillId,usedVersionId,latestVersionId,preference:p?.value ?? null});
      }
      return updates;
    },
    async setPreference(actor,input: PreferenceInput) {
      if (!input) return fail('VALIDATION', '会话选择无效。');
      const {sessionId,skillId,mode,targetVersionId,expectedRevision} = input;
      session(actor,sessionId); id(skillId); id(targetVersionId);
      if (!['latest','pinned'].includes(mode) || !Number.isSafeInteger(expectedRevision) || expectedRevision<0) return fail('VALIDATION', '会话选择或修订号无效。');
      const c = await catalog(actor);
      if (!Object.hasOwn(c.versions,skillId)) return fail('FORBIDDEN', '当前无权使用此技能。');
      if (mode === 'latest' && c.versions[skillId] !== targetVersionId) return fail('STALE_REVISION', '技能又有更新，请查看最新变化后重新确认。');
      await version(actor,skillId,targetVersionId);
      const confirmed = await catalog(actor);
      if (!Object.hasOwn(confirmed.versions,skillId)) return fail('FORBIDDEN', '当前无权使用此技能。');
      if (mode === 'latest' && confirmed.versions[skillId] !== targetVersionId) return fail('STALE_REVISION', '技能又有更新，请查看最新变化后重新确认。');
      return transaction(() => {
        const current = prefs(sessionId).find(p => p.value.skillId === skillId)?.value;
        if ((current?.revision ?? 0) !== expectedRevision) return fail('STALE_REVISION', '会话选择已变化，请刷新后重试。');
        if (!invocations(sessionId).some(i => i.skillId === skillId && (mode === 'latest' || i.versionId === targetVersionId))) return fail('VALIDATION', '只能为会话实际调用过的技能选择版本。');
        const preference: SessionPreference = {sessionId,skillId,mode,pinnedVersionId:mode === 'pinned' ? targetVersionId : null,revision:expectedRevision+1};
        db.prepare('INSERT INTO preferences VALUES(?,?,?,?) ON CONFLICT(session,skill) DO UPDATE SET value=excluded.value,target=excluded.target').run(sessionId,skillId,JSON.stringify(preference),targetVersionId);
        db.prepare('UPDATE sessions SET epoch=epoch+1 WHERE id=?').run(sessionId);
        return preference;
      });
    }
  };
  return service;
}
