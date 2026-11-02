# Production 1–3 组合验收与合并

2026-11-01，在独立 production-acceptance worktree 从 main 0098e0f 合并已提交源码。用户明确授权验收合并，覆盖旧文档中管理端不合并的约定。没有推送、删除工作区或使用真实 OAuth 凭据。

## 纳入的提交

- 用户/团队：710cb91
- PostgreSQL：78da06f
- 完整产品：4139a46
- 依赖：service-v2 da980c1、runtime 1e9f02b、broadcast-v2 bb74c4a、web-v2 7990666。v1 历史已随 v2 纳入。

## 复验结果

Node 26.11.1、真实 PostgreSQL 17（本机 55432，测试随机 schema）、真实 Chrome。107 项测试通过、无跳过：既有契约/服务/运行时/Web/广播/发布组合 59；访客 HTTP 2 与界面 4；PostgreSQL 8；身份 15；产品组件 17；正式 HTTP 1 与 Chrome 1。身份、数据库、正式前端和生产服务器类型检查通过，正式 Vite 构建通过。已查看 390px 窄屏截图，无横向溢出。

复验命令（在仓库根目录，先安装模块依赖）：

```sh
npm test --prefix src
node --test src/integration/application.test.ts
(cd src/integration && ../modules/product/node_modules/.bin/vitest run --config vite.test.config.ts)
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test npm test --prefix src/modules/persistence
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test npm test --prefix src/modules/identity
npm run typecheck --prefix src/modules/persistence
npm run typecheck --prefix src/modules/identity
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test sh src/integration/verify-production.sh
```

## 验收修复

正式 HTTP 原设 1 MiB 限制，拒绝服务允许的 2 MiB 文本包；改用广播层有界 16 MiB JSON 限制，在真实 HTTP/PG 测试加入 2 MiB 换行文本（JSON 转义后更大）的创建和完整内容断言。包内容仍受数据库服务 2 MiB 校验。

所有模块同时安装时，访客测试出现 React 重复实例及不同 Vitest 实例的 matcher 注册问题。统一 React 解析，测试初始化移到 integration 自身，4 项回归复验通过。

正式验证脚本建立共享依赖入口；未提供 DATABASE_URL 立即退出，不能把数据库测试跳过当作验收成功。

## 尚未验证

真实 GitHub OAuth、HTTPS 公网部署、Docker 镜像、生产备份恢复、负载测试和真实 Agent 执行尚未验收。测试 OAuth 是显式 fixture。OAuth 临时 state 仍为实例内存，部署需单实例或登录回调粘性路由。以上不作为本次已完成事项。
