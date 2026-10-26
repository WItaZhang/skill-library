import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '../../../contracts/index.ts';
import type { Actor, SkillUpdateEvent } from '../../../contracts/index.ts';
import { createLibraryHttpHandler } from '../server.ts';
import { createHttpLibraryClient, createSseSkillUpdateSource } from '../client.ts';
import type { EventSourceLike } from '../client.ts';
import { alice, bob, eve, fixture } from './fixture.ts';

async function setup() {
  const f = fixture();
  const identities = new Map([['alice', alice], ['bob', bob], ['eve', eve]]);
  const handler = createLibraryHttpHandler({ library: f.library, pollIntervalMs: 15, maxBodyBytes: 2048, bodyTimeoutMs: 100,
    resolveActor(req) { const a = identities.get(req.headers.cookie ?? ''); if (!a) throw new DomainError('FORBIDDEN', 'secret'); return a; },
  });
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const authFetch = (identity: string): typeof fetch => (url, init) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Cookie: identity } });
  const client = (identity: string) => createHttpLibraryClient({ baseUrl, fetch: authFetch(identity) });
  const close = async () => { handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { ...f, baseUrl, client, authFetch, identities, handler, close };
}
async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await delay(10); }
}
/** Test-only fetch-backed EventSource shim: tests the injected browser boundary over actual TCP. */
function eventSource(identity: string, instances: TestSource[]) {
  return class extends TestSource { constructor(url: string) { super(url, identity); instances.push(this); } };
}
class TestSource implements EventSourceLike {
  listeners = new Map<string, Set<(event: { data?: string }) => void>>();
  controller = new AbortController(); closed = false; cursor = ''; received: string[] = [];
  readonly url: string; readonly identity: string;
  constructor(url: string, identity: string) { this.url = url; this.identity = identity; void this.connect(); }
  addEventListener(type: string, fn: (event: { data?: string }) => void) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(fn); }
  removeEventListener(type: string, fn: (event: { data?: string }) => void) { this.listeners.get(type)?.delete(fn); }
  emit(type: string, data?: string) { this.listeners.get(type)?.forEach(fn => fn({ data })); }
  async connect() {
    try {
      const response = await fetch(this.url, { headers: { Cookie: this.identity, ...(this.cursor ? { 'Last-Event-ID': this.cursor } : {}) }, signal: this.controller.signal });
      if (!response.ok) throw new Error('HTTP error');
      this.emit('open');
      const reader = response.body!.getReader(); const decoder = new TextDecoder(); let pending = '';
      while (!this.closed) {
        const { done, value } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, index); pending = pending.slice(index + 2);
          const id = /^id: (.*)$/m.exec(frame)?.[1]; if (id) this.cursor = id;
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (data) { this.received.push(data); this.emit('skill.updated', data); }
        }
      }
    } catch { if (!this.closed) this.emit('error'); }
  }
  async reconnect() { this.controller.abort(); await delay(10); this.controller = new AbortController(); await Promise.resolve(); void this.connect(); }
  close() { this.closed = true; this.controller.abort(); }
}
const publishInput = { draftId: 'draft', expectedRevision: 1, expectedBaseVersionId: null, changeSummary: '发布', idempotencyKey: 'first' };

