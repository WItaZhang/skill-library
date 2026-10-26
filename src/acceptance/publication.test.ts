import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLibraryService } from '../modules/service/index.ts';
import { createRuntimeService } from '../modules/runtime/index.ts';
import { createLibraryHttpHandler } from '../modules/broadcast/server.ts';
import { createHttpLibraryClient } from '../modules/broadcast/client.ts';
import { DomainError } from '../contracts/index.ts';
import type { Actor, SkillContent, SkillUpdateEvent } from '../contracts/index.ts';

const alice: Actor = { userId: 'alice', teamId: 'team-a', role: 'contributor' };
const bob: Actor = { userId: 'bob', teamId: 'team-a', role: 'contributor' };
const eve: Actor = { userId: 'eve', teamId: 'team-b', role: 'contributor' };
const content = (text: string): SkillContent => ({ files: [{ path: 'SKILL.md', content: text, mediaType: 'text/markdown' }] });
const body = '# Weekly report\n\nFormat: concise\n\nLanguage: English\n';
const actors: Record<string, Actor> = { 'alice-test-token': alice, 'bob-test-token': bob, 'eve-test-token': eve };

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'skill-publication-acceptance-'));
  const library = createLibraryService({ databasePath: join(folder, 'library.sqlite') });
  const secondWriter = createLibraryService({ databasePath: join(folder, 'library.sqlite') });
  const runtime = createRuntimeService({ databasePath: join(folder, 'runtime.sqlite'), host: library });
  const handler = createLibraryHttpHandler({
    library,
    resolveActor: (request: import('node:http').IncomingMessage) => {
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      const actor = token && actors[token];
      if (!actor) throw new DomainError('FORBIDDEN', '需要测试身份');
      return actor;
    },
    pollIntervalMs: 20,
  });
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = (token: string) => createHttpLibraryClient({ baseUrl, fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Origin', baseUrl);
    return fetch(input, { ...init, headers });
  } });
  const streams: AbortController[] = [];
  async function stream(token: string, after = 0) {
    const controller = new AbortController(); streams.push(controller);
    const response = await fetch(`${baseUrl}/api/events?after=${after}`, {
      headers: { Authorization: `Bearer ${token}`, Origin: baseUrl }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const events: SkillUpdateEvent[] = [];
    const reader = response.body!.getReader();
    const done = (async () => {
      let buffer = ''; const decoder = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (!frame.split('\n').some(line => line.trim() === 'event: skill.updated')) continue;
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data) events.push(JSON.parse(data));
          }
        }
      } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { reader.releaseLock(); }
    })();
    return { events, stop: async () => { controller.abort(); await done; } };
  }
  return { library, secondWriter, runtime, client, stream, baseUrl, async close() {
    for (const controller of streams) controller.abort();
    await handler.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.close(); secondWriter.close(); library.close();
    await rm(folder, { recursive: true, force: true });
  } };
}
async function until(predicate: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for publication broadcast'); await delay(10); }
}

