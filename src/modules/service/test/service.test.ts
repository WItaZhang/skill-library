import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createLibraryService, checksum, type LibraryOptions } from '../index.ts';
import { threeWay, validateContent } from '../content.ts';
import { DomainError, type Actor, type Draft, type SkillContent } from '../../../contracts/index.ts';
const a: Actor = { userId: 'a', teamId: 't', role: 'contributor' };
const b: Actor = { ...a, userId: 'b' };
const admin: Actor = { ...a, role: 'admin' };
const content = (text = 'one\ntwo\nthree\n', extra: SkillContent['files'] = []): SkillContent => ({ files: [{ path: 'SKILL.md', content: text, mediaType: 'text/markdown' }, ...extra] });
const code = (value: string) => (e: unknown) => e instanceof DomainError && e.code === value;
function fixture(t: any, options: Partial<LibraryOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'service-v2-'));
  const path = join(dir, 'db.sqlite');
  const service = createLibraryService({ databasePath: path, ...options });
  t.after(() => { service.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, path };
}
const request = (d: Draft, key = 'publish') => ({ draftId: d.id, expectedRevision: d.revision, expectedBaseVersionId: d.baseVersionId, changeSummary: '生效', idempotencyKey: key });
async function initial(s: ReturnType<typeof createLibraryService>) {
  const { skill, draft } = await s.createSkill(a, { name: '技能', description: '', maintainerIds: [], content: content() });
  const version = await s.publishDraft(a, request(draft));
  return { skill, draft: await s.getDraft(a, draft.id), version };
}

test('single author publishes atomically; exact replay survives later draft edits and restart; legacy paths absent', async t => {
  const { service: s, path } = fixture(t);
  const { draft, version, skill } = await initial(s);
  assert.equal(version.reviewerId, null); assert.equal(version.approvalMode, 'automatic');
  assert.equal(draft.revision, 2); assert.equal(draft.baseVersionId, version.id);
  for (const name of ['submitProposal','reviewProposal','mergeProposal','previewMerge','listProposals','getProposal','withdrawProposal']) assert.equal((s as any)[name], undefined);
  await s.saveDraft(a, { draftId: draft.id, expectedRevision: 2, content: content('later') });
  const original = { ...request(draft), expectedRevision: 1, expectedBaseVersionId: null };
  assert.deepEqual(await s.publishDraft(a, original), version);
  await assert.rejects(s.publishDraft(a, { ...original, changeSummary: 'different' }), code('CONFLICT'));
  const reopened = createLibraryService({ databasePath: path });
  try { assert.deepEqual(await reopened.publishDraft(a, original), version); } finally { reopened.close(); }
  assert.equal((await s.listVersions(a, skill.id)).length, 1);
  assert.equal((await s.listUpdateEvents(a, 0)).length, 1);
  assert.equal((await s.listAudit(admin)).filter(x => x.action === 'draft.publish').length, 1);
});

test('stale nonoverlap rejects; preview uses unsaved immutable snapshot; explicit apply and replay have no events', async t => {
  const { service: s } = fixture(t); const { skill, draft } = await initial(s);
  const other = await s.createDraft(b, skill.id);
  const updated = await s.saveDraft(a, { draftId: draft.id, expectedRevision: draft.revision, content: content('ONE\ntwo\nthree\n') });
  await s.publishDraft(a, request(updated, 'second'));
  const local = content('one\ntwo\nTHREE\n');
  const saved = await s.saveDraft(b, { draftId: other.id, expectedRevision: 1, content: local });
  await assert.rejects(s.publishDraft(b, request(saved)), code('STALE_REVISION'));
  const unsaved = content('one\ntwo\nTHREE unsaved\n');
  const preview = await s.previewDraftUpdate(b, { draftId: saved.id, expectedRevision: saved.revision, content: unsaved });
  unsaved.files[0].content = 'mutated';
  assert.deepEqual(await s.getDraft(b, saved.id), saved);
  assert.equal(preview.localContent.files[0].content, 'one\ntwo\nTHREE unsaved\n');
  assert.equal(preview.conflicts.length, 0);
  assert.equal(preview.candidateContent.files[0].content, 'ONE\ntwo\nTHREE unsaved\n');
  assert.equal(preview.localDiff.length, 1); assert.equal(preview.remoteDiff.length, 1);
  const input = { draftId: saved.id, expectedRevision: saved.revision, targetVersionId: preview.targetVersionId, confirmationToken: preview.confirmationToken, resolvedContent: preview.candidateContent, idempotencyKey: 'apply' };
  const applied = await s.applyDraftUpdate(b, input);
  assert.equal(applied.revision, saved.revision + 1); assert.equal(applied.baseVersionId, preview.targetVersionId);
  assert.deepEqual(await s.applyDraftUpdate(b, input), applied);
  await assert.rejects(s.applyDraftUpdate(b, { ...input, resolvedContent: content('other') }), code('CONFLICT'));
  await assert.rejects(s.saveDraft(b, { draftId: saved.id, expectedRevision: saved.revision, content: local }), code('STALE_REVISION'));
  assert.equal((await s.listUpdateEvents(a, 0)).length, 2);
  await s.publishDraft(b, request(applied));
  assert.equal((await s.listUpdateEvents(a, 0)).length, 3);
  assert.deepEqual(await s.applyDraftUpdate(b, input), applied);
});