test('HTTP whitelist, trusted actor, origin/header/input protection and safe failures', async t => {
  const s = await setup(); t.after(s.close);
  const client = s.client('alice');
  assert.equal((await client.listSkills(eve))[0].teamId, 'red');
  assert.deepEqual(s.calls.at(-1)?.actor, alice);
  for (const method of ['approve', 'mergeProposal', 'reviewProposal', 'submitDraft', 'constructor', 'toString', '__proto__']) {
    assert.equal((await s.authFetch('alice')(`${s.baseUrl}/api/library/${method}`, { method: 'POST', headers: { 'X-Skill-Library': '1' } })).status, 404);
  }
  const raw = (body: string, headers = {}) => s.authFetch('alice')(`${s.baseUrl}/api/library/listSkills`, { method: 'POST', headers: { 'X-Skill-Library': '1', 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await raw('{"args":[],"actor":{"teamId":"blue"}}')).status, 400);
  assert.equal((await raw('{"args":[]}', { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await raw('{"args":[]}', { Origin: s.baseUrl })).status, 200);
  assert.equal((await raw('{"args":[]}', { 'X-Skill-Library': '' })).status, 403);
  assert.equal((await raw('{"args":[]}', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await raw('{')).status, 400);
  assert.equal((await raw(' '.repeat(3000))).status, 400);
  assert.equal((await raw('{"args":[1,2,3]}')).status, 400);
  await assert.rejects(s.client('unknown').listSkills(alice), { code: 'FORBIDDEN' });
  await assert.rejects(client.getSkill(alice, 'missing'), { code: 'NOT_FOUND', message: '技能不存在' });
  await assert.rejects(client.listSkills(alice, 'crash'), { code: 'UNAVAILABLE', message: '服务暂时不可用' });
  await assert.rejects(createHttpLibraryClient({ fetch: async () => { throw new Error('secret'); } }).listSkills(alice), { code: 'UNAVAILABLE' });
  await assert.rejects(createHttpLibraryClient({ fetch: async () => new Response('not json') }).listSkills(alice), { code: 'UNAVAILABLE' });
  assert.throws(() => createLibraryHttpHandler({ library: s.library } as never), /resolveActor/);
});

test('two HTTP/SSE clients: publication authority, external log polling, replay, teams, reconnect, cancellation', async t => {
  const s = await setup(); t.after(s.close);
  const instances: TestSource[] = []; const a: SkillUpdateEvent[] = []; const b: SkillUpdateEvent[] = []; const blue: SkillUpdateEvent[] = [];
  let opens = 0;
  const subscribe = (actor: Actor, events: SkillUpdateEvent[]) => createSseSkillUpdateSource({ baseUrl: s.baseUrl, EventSource: eventSource(actor.userId, instances) }).subscribe(actor, { onUpdate: e => events.push(e), onReconnect: () => { opens++; } });
  const stops = [subscribe(alice, a), subscribe(bob, b), subscribe(eve, blue)]; t.after(() => stops.forEach(stop => stop()));
  await until(() => opens === 3);
  const client = s.client('alice');
  await client.saveDraft(alice, { draftId: 'draft', expectedRevision: 1, content: s.content });
  await client.previewDraftUpdate(alice, { draftId: 'draft', expectedRevision: 1, content: s.content });
  await client.applyDraftUpdate(alice, { draftId: 'draft', expectedRevision: 1, targetVersionId: null, confirmationToken: 'token', resolvedContent: s.content, idempotencyKey: 'sync' });
  await assert.rejects(client.publishDraft(alice, { ...publishInput, changeSummary: 'invalid' }), { code: 'VALIDATION' });
  await delay(50); assert.equal(a.length, 0); assert.equal(s.log.length, 0);
  await client.publishDraft(alice, publishInput); await client.publishDraft(alice, publishInput);
  await until(() => a.length === 1 && b.length === 1); assert.equal(blue.length, 0); assert.equal(s.log.length, 1);
  // An out-of-band append models another process; no adapter callback is involved.
  s.publish(eve); s.publish(alice);
  await until(() => a.length === 2 && b.length === 2 && blue.length === 1);
  assert.deepEqual(a.map(e => e.sequence), [1, 3]);
  instances[1].controller.abort(); await delay(25); s.publish(alice); s.publish(alice);
  await instances[1].reconnect(); await until(() => b.length === 4 && opens === 4);
  assert.deepEqual(b.map(e => e.sequence), [1, 3, 4, 5]);
  const replay: SkillUpdateEvent[] = [];
  const stopReplay = createSseSkillUpdateSource({ baseUrl: s.baseUrl, afterSequence: 3, EventSource: eventSource('alice', instances) }).subscribe(alice, { onUpdate: e => replay.push(e), onReconnect() {} }); t.after(stopReplay);
  await until(() => replay.length === 2); assert.deepEqual(replay.map(e => e.sequence), [4, 5]);
  stops[0](); stops[0](); const count = a.length; s.publish(alice); await until(() => b.length === 5); assert.equal(a.length, count); assert(instances[0].closed);
  s.identities.delete('bob'); await delay(60); s.publish(alice); await delay(60); assert.equal(b.length, 5);
  s.handler.close(); await delay(40);
  const calls = s.calls.length; await delay(50); assert.equal(s.calls.length, calls);
});

test('SSE cursor validation and revoked identity never starts a stream', async t => {
  const s = await setup(); t.after(s.close);
  for (const after of ['-1', 'abc', '9007199254740992']) assert.equal((await s.authFetch('alice')(`${s.baseUrl}/api/events?after=${after}`)).status, 400);
  assert.equal((await fetch(`${s.baseUrl}/api/events`)).status, 403);
  assert.equal((await s.authFetch('alice')(`${s.baseUrl}/api/events`, { headers: { 'Last-Event-ID': 'bad' } })).status, 400);
});

test('explicit routes cover all v2 methods through browser-safe HTTP client', async t => {
  const s = await setup(); t.after(s.close); const c = s.client('alice');
  assert.equal((await c.createSkill(eve, { name: 'test', description: '', maintainerIds: [], content: s.content })).skill.teamId, 'red');
  assert.equal((await c.setMaintainers(alice, 'skill', [])).id, 'skill');
  assert.deepEqual(await c.listVersions(alice, 'skill'), []);
  await assert.rejects(c.getVersion(alice, 'missing'), { code: 'NOT_FOUND' });
  assert.deepEqual(await c.compareVersions(alice, 'a', 'b'), []);
  assert.equal((await c.createDraft(alice, 'skill')).authorId, 'alice');
  assert.equal((await c.getDraft(alice, 'draft')).authorId, 'alice');
  assert.equal((await c.catalogSnapshot(eve)).teamId, 'red');
  assert.deepEqual(await c.listUpdateEvents(alice, 0), []);
  assert.deepEqual(await c.listAudit(alice), []);
});

test('client rejects malformed events, filters foreign teams and ignores queued callbacks after unsubscribe', () => {
  let instance: FakeSource;
  class FakeSource implements EventSourceLike {
    listeners = new Map<string, (event: {data?: string}) => void>(); closed = false;
    constructor() { instance = this; }
    addEventListener(type: string, callback: (event: {data?: string}) => void) { this.listeners.set(type, callback); }
    removeEventListener(type: string) { this.listeners.delete(type); }
    close() { this.closed = true; }
  }
  let opens = 0; let errors = 0; const updates: SkillUpdateEvent[] = [];
  const stop = createSseSkillUpdateSource({ EventSource: FakeSource }).subscribe(alice, { onUpdate: e => updates.push(e), onReconnect: () => opens++, onError: () => errors++ });
  const send = instance!.listeners.get('skill.updated')!; const open = instance!.listeners.get('open')!;
  open({}); open({}); assert.equal(opens, 2);
  send({ data: 'broken' }); send({ data: '{}' }); assert.equal(errors, 2);
  const f = fixture(); f.publish(eve); f.publish(alice);
  f.log.forEach(e => send({ data: JSON.stringify(e) })); assert.equal(updates.length, 1);
  stop(); send({ data: JSON.stringify(f.log[1]) }); open({});
  assert.equal(updates.length, 1); assert.equal(opens, 2); assert(instance!.closed); assert.equal(instance!.listeners.size, 0);
});

test('SSE defense filters a faulty cross-team log and Last-Event-ID wins over older query cursor', async t => {
  const s = await setup(); t.after(s.close);
  s.publish(alice); s.publish(eve); s.publish(alice); s.publish(alice);
  s.library.listUpdateEvents = async () => [...s.log].reverse();
  const abort = new AbortController(); t.after(() => abort.abort());
  const response = await s.authFetch('alice')(`${s.baseUrl}/api/events?after=1`, { headers: { 'Last-Event-ID': '2' }, signal: abort.signal });
  const reader = response.body!.getReader(); let text = '';
  while (!text.includes('id: 4\n')) { const part = await reader.read(); assert(!part.done); text += new TextDecoder().decode(part.value); }
  assert(!text.includes('id: 1\n')); assert(!text.includes('"teamId":"blue"')); assert(text.indexOf('id: 3\n') < text.indexOf('id: 4\n'));
});

test('slow HTTP body times out and stalled SSE backpressure is bounded', async t => {
  const { request } = await import('node:http'); const { connect } = await import('node:net');
  const f = fixture(); let reads = 0;
  const huge = { id: 'event', sequence: 1, teamId: 'red', skillId: 's', versionId: 'v'.repeat(12 * 1024 * 1024), previousVersionId: null, createdAt: 'now' };
  f.library.listUpdateEvents = async () => { reads++; return [huge]; };
  const handler = createLibraryHttpHandler({ library: f.library, resolveActor: () => alice, bodyTimeoutMs: 25, backpressureTimeoutMs: 25, pollIntervalMs: 10 });
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const req = request({ host: '127.0.0.1', port: address.port, path: '/api/library/listSkills', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Skill-Library': '1' } });
  req.on('error', () => {}); t.after(() => req.destroy()); req.write('{');
  const [response] = await once(req, 'response'); assert.equal(response.statusCode, 400); response.resume(); req.end();
  const socket = connect(address.port, '127.0.0.1'); t.after(() => socket.destroy()); socket.on('error', () => {});
  await once(socket, 'connect'); socket.pause(); socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`);
  await until(() => reads === 1); await delay(150); assert.equal(reads, 1);
  // A stalled socket must be removed server-side, not remain waiting for drain forever.
  const count = await new Promise<number>((resolve, reject) => server.getConnections((error, n) => error ? reject(error) : resolve(n)));
  assert(count <= 1); // The completed HTTP keep-alive connection may still exist.
});

test('default accepts escaped 2 MiB text packages and preserves bounded actionable domain errors', async t => {
  const f = fixture();
  let failure: DomainError | undefined;
  const save = f.library.saveDraft;
  f.library.saveDraft = async (...args) => { if (failure) throw failure; return save(...args); };
  const handler = createLibraryHttpHandler({ library: f.library, resolveActor: () => alice });
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  t.after(async () => { handler.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const c = createHttpLibraryClient({ baseUrl: `http://127.0.0.1:${address.port}` });
  const content = { files: [{ path: 'SKILL.md', content: '\u0001'.repeat(2 * 1024 * 1024), mediaType: 'text/plain' }] };
  assert.equal((await c.saveDraft(alice, { draftId: 'draft', expectedRevision: 1, content })).authorId, 'alice');
  failure = new DomainError('RESOURCE_MISSING', '缺少引用资源 references/guide.md', { path: 'references/guide.md', expectedRevision: 7, stack: 'SECRET', sql: 'SECRET', issues: [{ path: 'SKILL.md', message: '引用不存在', cause: 'SECRET' }] });
  await assert.rejects(c.saveDraft(alice, { draftId: 'draft', expectedRevision: 1, content: f.content }), (error: unknown) => {
    assert(error instanceof DomainError); assert.equal(error.code, 'RESOURCE_MISSING'); assert.equal(error.message, '缺少引用资源 references/guide.md');
    assert.deepEqual(error.details, { path: 'references/guide.md', expectedRevision: 7, issues: [{ path: 'SKILL.md', message: '引用不存在' }] }); return true;
  });
  failure = new DomainError('VALIDATION', 'a'.repeat(5000));
  await assert.rejects(c.saveDraft(alice, { draftId: 'draft', expectedRevision: 1, content: f.content }), (error: unknown) => error instanceof DomainError && error.message.length === 1024);
});