// These tests use real SQLite implementations, loopback HTTP, SSE and the shared browser HTTP client.
test('real publication -> broadcast -> author confirmation -> publication; no reviewer and no silent merge', { timeout: 15000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const a = f.client('alice-test-token'); const b = f.client('bob-test-token');
  const created = await a.createSkill(alice, { name: 'Weekly', description: 'Shared report', maintainerIds: [], content: content(body) });
  const v1 = await a.publishDraft(alice, { draftId: created.draft.id, expectedRevision: created.draft.revision, expectedBaseVersionId: null, changeSummary: 'Initial', idempotencyKey: 'initial' });
  assert.equal(v1.reviewerId, null); assert.equal(v1.approvalMode, 'automatic');
  const draftB = await b.createDraft(bob, created.skill.id);
  const draftA = await a.createDraft(alice, created.skill.id);
  const ownInput = content(body.replace('Language: English', 'Language: Chinese'));
  const sA = await f.stream('alice-test-token', 0);
  const sB = await f.stream('bob-test-token', 0);
  const sE = await f.stream('eve-test-token', 0);
  const changedA = await a.saveDraft(alice, { draftId: draftA.id, expectedRevision: draftA.revision, content: content(body.replace('Format: concise', 'Format: bullet list')) });
  const v2 = await a.publishDraft(alice, { draftId: changedA.id, expectedRevision: changedA.revision, expectedBaseVersionId: v1.id, changeSummary: 'New format', idempotencyKey: 'alice-v2' });
  await until(() => sA.events.some(e => e.versionId === v2.id) && sB.events.some(e => e.versionId === v2.id));
  assert.equal(sE.events.length, 0);
  assert.deepEqual((await b.getDraft(bob, draftB.id)).content, content(body));
  assert.deepEqual(ownInput, content(body.replace('Language: English', 'Language: Chinese')));
  const savedB = await b.saveDraft(bob, { draftId: draftB.id, expectedRevision: draftB.revision, content: ownInput });
  await assert.rejects(b.publishDraft(bob, { draftId: savedB.id, expectedRevision: savedB.revision, expectedBaseVersionId: v1.id, changeSummary: 'Chinese', idempotencyKey: 'blocked-v1' }), { code: 'STALE_REVISION' });
  const preview = await b.previewDraftUpdate(bob, { draftId: savedB.id, expectedRevision: savedB.revision, content: ownInput });
  assert.equal(preview.targetVersionId, v2.id); assert.equal(preview.conflicts.length, 0);
  assert.match(preview.candidateContent.files[0]!.content, /bullet list/);
  assert.match(preview.candidateContent.files[0]!.content, /Chinese/);
  assert.equal((await b.getDraft(bob, savedB.id)).baseVersionId, v1.id);
  const synchronized = await b.applyDraftUpdate(bob, { draftId: savedB.id, expectedRevision: savedB.revision, targetVersionId: v2.id, confirmationToken: preview.confirmationToken, resolvedContent: preview.candidateContent, idempotencyKey: 'bob-sync' });
  assert.equal(synchronized.baseVersionId, v2.id);
  assert.equal((await f.library.listUpdateEvents(alice, 0)).length, 2, 'draft synchronization is not publication');
  const publish = { draftId: synchronized.id, expectedRevision: synchronized.revision, expectedBaseVersionId: v2.id, changeSummary: 'Chinese report', idempotencyKey: 'bob-v3' };
  const v3 = await b.publishDraft(bob, publish);
  assert.equal((await b.publishDraft(bob, publish)).id, v3.id);
  await until(() => sA.events.some(e => e.versionId === v3.id));
  assert.equal((await f.library.listUpdateEvents(alice, 0)).length, 3);
  assert.equal((await f.library.getVersion(alice, v1.id)).content.files[0]!.content, body);
  const staleApply = b.applyDraftUpdate(bob, { draftId: synchronized.id, expectedRevision: synchronized.revision, targetVersionId: v2.id, confirmationToken: preview.confirmationToken, resolvedContent: preview.candidateContent, idempotencyKey: 'different-stale-request' });
  await assert.rejects(staleApply, { code: 'STALE_REVISION' });
  const oldRoute = await fetch(`${f.baseUrl}/api/library/mergeProposal`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Skill-Library': '1', Origin: f.baseUrl, Authorization: 'Bearer alice-test-token' }, body: JSON.stringify({ args: [] }) });
  assert.ok(oldRoute.status >= 400);
});

test('disconnect replay and changed preview target reject old resolution; running task keeps original resources', { timeout: 15000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const created = await f.library.createSkill(alice, { name: 'Runtime', description: 'Runtime isolation', maintainerIds: [], content: content(body) });
  const first = await f.library.publishDraft(alice, { draftId: created.draft.id, expectedRevision: created.draft.revision, expectedBaseVersionId: null, changeSummary: 'Initial', idempotencyKey: 'init' });
  const session = await f.runtime.createSession(bob);
  await f.runtime.createTask(bob, session.id, 'running');
  await f.runtime.recordInvocation(bob, 'running', created.skill.id);
  const draftB = await f.library.createDraft(bob, created.skill.id);
  const oldEvents = await f.library.listUpdateEvents(alice, 0);
  const cursor = oldEvents.at(-1)!.sequence;
  const offline = await f.stream('bob-test-token', cursor); await offline.stop();
  async function next(text: string, key: string) {
    const d = await f.secondWriter.createDraft(alice, created.skill.id);
    const s = await f.secondWriter.saveDraft(alice, { draftId: d.id, expectedRevision: d.revision, content: content(text) });
    return f.secondWriter.publishDraft(alice, { draftId: s.id, expectedRevision: s.revision, expectedBaseVersionId: s.baseVersionId, changeSummary: key, idempotencyKey: key });
  }
  const second = await next(body.replace('concise', 'long'), 'second');
  const unsaved = content(body.replace('concise', 'my local change'));
  const preview = await f.library.previewDraftUpdate(bob, { draftId: draftB.id, expectedRevision: draftB.revision, content: unsaved });
  assert.ok(preview.conflicts.length > 0);
  const third = await next(body.replace('concise', 'third format'), 'third');
  await assert.rejects(f.library.applyDraftUpdate(bob, { draftId: draftB.id, expectedRevision: draftB.revision, targetVersionId: second.id, confirmationToken: preview.confirmationToken, resolvedContent: unsaved, idempotencyKey: 'stale-resolution' }), { code: 'STALE_REVISION' });
  assert.equal((await f.library.getDraft(bob, draftB.id)).baseVersionId, first.id);
  assert.deepEqual((await f.library.getDraft(bob, draftB.id)).content, content(body));
  const reconnected = await f.stream('bob-test-token', cursor);
  await until(() => reconnected.events.some(e => e.versionId === third.id));
  assert.deepEqual(reconnected.events.map(e => e.versionId), [second.id, third.id]);
  assert.equal((await f.runtime.resolveSkill(bob, 'running', created.skill.id)).id, first.id);
  await f.runtime.createTask(bob, session.id, 'new-task');
  assert.equal((await f.runtime.resolveSkill(bob, 'new-task', created.skill.id)).id, third.id);
  assert.equal((await f.runtime.getSessionUpdates(bob, session.id))[0]!.latestVersionId, third.id);
});