test('tokens reject tampering, other drafts/users/teams, newer target and changed saved revision', async t => {
  const { service: s } = fixture(t); const { skill, draft } = await initial(s);
  const other = await s.createDraft(b, skill.id);
  const preview = await s.previewDraftUpdate(a, { draftId: draft.id, expectedRevision: draft.revision, content: content('unsaved') });
  const input = { draftId: draft.id, expectedRevision: draft.revision, targetVersionId: preview.targetVersionId, confirmationToken: preview.confirmationToken, resolvedContent: content('resolved'), idempotencyKey: 'apply' };
  await assert.rejects(s.applyDraftUpdate(a, { ...input, confirmationToken: 'fake' }), code('STALE_REVISION'));
  await assert.rejects(s.applyDraftUpdate(b, input), code('FORBIDDEN'));
  await assert.rejects(s.previewDraftUpdate(b, { draftId: draft.id, expectedRevision: draft.revision, content: content() }), code('FORBIDDEN'));
  await assert.rejects(s.applyDraftUpdate({ ...a, teamId: 'other' }, input), code('NOT_FOUND'));
  await assert.rejects(s.applyDraftUpdate(b, { ...input, draftId: other.id, expectedRevision: 1 }), code('STALE_REVISION'));
  const ownOther = await s.createDraft(a, skill.id);
  await assert.rejects(s.applyDraftUpdate(a, { ...input, draftId: ownOther.id, expectedRevision: 1 }), code('STALE_REVISION'));
  await s.saveDraft(a, { draftId: draft.id, expectedRevision: draft.revision, content: content('changed') });
  await assert.rejects(s.applyDraftUpdate(a, input), code('STALE_REVISION'));
  const p2 = await s.previewDraftUpdate(b, { draftId: other.id, expectedRevision: 1, content: content('keep') });
  await s.publishDraft(a, request(await s.getDraft(a, draft.id), 'new'));
  await assert.rejects(s.applyDraftUpdate(b, { ...input, draftId: other.id, expectedRevision: 1, targetVersionId: p2.targetVersionId, confirmationToken: p2.confirmationToken }), code('STALE_REVISION'));
  assert.deepEqual(await s.getDraft(b, other.id), other);
  assert.equal((await s.listUpdateEvents(a, 0)).length, 2);
});

test('incomplete drafts persist, publish fully validates; structure/script/member/role protections remain', async t => {
  const { service: s } = fixture(t);
  const { draft } = await s.createSkill(a, { name: 'incomplete', description: '', maintainerIds: [], content: content('') });
  await assert.rejects(s.publishDraft(a, request(draft)), code('VALIDATION'));
  let d = await s.saveDraft(a, { draftId: draft.id, expectedRevision: 1, content: content('[missing](missing.txt)') });
  await assert.rejects(s.publishDraft(a, request(d)), code('RESOURCE_MISSING'));
  d = await s.saveDraft(a, { draftId: d.id, expectedRevision: d.revision, content: content('ok', [{ path: 'data.json', mediaType: 'application/json', content: '{' }]) });
  await assert.rejects(s.publishDraft(a, request(d)), code('VALIDATION'));
  for (const path of ['../bad', '/bad', 'a//b', 'a\\b', 'a%20b']) await assert.rejects(s.saveDraft(a, { draftId: d.id, expectedRevision: d.revision, content: content('ok', [{ path, mediaType: 'text/plain', content: '' }]) }), code('VALIDATION'));
  await assert.rejects(s.saveDraft(a, { draftId: d.id, expectedRevision: d.revision, content: content('ok', [{ path: 'run.sh', mediaType: 'text/plain', content: 'echo x' }]) }), code('FORBIDDEN'));
  await assert.rejects(s.saveDraft({ ...a, role: 'viewer' }, { draftId: d.id, expectedRevision: d.revision, content: content() }), code('FORBIDDEN'));
  assert.equal((await s.listUpdateEvents(a, 0)).length, 0);
  assert.deepEqual(await s.listUpdateEvents({ ...a, teamId: 'other' }, 0), []);
  const gated = createLibraryService({ databasePath: ':memory:', authorizeActor: () => false });
  try { await assert.rejects(gated.listSkills(a), code('FORBIDDEN')); } finally { gated.close(); }
});

