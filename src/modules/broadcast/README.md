# Broadcast transport v2

Independent Node >=24 TypeScript transport; no service, web or runtime implementation imports.
`npm ci`, `npm run typecheck`, `npm test` run from this directory.

## Entry points

- `./server.ts` (package `@skill-library/broadcast/server`): `createLibraryHttpHandler(options)` returns a Node `RequestListener`-compatible function with synchronous `close()`.
- `./client.ts` (package root or `/client`): `createHttpLibraryClient(options)` and `createSseSkillUpdateSource(options)`. This import graph contains only browser-safe code and shared contracts; Vite must use this entry, never `server.ts`.
- Source exports deliberately use TypeScript: Node >=24 can execute them directly; frontend bundlers transpile them.

```ts
import { createServer } from 'node:http';
import { createLibraryHttpHandler } from './server.ts';
const handler = createLibraryHttpHandler({
  library,
  resolveActor: request => hostAuthentication.resolveActor(request),
  pollIntervalMs: 1000,
});
const server = createServer(handler);
// At host shutdown: handler.close(); server.close();
```

`library` implements shared v2 `LibraryService`. `resolveActor` is mandatory and must derive identity from host-verified credentials, never from JSON arguments or unverified headers. It is called again during SSE polling and before event delivery. Throw `DomainError('FORBIDDEN', ...)` for absent/revoked credentials. The host must bound its own authentication/database operations; transport cancellation cannot forcibly interrupt promises owned by the host. No authentication provider or demo identity is installed.

Optional server limits: `allowedOrigins` (exact origin strings; default same origin only), `maxBodyBytes` (16 MiB; accommodates JSON escaping of a 2 MiB text package), `bodyTimeoutMs` (10 s), `pollIntervalMs` (1 s), `backpressureTimeoutMs` (10 s). Limits must be positive safe integers. `close()` aborts active streams/body reads and permanently disables the handler. It does not own the host HTTP listener or database.

## HTTP and browser identity

POST `/api/library/<method>` requires JSON `{args:[...argumentsExceptActor]}`, `Content-Type: application/json`, and `X-Skill-Library: 1`. Extra envelope fields are rejected. The fixed table exposes exactly the 16 shared v2 methods; legacy approval/proposal/merge endpoints and prototype/object properties return `NOT_FOUND`. Argument count is transport-validated; domain argument structure, authorization and invariants remain service responsibilities. Results are `{result: ...}`; errors are `{error:{code,message}}` with shared codes. Trusted DomainError user messages are retained up to 1024 characters, with a bounded allowlist of resource paths, field issues and revision/version identifiers in details. Stacks, causes, SQL and arbitrary details keys are discarded. Hosts must put only user-safe text in DomainError messages; unknown exceptions receive fixed Chinese messages.

Every POST, including read RPCs, enforces the custom header and same-origin/explicit allowed-origin policy. Requests without `Origin` (same-origin browsers and non-browser tools) still require the custom header, and `Sec-Fetch-Site: cross-site` without Origin is rejected. Allowed cross-origin requests receive exact credentialed CORS headers and OPTIONS support; wildcard credentialed CORS is never emitted. Deploy behind a host that validates Host and TLS termination consistently; the adapter does not trust forwarded host/protocol headers. Explicit allowed origins can identify a TLS reverse-proxy frontend.

`createHttpLibraryClient({baseUrl?, fetch?})` implements `LibraryService`. It deliberately discards the interface's Actor argument, which is not an authentication credential. Default base URL is same origin and fetch credentials are `same-origin`. Hosts needing cross-origin credentials must provide a fetch wrapper and explicitly allow the frontend origin server-side. Tests inject a cookie-attaching fetch adapter; production browser code must use real host authentication.

## SSE

GET `/api/events?after=<nonnegative sequence>` authenticates before opening SSE. Resume cursor is the maximum of `after` and valid `Last-Event-ID`; invalid cursors return `VALIDATION`. Each frame has `event: skill.updated`, `id: sequence`, and shared `SkillUpdateEvent` JSON. Every poll queries persistent `library.listUpdateEvents(actor, cursor)`; no in-process publisher callback or draft mutation is an event source. Results are sorted, duplicate/older sequences skipped, and foreign-team or malformed events discarded defensively. The service must supply complete ordered replay (or successive oldest-first pages), durable monotonically increasing sequences, and team authorization.

A connection stays bound to its original authenticated user/team/role; revocation or identity change terminates it. Periodic comments keep idle streams active. Slow consumers wait for drain with a deadline, then the socket is destroyed; unsubscribe, peer close and handler shutdown cancel poll/drain timers. Failures after headers close the stream, letting native EventSource reconnect and reconcile state without disclosing exception text.

`createSseSkillUpdateSource({baseUrl?, afterSequence?, EventSource?})` returns shared `SkillUpdateSource`. Native browser EventSource uses host cookies (`withCredentials: true`), reconnects automatically, and sends Last-Event-ID. Injectable constructor supports test environments. `onReconnect` fires on **every** successful `open`, including initial connection; callers must requery current version. The source parses typed publication events and filters by the supplied actor's team, but Actor is only local context, never server authentication. Events do not mutate drafts. Duplicate/late event reconciliation remains the consumer's responsibility. Unsubscribe closes the connection, removes listeners and guards queued callbacks. Remount without a cursor replays from zero; callers may provide a persisted `afterSequence`, and should always reconcile authoritative state on open.

The host owns database retention and capacity limits. This scoped adapter does not add notification subscriptions, external notifications, session version switching, a production identity provider or an Agent execution adapter.
# 权限失效控制信号（production phase 4）

SSE 每轮及每个发布事件发送前重新验证用户、团队和角色。已建立连接发现 FORBIDDEN 时先发送 `event: access.revoked` / `data: {"code":"FORBIDDEN"}` 后结束连接，不再发送业务内容。浏览器适配器关闭 EventSource 并向 `onError` 传 DomainError FORBIDDEN；宿主产品应同步销毁旧 scope。此事件仅为连接权限控制，不是技能更新通知，不写持久发布事件。

网络错误仍传 UNAVAILABLE 并允许原生重连。初始握手拒绝没有 SSE 控制帧，产品在 error/reconnect 时使用身份 HTTP 核对权限；服务暂不可用不得当成注销。原工厂签名与 SkillUpdateSource 契约保持兼容。

