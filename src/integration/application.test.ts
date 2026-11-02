import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './server.ts';

test('connected demo: cookie identity, isolation, stale draft, atomic publication and pinned tasks survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-app-'));
  writeFileSync(join(dir, 'index.html'), '<h1>Skill Library</h1>');
  let app = createApplication({ dataDir: dir, webDir: dir, publicOrigin: 'http://localhost' });
  let base = '';
  async function listen() { await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${(app.server.address() as any).port}`; }
  async function call(path: string, input: unknown, cookie = '') {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Skill-Library': '1', Cookie: cookie }, body: JSON.stringify(input) });
    return { response, value: await response.json() };
  }
  const library = async (cookie: string, method: string, ...args: unknown[]) => call('/api/library/' + method, { args }, cookie);
  const runtime = async (cookie: string, method: string, ...args: unknown[]) => call('/api/runtime/' + method, { args }, cookie);
  try {
    await listen();
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await library('', 'listSkills')).response.status, 403);
    const csrf = await fetch(base + '/api/demo/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Skill-Library': '1', Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(csrf.status, 403);
    const a = await call('/api/demo/bootstrap', {}), b = await call('/api/demo/bootstrap', {});
    const cookie = a.response.headers.get('set-cookie')!.split(';')[0], otherCookie = b.response.headers.get('set-cookie')!.split(';')[0];
    assert.match(a.response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.notEqual(a.value.result.actor.teamId, b.value.result.actor.teamId);
    const skill = (await library(cookie, 'listSkills')).value.result[0];
    assert.equal((await library(otherCookie, 'getSkill', skill.id)).response.status, 404);
    assert.equal((await runtime(cookie, 'constructor')).response.status, 404);
    assert.equal((await call('/api/runtime/createSession', { args: [], actor: b.value.result.actor }, cookie)).response.status, 400);
    const session = (await runtime(cookie, 'createSession')).value.result;
    const originalTask = (await runtime(cookie, 'createTask', session.id, 'original')).value.result;
    assert.equal(originalTask.versions[skill.id], skill.currentVersionId);
    const draft = (await library(cookie, 'createDraft', skill.id)).value.result;
    const published = await call('/api/demo/publish', { skillId: skill.id }, cookie);
    assert.equal(published.response.status, 200);
    assert.equal((await call('/api/demo/publish', { skillId: skill.id }, otherCookie)).response.status, 404);
    const stale = await library(cookie, 'publishDraft', { draftId: draft.id, expectedRevision: draft.revision, expectedBaseVersionId: draft.baseVersionId, changeSummary: 'stale', idempotencyKey: 'stale' });
    assert.equal(stale.value.error.code, 'STALE_REVISION');
    draft.content.files[0].content += '\n我的独立补充。\n';
    const preview = (await library(cookie, 'previewDraftUpdate', { draftId: draft.id, expectedRevision: draft.revision, content: draft.content })).value.result;
    const resolvedContent = structuredClone(preview.latestContent);
    resolvedContent.files[0].content += '\n我的独立补充。\n';
    const applied = (await library(cookie, 'applyDraftUpdate', { draftId: draft.id, expectedRevision: draft.revision, targetVersionId: preview.targetVersionId, confirmationToken: preview.confirmationToken, resolvedContent, idempotencyKey: 'sync' })).value.result;
    const input = { draftId: applied.id, expectedRevision: applied.revision, expectedBaseVersionId: applied.baseVersionId, changeSummary: '整合双方修改', idempotencyKey: 'publish' };
    const final = (await library(cookie, 'publishDraft', input)).value.result;
    assert.equal(final.number, 3);
    assert.deepEqual((await library(cookie, 'publishDraft', input)).value.result, final);
    assert.equal((await runtime(cookie, 'getTask', 'original')).value.result.versions[skill.id], skill.currentVersionId);
    assert.equal((await runtime(cookie, 'createTask', session.id, 'new')).value.result.versions[skill.id], final.id);
    assert.equal((await runtime(otherCookie, 'getTask', 'original')).response.status, 403);
    await app.close();
    app = createApplication({ dataDir: dir, webDir: dir, publicOrigin: 'http://localhost' });
    await listen();
    assert.equal((await library(cookie, 'getSkill', skill.id)).value.result.currentVersionId, final.id);
    assert.equal((await runtime(cookie, 'getTask', 'original')).value.result.versions[skill.id], skill.currentVersionId);
    assert.equal((await call('/api/demo/bootstrap', {}, cookie)).response.headers.get('set-cookie'), null);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('workspace admission is bounded and bootstrap does not trust supplied identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-capacity-'));
  const app = createApplication({ dataDir: dir, webDir: dir, publicOrigin: 'http://localhost', maxWorkspaces: 1 });
  try {
    await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(app.server.address() as any).port}/api/demo/bootstrap`;
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Skill-Library': '1' }, body: JSON.stringify({ actor: { userId: 'admin', role: 'admin' } }) };
    const first = await fetch(url, options);
    assert.equal((await first.json()).result.actor.role, 'contributor');
    assert.equal((await fetch(url, options)).status, 503);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
