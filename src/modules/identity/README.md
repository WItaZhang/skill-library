# 正式用户与团队

公开契约见 `types.ts`。服务端入口 `index.ts`：`createIdentityService({pool, publicOrigin, github, mode?})`、`createIdentityHttpHandler({identity})`；浏览器入口 `client.ts`：`createIdentityClient({baseUrl?, fetch?})`；React 入口 `components.tsx`：`IdentityPanel`、`TeamPicker`、`TeamMembers`、`AcceptInvitation`。

只使用宿主注入的同一个 pg Pool；迁移及 production.ts 唯一来源是 production-database。服务不创建 Pool、不执行 DDL、不关闭共享池。生产默认模式要求 HTTPS publicOrigin、真实 GitHub clientId/clientSecret，缺失时启动失败；仅显式 mode:test 可注入测试提供方（不能当作真实 GitHub 验收）。

HTTP：GET `/api/identity/login`、GET `/api/identity/callback`、GET `/api/identity/session`；其余具名方法 POST `/api/identity/<method>`，JSON 为方法 input（listTeams/logout 用 `{}`）。响应 `{data:...}`；错误 `{error:{code,message}}`。handler 返回 Promise<boolean>，false 表示不属于该模块。callback 固定为 publicOrigin + `/api/identity/callback`，成功回 `/`，不允许任意跳转。

`resolveActor(req)` 从 HttpOnly 会话 Cookie 与 `X-Team-Id`（或 SSE 查询 teamId）解析，经数据库重新核验活跃用户、团队及成员；忽略请求 Actor/role。团队 ID 只是选择器，不是凭证。宿主所有写请求还须调用 `assertCsrf(req)`：校验精确 Origin 与 `X-CSRF-Token`；身份 HTTP handler 已内置。前端调用 session() 得到 csrfToken，后续写入携带；library HTTP 需同时带原有 X-Skill-Library:1。注销/身份切换时宿主必须销毁旧客户端、草稿缓存和 SSE。

session() 未登录返回 null；其他受保护调用抛 FORBIDDEN。邀请返回一次性 token，前端自行构造同源 `/?invitation=<token>` 供管理员复制，本轮不发送邮件。邀请接受要求当前 GitHub 已验证邮箱一致，不按 email 合并用户。成员管理仅 admin；最后管理员保护在团队行锁事务内执行。

测试与配置说明将记录于 docs/acceptance/production-identity.md。

## 组合示例

```ts
// pool 由宿主建立；先 await migrate(pool)，再将同一个 pool 传给身份与业务服务。
const identity = createIdentityService({
  pool,
  publicOrigin: process.env.PUBLIC_ORIGIN!,
  github: { clientId: process.env.GITHUB_CLIENT_ID!, clientSecret: process.env.GITHUB_CLIENT_SECRET! }
});
const identityHandler = createIdentityHttpHandler({ identity });
// HTTP 主入口：if (await identityHandler(req,res)) return;
// library 写操作：await identity.assertCsrf(req);
// library/SSE：resolveActor: identity.resolveActor
```

GitHub OAuth App 的 callback 必须精确配置为 `PUBLIC_ORIGIN/api/identity/callback`。实现针对 github.com，使用 state、S256 PKCE、固定令牌/用户/邮箱端点、15 秒超时，且禁止端点重定向。官方协议参考：[GitHub OAuth App 授权](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。访问令牌只在回调内使用，不保存。已有用户登录更新显示名与已验证邮箱，但不跨 provider/subject 合并。

HTTPS Cookie 使用 `__Host-` 前缀、Secure、HttpOnly、SameSite=Lax、Path=/，无 Domain。默认会话和邀请有效期均为 7 天；可用 sessionTtlMs/invitationTtlMs 改写。OAuth state 10 分钟，最多保留 10000 个待完成流程，绑定独立浏览器 Cookie，回调请求前消费以阻止并发重放。会话与邀请令牌均为随机 256 位，数据库只存 SHA-256。CSRF token 由会话令牌派生，不写非 HttpOnly Cookie。

待完成 OAuth state/PKCE verifier 暂存在服务实例内存；重启使待完成登录失效，需要重试。多实例部署须将 login/callback 路由到同一实例；没有跨进程 OAuth state 存储承诺。已建立会话及撤销状态在 PostgreSQL 中，跨实例读取有效。宿主应设置入口限流和请求超时；数据库过期记录清理由宿主运维负责。

SSE 长连接应定期重新调用 resolveActor（不能只在建连时校验）；团队切换须重建 EventSource，查询中带 teamId。前端 identity client 变更后重新 session()；身份切换时按用户 key 卸载组件。邀请 token 建议接收后从地址栏移除，并仅在当前浏览器 sessionStorage 中暂存以跨越 OAuth 跳转；callback 不接受任意 returnTo。接受后清除 token。本模块不持久化前端草稿或团队选择。

## 测试

```sh
npm ci --prefix src/modules/identity
npm --prefix src/modules/identity run typecheck
DATABASE_URL=postgresql://... npm --prefix src/modules/identity test
```

测试默认读取相邻 persistence/migrations/001-production.sql；独立 worktree 可设置 `IDENTITY_SCHEMA_FILE=/绝对路径/001-production.sql`。测试为每次运行建立随机 schema，设置 Pool search_path，结束时清理，只读取数据库所有者的 DDL。没有 DATABASE_URL 时数据库测试明确 skip；不能将其视为生产数据库验收。GitHub fixture 测试不代表真实账号授权成功。
