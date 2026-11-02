import { DomainError } from '../../../contracts/index.ts';
import type { Actor, LibraryService, SkillUpdateEvent, Draft, Skill, SkillVersion } from '../../../contracts/index.ts';
export const alice: Actor = { userId: 'alice', teamId: 'red', role: 'contributor' };
export const bob: Actor = { userId: 'bob', teamId: 'red', role: 'contributor' };
export const eve: Actor = { userId: 'eve', teamId: 'blue', role: 'contributor' };
/** Transport fixture only: not a persistence/publication correctness implementation. */
export function fixture() {
  const log: SkillUpdateEvent[] = [];
  const calls: { method: string; actor: Actor }[] = [];
  const receipts = new Map<string, SkillVersion>();
  const content = { files: [{ path: 'SKILL.md', content: 'fixture', mediaType: 'text/markdown' }] };
  const skill = (a: Actor): Skill => ({ id: 'skill', teamId: a.teamId, name: '技能', description: '', maintainerIds: [], currentVersionId: log.filter(e => e.teamId === a.teamId).at(-1)?.versionId ?? null, createdAt: 'now' });
  const draft = (a: Actor): Draft => ({ id: 'draft', skillId: 'skill', teamId: a.teamId, authorId: a.userId, revision: 1, baseVersionId: null, content, updatedAt: 'now' });
  function record(method: string, a: Actor) { calls.push({ method, actor: a }); }
  function publish(a: Actor) {
    const sequence = log.length + 1;
    const version: SkillVersion = { id: `v${sequence}`, skillId: 'skill', teamId: a.teamId, number: sequence, parentVersionId: null, content, checksum: '', changeSummary: '', authorId: a.userId, reviewerId: null, approvalMode: 'automatic', createdAt: 'now' };
    log.push({ id: `event${sequence}`, sequence, teamId: a.teamId, skillId: 'skill', previousVersionId: null, versionId: version.id, createdAt: 'now' });
    return version;
  }
  const library: LibraryService = {
    async listSkills(a, query) { record('listSkills', a); if (query === 'crash') throw new Error('SECRET database path'); return [skill(a)]; },
    async getSkill(a, id) { if (id !== 'skill') throw new DomainError('NOT_FOUND', '技能不存在'); return skill(a); },
    async createSkill(a) { record('createSkill', a); return { skill: skill(a), draft: draft(a) }; },
    async setMaintainers(a) { return skill(a); }, async listVersions() { return []; },
    async getVersion() { throw new DomainError('NOT_FOUND', 'missing'); }, async compareVersions() { return []; },
    async createDraft(a) { return draft(a); }, async getDraft(a) { return draft(a); }, async saveDraft(a) { record('saveDraft', a); return draft(a); },
    async publishDraft(a, input) {
      record('publishDraft', a);
      if (input.changeSummary === 'invalid') throw new DomainError('VALIDATION', '请补齐 SKILL.md');
      const key = `${a.teamId}:${a.userId}:${input.idempotencyKey}`;
      if (!receipts.has(key)) receipts.set(key, publish(a));
      return receipts.get(key)!;
    },
    async previewDraftUpdate(a) { record('previewDraftUpdate', a); return { draftId: 'draft', draftRevision: 1, baseVersionId: null, targetVersionId: null, baseContent: content, localContent: content, latestContent: content, candidateContent: content, localDiff: [], remoteDiff: [], conflicts: [], confirmationToken: 'token' }; },
    async applyDraftUpdate(a) { record('applyDraftUpdate', a); return draft(a); },
    async catalogSnapshot(a) { return { teamId: a.teamId, versions: {}, capturedAt: 'now' }; },
    async listUpdateEvents(a, after) { record('listUpdateEvents', a); return log.filter(e => e.teamId === a.teamId && e.sequence > after); },
    async listAudit() { return []; },
  };
  return { library, log, calls, publish, content };
}
