# 组合入口

从已合并仓库根目录执行 `DATABASE_URL=... sh src/integration/verify-production.sh`：安装依赖、准备共享模块解析、运行组件/真实 PostgreSQL/Chrome 验收并构建正式前端。需要 Node >=24、PostgreSQL 和本机 Chrome（可用 CHROME_PATH 指定）；数据库用户需 CREATE SCHEMA，测试使用独立 schema 后清理。

正式启动：设置 DATABASE_URL、HTTPS PUBLIC_ORIGIN、GITHUB_CLIENT_ID、GITHUB_CLIENT_SECRET，执行 `node src/integration/production-start.ts`。可设置 PORT，默认 8080。GitHub callback 为 PUBLIC_ORIGIN + /api/identity/callback。真实 GitHub 登录和公网部署尚待验证。

`start.ts` / `browser.tsx` 是独立访客演示入口；`production-start.ts` / modules/product 是正式用户产品入口。不要把访客服务器当作生产身份服务。历史 compose 脚本保留用于重现独立模块交付；已合并 main 可直接验证，无需导出旧分支。

验收细节：docs/acceptance/production-merged.md。