for (const stage of ['after_version','after_pointer','after_draft','after_event','after_audit','after_request'] as const) {
  test(`publication rollback at ${stage} leaves all durable state unchanged`, async t => {
    let enabled = false;
    const { service: s, path } = fixture(t, { faultInjector: where => { if (enabled && where === stage) throw Error('injected'); } });
    const { draft, skill } = await initial(s);
    const db = new DatabaseSync(path);
    const snapshot = () => Object.fromEntries(['versions','skills','drafts','events','audit','requests'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    const before = snapshot(); enabled = true;
    await assert.rejects(s.publishDraft(a, request(draft, 'fault')), code('UNAVAILABLE'));
    assert.deepEqual(snapshot(), before); enabled = false;
    await s.publishDraft(a, request(draft, 'fault'));
    assert.equal((await s.listVersions(a, skill.id)).length, 2); db.close();
  });
}

test('two independent processes concurrently publish one success; replay across processes stays singular', async t => {
  const { service: s, path } = fixture(t); const { skill } = await initial(s);
  const da = await s.createDraft(a, skill.id); const db = await s.createDraft(b, skill.id);
  const start = async () => {
    const child = fork(new URL('./process-worker.ts', import.meta.url), [path], { execArgv: ['--import', 'tsx'], stdio: ['ignore','ignore','pipe','ipc'] });
    await once(child, 'message');
    return child;
  };
  const children = await Promise.all([start(), start()]);
  const responses = children.map(child => once(child, 'message'));
  children[0].send({ operation: 'publish', actor: a, input: request(da, 'race') });
  children[1].send({ operation: 'publish', actor: b, input: request(db, 'race') });
  const results = (await Promise.all(responses)).map(([r]) => r);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.find(r => !r.ok).code, 'STALE_REVISION');
  const winner = results[0].ok ? a : b, d = results[0].ok ? da : db;
  const retry = await start(); const response = once(retry, 'message');
  retry.send({ operation: 'publish', actor: winner, input: request(d, 'race') });
  assert.deepEqual((await response)[0].result, results.find(r => r.ok).result);
  assert.equal((await s.listUpdateEvents(a, 0)).length, 2);
  const loser = results[0].ok ? db : da;
  assert.deepEqual(await s.getDraft(results[0].ok ? b : a, loser.id), loser);
});

test('v1 database upgrade preserves exact historical JSON and pending proposal while old draft can publish', async t => {
  const { service: s, path } = fixture(t); s.close();
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE draft_previews; UPDATE service_schema SET version=1');
  const legacy = { id: 'old', skillId: 'skill', teamId: 't', number: 1, parentVersionId: null, content: content(), checksum: checksum(content()), changeSummary: 'legacy', authorId: 'a', reviewerId: 'real-reviewer', createdAt: '2025-01-01' };
  const raw = JSON.stringify(legacy, null, 2);
  db.prepare('INSERT INTO versions(id,team,data) VALUES(?,?,?)').run('old','t',raw);
  db.prepare('INSERT INTO skills VALUES(?,?,?)').run('skill','t',JSON.stringify({ id:'skill',teamId:'t',name:'legacy',description:'',maintainerIds:[],currentVersionId:'old',createdAt:'2025',creatorId:'a' }));
  const draft: Draft = { id:'draft',skillId:'skill',teamId:'t',authorId:'a',baseVersionId:'old',revision:4,content:content('new'),updatedAt:'2025' };
  db.prepare('INSERT INTO drafts VALUES(?,?,?)').run('draft','t',JSON.stringify(draft));
  const proposal = JSON.stringify({ id:'pending',teamId:'t',status:'pending',content:content() });
  db.prepare('INSERT INTO proposals VALUES(?,?,?)').run('pending','t',proposal);
  const upgraded = createLibraryService({ databasePath: path });
  try {
    assert.deepEqual(await upgraded.getVersion(a,'old'),legacy);
    const version = await upgraded.publishDraft(a, request(draft)); assert.equal(version.number,2);
    assert.equal(db.prepare("SELECT data FROM versions WHERE id='old'").get()!.data,raw);
    assert.equal(db.prepare("SELECT data FROM proposals WHERE id='pending'").get()!.data,proposal);
    assert.equal(db.prepare('SELECT version FROM service_schema').get()!.version,2);
    assert.throws(() => db.prepare("UPDATE versions SET data='{}' WHERE id='old'").run());
  } finally { upgraded.close(); db.close(); }
});

test('three-way overlap/deletion retain all sides; complete validation parses references and canonical hashes', () => {
  const result = threeWay(content('base'), content('remote'), content('local'));
  assert.equal(result.conflicts.length,1);
  assert.deepEqual(result.conflicts[0], { path:'SKILL.md',base:'base',current:'remote',proposed:'local' });
  assert.equal(threeWay(content('base'), content('remote'), { files: [] }).conflicts.length,1);
  assert.doesNotThrow(() => validateContent(content('```\n[missing](no.txt)\n```')));
  assert.throws(() => validateContent(content('[missing](no.txt)')),code('RESOURCE_MISSING'));
  const files = content('ok',[{ path:'a.txt',content:'x',mediaType:'text/plain' }]);
  assert.equal(checksum(files),checksum({files:[...files.files].reverse()}));
});

test('apply rollback preserves draft/token and idempotency; confirmed deletion differs from empty file', async t => {
  let fault = false;
  const { service: s } = fixture(t, { faultInjector: stage => { if (fault && stage === 'after_request') throw Error('rollback'); } });
  const { draft } = await initial(s);
  const preview = await s.previewDraftUpdate(a, { draftId: draft.id, expectedRevision: draft.revision, content: { files: [] } });
  const input = { draftId: draft.id, expectedRevision: draft.revision, targetVersionId: preview.targetVersionId, confirmationToken: preview.confirmationToken, resolvedContent: { files: [] }, idempotencyKey: 'delete' };
  const audit = await s.listAudit(admin); fault = true;
  await assert.rejects(s.applyDraftUpdate(a,input),code('UNAVAILABLE'));
  assert.deepEqual(await s.getDraft(a,draft.id),draft);
  assert.deepEqual(await s.listAudit(admin),audit);
  fault = false;
  const applied = await s.applyDraftUpdate(a,input);
  assert.deepEqual(applied.content,{files:[]});
  await assert.rejects(s.publishDraft(a,request(applied,'deleted')),code('VALIDATION'));
  const empty = await s.saveDraft(a,{draftId:draft.id,expectedRevision:applied.revision,content:content('')});
  assert.equal(empty.content.files.length,1);
  assert.equal((await s.listUpdateEvents(a,0)).length,1);
});

test('independent connection save invalidates preview; permission revocation also blocks successful replay', async t => {
  let allowed = true;
  const { service:s,path } = fixture(t,{authorizeActor:()=>allowed});
  const { draft } = await initial(s);
  const preview = await s.previewDraftUpdate(a,{draftId:draft.id,expectedRevision:draft.revision,content:content('local')});
  const second = createLibraryService({databasePath:path});
  try {
    const newer = await second.saveDraft(a,{draftId:draft.id,expectedRevision:draft.revision,content:content('other tab')});
    await assert.rejects(s.applyDraftUpdate(a,{draftId:draft.id,expectedRevision:draft.revision,targetVersionId:preview.targetVersionId,confirmationToken:preview.confirmationToken,resolvedContent:preview.candidateContent,idempotencyKey:'apply'}),code('STALE_REVISION'));
    assert.deepEqual(await s.getDraft(a,draft.id),newer);
    allowed = false;
    await assert.rejects(s.publishDraft(a,{...request(draft),expectedRevision:1,expectedBaseVersionId:null}),code('FORBIDDEN'));
  } finally { second.close(); }
});
