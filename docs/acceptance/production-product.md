# 正式技能管理与前端集成验收

任务 3 已实现：正式登录/团队选择/成员管理与邀请接受、技能创建、元信息修订冲突处理、作者草稿恢复、自动发布、历史比较、恢复为新草稿、归档/恢复、权限/错误/加载/空态、未保存输入保护、桌面和移动布局。列表、详情、编辑独立；正式流程没有演示按钮。任务页面接 PostgreSQL RuntimeService，归档后新任务不再收录技能，既有任务仍固定历史。

## 所属提交与依赖

本报告与 `src/modules/product/**`、`src/integration/**` 同提交；准确产品 SHA 见交付回复或 `git log -1 --format=%H -- src/modules/product`。未合并、推送或编辑 main，未启动代理；其他模块仅为只读复制的本地验收依赖，不包含在本提交。

| 依赖 | 已验收提交 |
| --- | --- |
| WItaZhang/production-database | 78da06f016ff87c3a7ec0d539890672640125743 |
| WItaZhang/production-identity | 710cb91bb5061b3817217263e8ee595944eacca0 |
| WItaZhang/skill-web-v2（公共 UI/更新面板） | 79906664e76f4d20c4cf8525f367b89dd0afcf15 |
| WItaZhang/skill-broadcast-v2 | bb74c4acb674119ecb100e4042e4407d2312d6ac |

统一使用数据库负责人 `contracts/production.ts`，没有第二份 DDL。`migrate(pool)`、`createPostgresLibraryService({pool})`、`createPostgresRuntimeService({pool})`、`createIdentityService({pool,...})` 使用同一个池。作者恢复使用新增 `listDrafts(actor,skillId)`；元信息与归档携带 expectedRevision。HTTP 路由固定白名单，可信 resolveActor 提供 Actor，宿主 POST 调用 assertCsrf。SSE 复用广播模块的每轮、每条消息前身份复核。

## 实际测试证据

2026-11-01，本机 Node 26.11.1、PostgreSQL 17、真实 Google Chrome headless：

- 产品 Vitest **17 项通过**：创建/保存/发布、元信息冲突保留输入并显式核对、历史比较恢复、归档恢复、作者草稿恢复、viewer 权限、SSE 更新不覆盖未保存内容、团队切换/退出保护、撤销成员清空编辑器、请求/缓存/SSE 身份隔离。
- 真实 HTTP + PostgreSQL **1 项完整流程通过**：两位测试提供方用户经真实 OAuth state/cookie/session HTTP 登录、邀请入队、创建和发布两版、真实 SSE 收取、版本比较、恢复草稿、作者过滤、元信息 409、归档恢复、新任务排除归档而旧任务固定、伪 Actor/跨团队/CSRF 拒绝、移除成员后 HTTP 403 和旧 SSE 断开。独立随机 schema，结束后清理。
- 真实 Chrome **1 项完整流程通过**：登录、建队、新建技能、保存发布 v1、修改名称、任务载入、拒绝离开保留输入、发布 v2、版本差异、恢复 v1 草稿、归档恢复；1440×1000 和 390×844 截图，窄屏无横向溢出。人工查看截图并修复账号区重叠。生成路径 `src/modules/product/test-results/{desktop,mobile}.png`（不提交运行产物）。
- 产品前端及生产服务器严格 TypeScript 检查、Vite 生产构建通过。
- 原访客模式回归：`application.test.ts` **2 项**、`Product.test.tsx` **4 项**通过。
- 从以上依赖提交重新导出到独立目录，执行 verify-production.sh 的 npm ci、17 项组件/客户端测试、类型检查、构建、真实 PG 与 Chrome 流程均通过。内存 fixture 仅用于组件测试，未冒充数据库或 OAuth 验收。

浏览器验收修复：发布增加 skill revision 后，详情必须重新 getSkill，避免正常编辑元信息误用旧修订；移动端账号区改为正常文档流；恢复旧版不复用先前 source 缓存。

## 复现

在产品提交工作树运行：

```sh
python3 src/integration/compose-production.py
```

脚本打印独立组合目录，记录 source-revisions.json，不改任何来源工作树。进入打印的目录后：

```sh
DATABASE_URL=postgres://skill_library@127.0.0.1:55432/skill_library_test sh src/integration/verify-production.sh
```

可换成自己的 PostgreSQL 数据库（测试角色需 CREATE SCHEMA 权限）。Chrome 默认 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，其他系统设置 CHROME_PATH。没有 DATABASE_URL 时两个真实测试明确 skip；不能将 skip 计为通过。

单独测试：

```sh
npm test --prefix src/modules/product
src/modules/product/node_modules/.bin/tsc -p src/integration/production-tsconfig.json
npm run build --prefix src/modules/product
DATABASE_URL=postgres://skill_library@127.0.0.1:55432/skill_library_test node --test src/integration/production.test.ts
DATABASE_URL=postgres://skill_library@127.0.0.1:55432/skill_library_test node --test src/integration/production.browser.test.ts
node --test src/integration/application.test.ts
(cd src/integration && ../modules/product/node_modules/.bin/vitest run --config vite.test.config.ts)
```

后两条访客回归需要冻结源码里的 service/runtime 本地依赖及 npm ci；正式组合不引入 SQLite 服务。

## 正式启动与边界

配置 DATABASE_URL、HTTPS PUBLIC_ORIGIN、GITHUB_CLIENT_ID、GITHUB_CLIENT_SECRET、可选 PORT 后执行 `node src/integration/production-start.ts`。GitHub callback 为 `${PUBLIC_ORIGIN}/api/identity/callback`。缺配置直接失败，不回落访客身份。邀请链接登录前存入当前标签页 sessionStorage，接受后清理。

没有真实 GitHub client credentials，**未验证真实 GitHub 授权**；所有 OAuth 流程测试明确使用仅 test 模式允许的提供方。未部署公网、未接真实 LLM/Agent。OAuth pending state 仍在身份服务实例内存，login/callback 须路由同实例；这不是跨实例登录验收。客户端每 15 秒及聚焦时核对成员，服务端请求和 SSE 持续强制鉴权；权限撤销时关闭旧编辑会话，未保存输入不会跨身份恢复。服务器保存的作者草稿仍可在重新获得合法权限后显式选择恢复。
