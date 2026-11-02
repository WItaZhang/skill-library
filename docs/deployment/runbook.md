# 单实例上线与故障恢复

本轮交付能在合并仓库构建和部署的单实例产品。尚无服务器、域名、真实 GitHub OAuth 或模型凭据，不能据此宣称公网已上线。代码/本地验收/真实外部验收分别见 `../acceptance/production-operations.md`。

## 部署拓扑与边界

Internet → Caddy（80/443）→ 一个 Node 24 非 root 容器 → PostgreSQL 17 持久 volume。Prometheus 仅绑定宿主 `127.0.0.1:9090`；应用/数据库没有公网端口，`/metrics` 被 Caddy 拒绝且应用自身要求 Bearer secret。应用只信任 Caddy 在专用 bridge 中的固定 IP，Caddy 覆盖 `X-Forwarded-For` 为直连客户端地址。不能直接在前面加 CDN 后仍称原 IP 配额正确；改变拓扑需要重新设计和测试信任链。

OAuth pending state/PKCE 与限流计数均在单实例内存；重启会丢失未完成登录、重置配额。已建立会话、草稿、版本、任务和执行结果都在 PostgreSQL。不要 `--scale app=2`；第一版没有分布式计数/登录 state。每团队事务锁保证发布与接受执行任务的快照+执行请求同库提交；模型调用发生在提交之后，不持有事务锁。数据库提交不等于远端 exactly-once。

## 唯一推荐部署路径：Linux 主机 + Docker Compose

先由有权限的操作者准备 Linux 主机，安装 Docker Engine/Compose v2；域名 A/AAAA 指向该机，防火墙仅开放 SSH/80/443。不要求或自动创建付费资源。正式镜像必须从用户审查合并后的仓库构建，不从开发临时组合目录发布。

在仓库根目录：

```sh
# PG/Chrome 是本地或 CI 验收依赖，缺失直接失败。
DATABASE_URL=postgresql://... DRILL_ADMIN_URL=postgresql://... \
  sh src/integration/verify-release.sh
cp src/deployment/.env.example src/deployment/.env
node src/deployment/prepare-secrets.ts
```

编辑 `.env` 的 `APP_DOMAIN`、完全一致的 `PUBLIC_ORIGIN=https://...`、已合并 SHA 和 GitHub client ID。GitHub OAuth App callback 必须是 `PUBLIC_ORIGIN/api/identity/callback`。通过目标机 secret 管理方式填写 `secrets/github_client_secret`；启用执行时设 `EXECUTION_ENABLED=true`、`EXECUTION_MODEL`，填写 `secrets/anthropic_api_key`；非 workspace-scoped key 还需 `ANTHROPIC_WORKSPACE_ID`。禁用执行会在 API 明确返回未配置，不返回 fixture 输出。

`prepare-secrets.ts` 只生成本机 DB/metrics 随机 secret，不生成假 OAuth/模型配置，不覆盖已有文件。secret 目录为 0700；文件为 0444，使 Compose 文件挂载后的 app UID 1000/Prometheus UID 65534 可读，宿主依靠 0700 父目录限制访问。首次填写空 OAuth/provider 文件可先 `chmod 600`、填写再 `chmod 444`。父目录应归运行部署的受控账号；Compose 本地 secrets 是文件挂载，并非加密 secret store。禁止提交、打入镜像、打印 `DATABASE_URL` 或开启 `set -x`。宿主磁盘和备份必须有访问控制与加密。

```sh
sh src/deployment/deploy.sh
# 脚本：配置校验 → 构建 → secret 校验 → 数据库健康 → 升级前备份 → 单实例重建 → 等待就绪
```

PostgreSQL 初始化创建独立 `skill_library` 应用角色（无 superuser/createdb/createrole），只拥有业务库。迁移由应用在 listen 前运行；不符 ledger/checksum、未知版本或 DDL 失败，整个迁移事务回滚且启动失败。不要删 ledger 绕过检查。`deploy.sh` 不会 `down -v`，不重置数据库；同一 Compose project name 和 `pg_data` volume 保持数据。数据库初始化脚本仅在全新 volume 执行；修改 secret 文件不会自动更改已有 PG 密码。

Node 收到 SIGTERM 后 readiness=false，停止接入/执行领取、关闭 SSE、等待进行中的 RPC 和执行取消落库，再关闭共享 Pool。20 秒期限后失败退出；容器给予 25 秒。HTTP request/header 限制、资源体积校验仍保留。不可确定的远端尝试由执行模块标记 uncertain，不能无限自动重试。

