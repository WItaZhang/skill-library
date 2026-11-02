import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '../../contracts/index.ts';
import type { Actor, LibraryService, ErrorCode } from '../../contracts/index.ts';
import { isCode, isUpdate, messages, userMessage, safeDetails } from './protocol.ts';

export interface HttpHandlerOptions {
  library: LibraryService;
  /** Host-owned authentication, called again during every SSE poll and before delivery. */
  resolveActor: (request: IncomingMessage) => Actor | Promise<Actor>;
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
  bodyTimeoutMs?: number;
  pollIntervalMs?: number;
  backpressureTimeoutMs?: number;
}
export type LibraryHttpHandler = ((request: IncomingMessage, response: ServerResponse) => void) & { close(): void };
const status: Record<ErrorCode, number> = { FORBIDDEN: 403, NOT_FOUND: 404, STALE_REVISION: 409, CONFLICT: 409, VALIDATION: 400, RESOURCE_MISSING: 422, UNAVAILABLE: 503 };
const fail = (code: ErrorCode): never => { throw new DomainError(code, messages[code]); };
function cursor(value: string | undefined | null): number {
  if (value === undefined || value === null) return 0;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return fail('VALIDATION');
  return Number(value);
}
export function createLibraryHttpHandler(options: HttpHandlerOptions): LibraryHttpHandler {
  if (typeof options.resolveActor !== 'function') throw new TypeError('resolveActor is required');
  const { library, resolveActor } = options;
  const maxBytes = options.maxBodyBytes ?? 16 * 1024 * 1024;
  const bodyTimeout = options.bodyTimeoutMs ?? 10_000;
  const interval = options.pollIntervalMs ?? 1000;
  const drainTimeout = options.backpressureTimeoutMs ?? 10_000;
  for (const n of [maxBytes, bodyTimeout, interval, drainTimeout]) if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('Invalid transport limit');
  const connections = new Set<AbortController>();
  let closed = false;
  // The only dispatch table: no user-controlled property lookup on LibraryService.
  const entry = (fn: unknown, min: number, max = min) => ({ fn: (fn as (...args: unknown[]) => Promise<unknown>).bind(library), min, max });
  const routes = new Map([
    ['listSkills', entry(library.listSkills, 0, 1)], ['getSkill', entry(library.getSkill, 1)],
    ['createSkill', entry(library.createSkill, 1)], ['setMaintainers', entry(library.setMaintainers, 2)],
    ['listVersions', entry(library.listVersions, 1)], ['getVersion', entry(library.getVersion, 1)],
    ['compareVersions', entry(library.compareVersions, 2)], ['createDraft', entry(library.createDraft, 1, 2)],
    ['getDraft', entry(library.getDraft, 1)], ['saveDraft', entry(library.saveDraft, 1)],
    ['publishDraft', entry(library.publishDraft, 1)], ['previewDraftUpdate', entry(library.previewDraftUpdate, 1)],
    ['applyDraftUpdate', entry(library.applyDraftUpdate, 1)], ['catalogSnapshot', entry(library.catalogSnapshot, 0)],
    ['listUpdateEvents', entry(library.listUpdateEvents, 1)], ['listAudit', entry(library.listAudit, 0)],
  ]);
  async function authenticate(req: IncomingMessage): Promise<Actor> {
    const a = await resolveActor(req);
    if (!a || typeof a.userId !== 'string' || !a.userId || typeof a.teamId !== 'string' || !a.teamId || !['viewer', 'contributor', 'admin'].includes(a.role)) return fail('FORBIDDEN');
    return { userId: a.userId, teamId: a.teamId, role: a.role };
  }
  function origin(req: IncomingMessage, res: ServerResponse) {
    if (req.headers['sec-fetch-site'] === 'cross-site' && !req.headers.origin) fail('FORBIDDEN');
    const supplied = req.headers.origin;
    if (!supplied) return;
    const encrypted = 'encrypted' in req.socket && req.socket.encrypted;
    const same = `${encrypted ? 'https' : 'http'}://${req.headers.host}`;
    if (supplied !== same && !options.allowedOrigins?.includes(supplied)) fail('FORBIDDEN');
    if (supplied !== same) {
      res.setHeader('Access-Control-Allow-Origin', supplied);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
  }
  async function body(req: IncomingMessage, signal: AbortSignal): Promise<unknown[]> {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return fail('VALIDATION');
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      const cleanup = () => { signal.removeEventListener('abort', error); clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
      const error = () => { cleanup(); reject(new DomainError('VALIDATION', messages.VALIDATION)); };
      const aborted = () => error();
      const data = (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { error(); req.resume(); return; }
        chunks.push(chunk);
      };
      const end = () => {
        cleanup();
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!parsed || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.args)) return reject(new DomainError('VALIDATION', messages.VALIDATION));
          resolve(parsed.args);
        } catch { reject(new DomainError('VALIDATION', messages.VALIDATION)); }
      };
      const timer = setTimeout(() => { error(); req.resume(); }, bodyTimeout);
      signal.addEventListener('abort', error, { once: true });
      if (signal.aborted) { error(); return; }
      req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', aborted);
    });
  }
  async function events(req: IncomingMessage, res: ServerResponse, url: URL, initial: Actor, abort: AbortController) {
    let after = Math.max(cursor(url.searchParams.get('after')), cursor(typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined));
    const { signal } = abort;
    async function revalidate() {
      const current = await authenticate(req);
      if (current.userId !== initial.userId || current.teamId !== initial.teamId || current.role !== initial.role) fail('FORBIDDEN');
    }
    async function write(chunk: string) {
      if (signal.aborted) throw signal.reason;
      if (!res.write(chunk)) await once(res, 'drain', { signal: AbortSignal.any([signal, AbortSignal.timeout(drainTimeout)]) });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' });
    await write(': connected\n\n');
    while (!signal.aborted) {
      await revalidate();
      const updates = await library.listUpdateEvents(initial, after);
      await revalidate();
      for (const event of [...updates].sort((a, b) => a.sequence - b.sequence)) {
        if (signal.aborted) return;
        if (!isUpdate(event) || event.teamId !== initial.teamId || event.sequence <= after) continue;
        await revalidate();
        await write(`id: ${event.sequence}\nevent: skill.updated\ndata: ${JSON.stringify(event)}\n\n`);
        after = event.sequence;
      }
      await write(': heartbeat\n\n');
      await delay(interval, undefined, { signal });
    }
  }
  async function run(req: IncomingMessage, res: ServerResponse) {
    const abort = new AbortController();
    connections.add(abort);
    const stop = () => { abort.abort(); if (!res.writableEnded) res.end(); };
    res.once('close', stop);
    const terminate = () => { res.destroy(); };
    abort.signal.addEventListener('abort', terminate, { once: true });
    try {
      if (closed) fail('UNAVAILABLE');
      const url = new URL(req.url ?? '/', 'http://transport.invalid');
      const route = routes.get(url.pathname.replace(/^\/api\/library\//, ''));
      const isRpc = url.pathname.startsWith('/api/library/') && route;
      if (!(isRpc && (req.method === 'POST' || req.method === 'OPTIONS')) && !(url.pathname === '/api/events' && req.method === 'GET')) fail('NOT_FOUND');
      origin(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, X-Skill-Library' }); res.end(); return;
      }
      if (isRpc && req.headers['x-skill-library'] !== '1') fail('FORBIDDEN');
      const actor = await authenticate(req);
      if (url.pathname === '/api/events') { await events(req, res, url, actor, abort); return; }
      const args = await body(req, abort.signal);
      if (!route) return fail('NOT_FOUND');
      if (args.length < route.min || args.length > route.max) fail('VALIDATION');
      const result = await route.fn(actor, ...args);
      if (!abort.signal.aborted) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ result })); }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const code = error instanceof DomainError && isCode(error.code) ? error.code : 'UNAVAILABLE';
        res.writeHead(status[code], { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: { code, message: error instanceof DomainError ? userMessage(error.message, code) : messages[code], details: error instanceof DomainError ? safeDetails(error.details) : undefined } }));
      } else if (!res.writableEnded) res.destroy();
    } finally { connections.delete(abort); res.off('close', stop); abort.signal.removeEventListener('abort', terminate); abort.abort(); }
  }
  const handler = ((req, res) => { void run(req, res); }) as LibraryHttpHandler;
  handler.close = () => { closed = true; for (const connection of connections) connection.abort(); connections.clear(); };
  return handler;
}
