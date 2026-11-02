# 正式用户与团队验收

2026-11-01，production-identity 独立工作区。仅提交 `src/modules/identity/**` 与本报告；未合并、推送、修改 main 或其他工作区。提交 SHA 由最终交付消息给出（避免在提交内部自引用 SHA）。

## 实现与公开接口

- `createIdentityService({pool,publicOrigin,github,...})`：GitHub OAuth state/PKCE、按 provider+subject 建立身份、会话轮换与注销持久撤销、用户/团队状态检查。
- `session/login/logout/resolveActor/assertCsrf/createTeam/listTeams/invite/accept/listMembers/changeRole/removeMember` 具名契约见模块 `types.ts`。
- `createIdentityHttpHandler({identity})` 以 Promise<boolean> 标记是否处理请求；固定方法白名单、16 KiB JSON 上限、错误不暴露底层数据库或凭证。
- `createIdentityClient()` 和 `IdentityPanel/TeamPicker/TeamMembers/AcceptInvitation`：中文身份、团队切换/创建、邀请、角色与成员移除；加载/错误态、失败保留输入、旧团队请求隔离。
- 浏览器提供 teamId 作为选择器；Actor 用户及角色从数据库确定，服务不接受前端 Actor。角色修改/移除先锁团队行，再核验权限与最后管理员。移除成员同时失效其待接受邀请以及该成员发出的待接受邀请。

README 与 types.ts 在实现初期已向 production-product 定向发布，随后补充组件 props 和接入规则。产品层负责业务路由调用 assertCsrf、持续重验 SSE、身份切换清理缓存与保存邀请 token。

## 数据库对齐

唯一 schema 来源：`WItaZhang/production-database` 的 `src/modules/persistence/migrations/001-production.sql`；已只读核对 `src/contracts/production.ts` 和 persistence README。数据库代理发布的 `migrate(pool)` 与 `createPostgresLibraryService({pool})` 由宿主组合。身份模块无 DDL、无 Pool 创建或关闭（仅测试自己建立测试 Pool）。users.email 可空且不唯一，不做按邮箱自动合并。身份表角色/status/UUID/timestamptz 完全按该 DDL。

验收时数据库模块仍在开发，未锁定其最终提交 SHA；测试每次直接读取其已发布实际 001 SQL，不固定未定稿迁移 checksum。模块独立依赖及 lockfile 已纳入提交。

## 实际执行证据

环境：Node.js 26；真实 PostgreSQL 17，本机临时独立 cluster，127.0.0.1:55432。测试为每次运行创建随机 schema、隔离 search_path，结束清理，未用内存数据库替代。HTTP 测试通过真实 Node HTTP 服务与 fetch Cookie jar，React 通过 jsdom 交互与 SSR 验证。

```sh
npm ci --prefix src/modules/identity
npm --prefix src/modules/identity run typecheck
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test \
IDENTITY_SCHEMA_FILE=/Users/qianqian/orca/workspaces/skill-library/production-database/src/modules/persistence/migrations/001-production.sql \
npm --prefix src/modules/identity test
git diff --check
```

结果：严格 TypeScript 检查通过；15 项测试通过，0 失败、0 跳过。覆盖：

- 生产缺 OAuth 凭证、配置测试 provider、HTTP 来源均 fail closed。
- OAuth state 浏览器绑定、伪造、重放、过期、取消授权；PKCE 请求与 verifier、固定可信 callback。
- HttpOnly/SameSite/Path Cookie 与 HTTPS Secure/__Host 标志；会话轮换、过期、账号停用、注销后跨服务实例持续撤销。
- Origin/CSRF 拒绝、伪造 Actor、非法方法、正文上限；跨团队读写拒绝。
- 邀请仅存摘要、邮箱一致性、未验证邮箱拒绝、过期、并发单次接受与重放；相同邮箱不同外部身份不合并。
- 最后一位管理员移除/降权拒绝；两个管理员并发自降权恰有一次成功。
- 成员移除即时失去团队 Actor 与列表访问，原会话不能绕过，新旧邀请行为受控；团队停用拒绝。
- React 团队切换不显示旧异步结果、邀请失败保留输入、新建团队、单次接受和注销反馈。

## 配置缺口与验收边界

尚无真实 GitHub client ID/secret，未执行两真实 GitHub 用户 OAuth 授权。GitHub HTTP 适配测试是显式 fixture，不能称为真实提供方验证。生产启动需要 HTTPS PUBLIC_ORIGIN 与 GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET，并在 GitHub OAuth App 配置精确 callback。

OAuth 待完成流程使用有界实例内存，跨实例需登录/回调亲和路由；重启后用户重新发起登录。会话与撤销使用共享 PostgreSQL，不受该临时状态限制。未宣称多实例 OAuth state 共享、真实 TLS 浏览器验收、公网上线或完整产品浏览器闭环；产品组合由 production-product 承接。未新增邮件发送。