CI `.github/workflows/production.yml` 在 PR/main/手动运行，强制全部模块 lockfile、类型检查、正式构建、真实 PG、双浏览器、全量备份恢复、非 root 镜像启动/替换及代理/告警配置检查。它不会因缺模块/Chrome/PG 跳过而绿灯，也不会替用户 push、发布镜像或连未授权主机。自动部署入口是 `deploy.sh`；当前没有目标主机 secret，远端部署任务尚未启用。

## 环境参数

| 参数 | 含义 |
| --- | --- |
| DATABASE_URL / DATABASE_URL_FILE | PostgreSQL 业务库，二选一；远程 PG 应使用验证 CA 的 TLS URL |
| PUBLIC_ORIGIN | 精确 HTTPS origin，无路径；测试提供方只能从测试 factory 注入 |
| GITHUB_CLIENT_ID/SECRET（支持 _FILE） | 真正 GitHub OAuth App；缺失拒绝启动 |
| METRICS_TOKEN（支持 _FILE） | 至少 32 字符；抓取器和应用共享，仅内网使用 |
| EXECUTION_ENABLED | true/false，默认 false；不通过 NODE_ENV 偷开测试认证 |
| ANTHROPIC_API_KEY（支持 _FILE）/EXECUTION_MODEL | 启用执行时必须；仅服务器读取 |
| ANTHROPIC_WORKSPACE_ID | 非 workspace-scoped 模型 key 所需的 workspace 选择器 |
| TRUSTED_PROXY_IPS | 逗号分隔精确直连代理 IP；默认空，忽略任意转发头 |
| PORT / PG_POOL_MAX / SHUTDOWN_TIMEOUT_MS | 默认 8080 / 10 / 20000；有范围检查 |
| RELEASE_SHA | 日志标识构建版本，不是业务密钥 |

启动日志只输出安全错误分类；`node src/deployment/validate-config.ts` 可定位缺哪个参数，绝不打印值。安装在容器外时共享依赖链接由 `install.sh` 建立。根 `npm --prefix src run start:production` 与容器使用相同入口。

## 日志、指标与故障定位

每次请求返回服务端生成的 `X-Request-Id`。JSON 日志记录时间、固定路由类别、方法、状态、耗时和安全错误类别；客户端 ID 不能注入日志。默认不记录完整 URL/query、Cookie/token、邀请、IP/用户信息、提示词、技能正文或模型结果。Caddy 不开 access log，并过滤错误日志的 request 字段。数据库本身的默认错误日志可能含失败 SQL；DB 日志也需严格访问控制，不能给用户返回或上传公开平台。

1. 获取响应 `X-Request-Id` 与故障时间，通过 `docker compose logs --since 10m app` 查对应记录。`http.error` 包括所有模块自行处理的 5xx；`request.failure`/`database.pool_error`/`database.unavailable` 补充安全错误码。
2. `/healthz` 是进程存活，不查数据库；`/readyz` 检查数据库、初始化/关闭状态。有 DB 故障时进程仍存活但就绪 503，不用反复重启掩盖数据库问题。
3. `docker compose ps` 检查健康；`startup.failed` + 未监听通常是配置或迁移，先执行 `docker compose run --rm --no-deps app node src/deployment/validate-config.ts`，再对照迁移 ledger 与发布 SHA。不要输出 secrets。
4. SSH 隧道查看 localhost:9090 的 Prometheus Alerts；包括抓取失败、未就绪、持续 5xx、数据库排队、非 SSE p95>2s。指标为有限路由标签，避免正文或用户 ID 的基数/隐私问题。
5. 429 返回 `Retry-After`；登录/写入/执行成本为固定 60 秒窗口，默认 IP API 600、登录/回调合计 15、写入 IP 180/用户 90、执行 accept/retry IP 30/用户 10；SSE IP 30/用户 6/全站 200。用户预算跨团队，不相信 body Actor。队列/attempt 上限和外部调用约束仍由 execution 执行。计数最多 20000 个 key，满时拒绝新 key，不能通过 churn 清空已有预算。

Prometheus 当前只有本地可见的规则告警，没有短信/邮件/Slack 投递，不把它称作有人值守的外部告警。需要用户选择并授权接收通道后才配置通知。应用日志默认轮转 5×10 MiB，指标保留 15 天；主机磁盘余量、数据库容量和外部 HTTPS 探测尚需部署后实测。

## 备份、恢复与回滚

