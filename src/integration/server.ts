import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { createLibraryService } from '../modules/service/index.ts';
import { createRuntimeService } from '../modules/runtime/index.ts';
import { createLibraryHttpHandler } from '../modules/broadcast/server.ts';
import { DomainError, type Actor } from '../contracts/index.ts';

interface Options { dataDir: string; webDir: string; publicOrigin: string; secureCookie?: boolean; maxWorkspaces?: number }
interface Visitor { token: string; team: string; expires: number; requests: number }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const runtimeMethods: Record<string, number> = { createSession: 0, createTask: 2, getTask: 1, createChildTask: 2, resolveSkill: 2, recordInvocation: 2, listInvocations: 1, getSessionUpdates: 1, setPreference: 1 };

export function createApplication(options: Options) {
  mkdirSync(options.dataDir, { recursive: true });
  const auth = new DatabaseSync(resolve(options.dataDir, 'visitors.sqlite'));
  auth.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS visitors(token TEXT PRIMARY KEY, team TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 0)');
  const library = createLibraryService({ databasePath: resolve(options.dataDir, 'library.sqlite') });
  const runtime = createRuntimeService({ databasePath: resolve(options.dataDir, 'runtime.sqlite'), host: library });
  const actorFor = (v: Visitor): Actor => ({ teamId: v.team, userId: '访客作者', role: 'contributor' });
  function visitor(req: IncomingMessage): Visitor {
    const raw = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('skill_demo='))?.slice(11);
    const v = raw && auth.prepare('SELECT * FROM visitors WHERE token=? AND expires>?').get(hash(raw), Date.now()) as Visitor | undefined;
    if (!v) throw new DomainError('FORBIDDEN', '演示工作区已过期，请刷新页面重新开始。');
    return v;
  }
  const transport = createLibraryHttpHandler({ library, resolveActor: req => actorFor(visitor(req)), allowedOrigins: [options.publicOrigin], maxBodyBytes: 65536 });
  function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
  async function body(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk); size += buffer.length;
      if (size > 65536) throw new DomainError('VALIDATION', '演示请求不能超过 64 KiB。');
      chunks.push(buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DomainError('VALIDATION', '请求格式无效。'); }
  }
  async function seed(actor: Actor) {
    const { draft } = await library.createSkill(actor, {
      name: '客户反馈分析', description: '把零散反馈整理为问题、证据与可执行的改进建议。', maintainerIds: [],
      content: { files: [{ path: 'SKILL.md', mediaType: 'text/markdown', content: '# 客户反馈分析\n\n1. 按问题主题归类反馈。\n2. 为每个主题列出原始证据。\n3. 按影响范围排序，并提出下一步行动。\n' }] },
    });
    await library.publishDraft(actor, { draftId: draft.id, expectedRevision: draft.revision, expectedBaseVersionId: draft.baseVersionId, changeSummary: '创建示例技能', idempotencyKey: randomUUID() });
  }
  const streams = new Map<string, number>();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const path = new URL(req.url || '/', 'http://localhost').pathname;
      if (path === '/healthz' && req.method === 'GET') { auth.prepare('SELECT 1').get(); return json(res, 200, { status: 'ok' }); }
      if (req.method === 'POST') {
        if (req.headers['x-skill-library'] !== '1' || (req.headers.origin && req.headers.origin !== options.publicOrigin) || req.headers['sec-fetch-site'] === 'cross-site') throw new DomainError('FORBIDDEN', '请求来源无效。');
        if (!req.headers['content-type']?.startsWith('application/json')) throw new DomainError('VALIDATION', '需要 JSON 请求。');
      }
      if (path === '/api/demo/bootstrap' && req.method === 'POST') {
        await body(req);
        let v: Visitor | undefined;
        try { v = visitor(req); } catch {}
        if (!v) {
          const count = auth.prepare('SELECT count(*) AS n FROM visitors').get() as { n: number };
          if (count.n >= (options.maxWorkspaces ?? 100)) return json(res, 503, { error: { code: 'UNAVAILABLE', message: '演示工作区容量已满，请稍后再试。' } });
          const raw = randomBytes(32).toString('hex');
          v = { token: hash(raw), team: randomUUID(), expires: Date.now() + 86400000, requests: 0 };
          auth.prepare('INSERT INTO visitors(token,team,expires) VALUES(?,?,?)').run(v.token, v.team, v.expires);
          try { await seed(actorFor(v)); } catch (e) { auth.prepare('DELETE FROM visitors WHERE token=?').run(v.token); throw e; }
          res.setHeader('Set-Cookie', `skill_demo=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${options.secureCookie ? '; Secure' : ''}`);
        }
        return json(res, 200, { result: { actor: actorFor(v), expiresAt: v.expires } });
      }
      if (path.startsWith('/api/')) {
        const v = visitor(req), actor = actorFor(v);
        if (req.method === 'POST') {
          if (v.requests >= 600) return json(res, 429, { error: { code: 'UNAVAILABLE', message: '此演示工作区已达到请求限额。' } });
          auth.prepare('UPDATE visitors SET requests=requests+1 WHERE token=?').run(v.token);
        }
        if (path === '/api/events' && req.method === 'GET') {
          if ((streams.get(v.token) ?? 0) >= 5) return json(res, 429, { error: { code: 'UNAVAILABLE', message: '打开的演示页面过多。' } });
          streams.set(v.token, (streams.get(v.token) ?? 0) + 1);
          res.on('close', () => { const left = (streams.get(v.token) ?? 1) - 1; if (left) streams.set(v.token, left); else streams.delete(v.token); });
          return void transport(req, res);
        }
        if (path.startsWith('/api/library/') && req.method === 'POST') return void transport(req, res);
        if (path.startsWith('/api/runtime/') && req.method === 'POST') {
          const method = path.slice('/api/runtime/'.length);
          if (!Object.hasOwn(runtimeMethods, method)) throw new DomainError('NOT_FOUND', '接口不存在。');
          const input = await body(req);
          if (!input || Object.keys(input).length !== 1 || !Array.isArray(input.args) || input.args.length !== runtimeMethods[method]) throw new DomainError('VALIDATION', '参数格式无效。');
          const result = await (runtime as any)[method](actor, ...input.args);
          return json(res, 200, { result });
        }
        if (path === '/api/demo/publish' && req.method === 'POST') {
          const input = await body(req);
          if (typeof input?.skillId !== 'string') throw new DomainError('VALIDATION', '请选择技能。');
          const colleague: Actor = { ...actor, userId: '演示同事' };
          const draft = await library.createDraft(colleague, input.skillId);
          const content = structuredClone(draft.content);
          const file = content.files.find(f => f.path === 'SKILL.md')!;
          file.content += `\n同事补充：分析时区分首次反馈和重复反馈。（${randomUUID().slice(0, 8)}）\n`;
          const saved = await library.saveDraft(colleague, { draftId: draft.id, expectedRevision: draft.revision, content });
          const result = await library.publishDraft(colleague, { draftId: saved.id, expectedRevision: saved.revision, expectedBaseVersionId: saved.baseVersionId, changeSummary: '演示同事补充分析要求', idempotencyKey: randomUUID() });
          return json(res, 200, { result });
        }
        throw new DomainError('NOT_FOUND', '接口不存在。');
      }
      if (!['GET', 'HEAD'].includes(req.method || '')) throw new DomainError('NOT_FOUND', '页面不存在。');
      const root = resolve(options.webDir), file = resolve(root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
      if (!file.startsWith(root + sep)) throw new DomainError('NOT_FOUND', '页面不存在。');
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new DomainError('NOT_FOUND', '页面不存在。');
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const known = error instanceof DomainError;
      if (!known) console.error('Request failed:', error instanceof Error ? error.message : 'Unknown error');
      json(res, known ? ({ FORBIDDEN: 403, NOT_FOUND: 404, VALIDATION: 400, STALE_REVISION: 409, CONFLICT: 409 } as any)[error.code] || 503 : 500,
        { error: { code: known ? error.code : 'UNAVAILABLE', message: known ? error.message : '服务暂时不可用。' } });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return { server, async close() { transport.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); runtime.close(); library.close(); auth.close(); } };
}