`backup.sh` 真正调用 PG17 `pg_dump -Fc`，原子提交 archive 与 SHA256、检查 TOC，只清理其自有前缀下超过 14 天的完成备份。Compose 的 backup 工具容器没有公网端口。建议每小时执行，目标 RPO≤1 小时，目标 RTO≤30 分钟；这两个是部署运行目标，不是本地小样本演练可证明的生产 SLA。

目标机配置 cron（替换实际仓库路径；限制日志目录访问）：

```cron
0 * * * * cd /opt/skill-library/src/deployment && docker compose --profile tools run --rm backup >> /var/log/skill-library-backup.log 2>&1
```

备份包含提示词/结果/身份信息，不能提交 Git。主机内 14 天备份不能抵御整机丢失：上线前必须选择用户授权的异机加密存储，复制 archive+sha，核对复制结果、备份年龄并定期演练。此轮未配置外部存储，不宣称已有异地灾备。`pg_dump` 是一个一致数据库快照，不是 PITR/WAL 连续归档，不包含 cluster roles。

真实恢复演练（不接触现有业务库）：

```sh
PG_BIN=/path/to/postgresql17/bin \
DRILL_ADMIN_URL=postgresql://test-admin@127.0.0.1:55432/test_db \
DRILL_REPORT=/tmp/full-restore-report.json \
node src/modules/operations/backup-drill.ts
```

工具只创建随机 `ops_drill_source_*`、`ops_drill_restore_*` 两座新库；从应用服务产生两位用户、版本、未发布草稿、旧版固定任务和明确 fixture 执行请求/attempt/result。真正 pg_dump/pg_restore 到空库，核对所有普通表逐行摘要、序列、迁移 checksum，再通过业务服务读取固定版本、草稿、执行结果并发布新版本。finally 只删除自己创建的两座库。默认缺 execution 直接失败；`--base-only` 只是独立基线证据，不能替代最终恢复验收。

生产恢复采用新库切换，禁止 `pg_restore --clean` 覆盖正在服务的库：停止 app 和外部写入 → 验证 archive SHA → 在原集群或新集群创建新空库、授予同一个非特权应用角色 → `pg_restore --exit-on-error --single-transaction --no-owner --no-acl --role=skill_library -d 新库 archive.dump` → 用匹配代码验证迁移/用户成员/版本 checksum/草稿/固定任务/执行记录 → 修改受控 DATABASE_URL secret 指向新库 → **保持 EXECUTION_ENABLED=false** 启动读写核对 → 人工处理执行恢复边界后开启 worker。

恢复的是过去时间点：备份后的远端模型调用可能已经付费完成，而恢复库仍是 queued/running。不能把所有 queued 自动重新执行；先对照提供方请求记录和恢复前业务记录，取消/隔离不能确认的旧队列，running 由 recover 标记 uncertain，用户明确确认风险后重试。上线恢复流程必须保留这一人工决策，否则数据库回滚可能产生额外调用费用。

升级前备份，并记录旧 image SHA/新 image SHA/迁移版本。只有 schema 明确兼容才可切旧 image；当前 migration runner 会拒绝数据库存在代码不知道的新版 ledger，不能声称任意降级可用。无自动 down migration；回滚需要匹配旧库备份恢复到新库后切换，会丢失备份后的写入。优先修复前进迁移。不要删除 volume 或 migration ledger。

## 公网最后验收

需要用户提供/授权主机、域名 DNS、真实 GitHub OAuth App，执行演示另需模型 key/model。按上文部署后记录：公网 HTTPS/证书和安全 Cookie、真实两个 GitHub 账号登录/邀请/双用户编辑/SSE、真实执行（有界调用）、容器替换后已存数据与任务版本不变、实际故障指标告警、异机备份取回恢复。没有这些证据时对应验收项保持未验收。

## 官方依据（2026-11-01 核实）

使用 [Compose 健康依赖](https://docs.docker.com/compose/how-tos/startup-order/)、[Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/) 和 [PostgreSQL 官方镜像初始化规则](https://hub.docker.com/_/postgres)。HTTPS/SSE/代理转发参考 [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)，过滤日志参考 [Caddy log](https://caddyserver.com/docs/caddyfile/directives/log)。恢复单事务参考 [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)。监控采用官方当前 [Prometheus LTS 3.13.5](https://prometheus.io/download/)，配置参考 [Prometheus configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)。镜像大版本 tag 会变化；正式发布应记录实际 digest，升级前重复 CI/恢复演练。
