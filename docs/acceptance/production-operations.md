# 6：上线与运维验收

2026-11-01（America/Los_Angeles）。独立 `WItaZhang/production-operations` worktree 开发；开始时 HEAD 为共同基线 `daa1e826a684efac988c5936ddb3fa6acc94310f`，`git merge-base --is-ancestor` 返回 0。完整阅读任务书及要求的架构/模块文档。没有改 main/他人 worktree，没有 merge/push、创建代理或创建外部资源。

## 源码与依赖

- 运维最终源码：`9ee8c23e5f433169ee8d3478e5e409315d8bf719`。前序提交 `b9ebb97`（宿主/部署/恢复）、`d534f63`（执行配置/worker错误监控）、`2e6f3bd`（正式进程与最终 UI 回归）。后续提交仅此报告和证据，不改变被验证源码。
- execution 源码：`ccb79ad192c25f15853e0046a7bc57f51243ded3`；含报告的交付 `403566aad75bdb72f98aa8af54871e6a47a3b972`。
- collaboration 源码：`78dd4d08cd936da509568426a01f4d489676fc6d`；含报告的交付 `2c081a20c41f7220468c8545a19ec7d65b620ba5`。
- 只读 `git archive` 导出另外两位已提交源码到新的临时组合目录；没有合并或把它们的文件提交到运维分支。记录见 [组合来源](../deployment/evidence/source-revisions.json)。实际最终组合路径记录在 [验证摘要](../deployment/evidence/validation.json)。

早期公布 [跨模块契约](../deployment/module-contract.md)，通过 [orchestration 技能](/Users/qianqian/.agents/skills/orchestration/SKILL.md) 的 Orca 原生会话地址定向对齐；worktree group 暂不能解析原生 chat，改为真实收件地址，不创建 DAG/代理。最终服务接口与协作浏览器 harness 均已共同复验。

## 实现完成

- 正式宿主同一 `pg.Pool` 注入 identity/persistence/execution；迁移成功才可 listen；没有 SQLite/演示认证回退。实际 execution factory、HTTP handler、start/stop 和安全 onError 已挂载；启用却缺 key/model 会启动失败，禁用时明确不可用。
- Node 24 多阶段生产 Dockerfile、非 root UID1000、只读根文件系统、健康检查、SIGTERM/限时关闭、SSE 与在途写请求分别排空。单实例 Compose、持久 PG17 volume、非 superuser 应用角色、Caddy HTTPS、精确代理信任。重部署不删库/volume。
- 环境校验与 env/_FILE secret 注入、HTTP request id、结构化错误/延迟、安全日志白名单、私有 Prometheus 指标、6 条故障规则及规则触发测试。不给 metrics/Caddy 管理端口公网入口；没有冒称已配置外部消息告警。
- IP API/登录/写入/执行成本、可信用户写入/执行成本、SSE 连接配额；不信任任意 X-Forwarded-For。计数器有界，用户预算跨团队，单实例边界公开。
- CI 强制模块 lockfile/typecheck/build、真实 PG/Chrome、全量恢复演练、镜像构建/非 root 启动/替换及代理/监控校验。`deploy.sh` 是已可审查的自动部署入口，无托管凭据时不尝试远端发布。
- 真正 pg_dump/pg_restore 到新库，全表行摘要+序列+业务语义核对。部署手册含每小时/14天备份策略、异机备份缺口、RPO/RTO目标、迁移fail-closed及新库回滚策略。

事务所有权不变：发布与接受执行请求同库事务，版本快照永久固定；外部执行在事务外，不承诺 exactly-once。恢复旧快照后先禁用 worker、核对远端请求，再显式处理不确定调用，避免盲目重放队列产生额外费用。

## 本地实证

最终在**干净提交组合**用官方 SHA256 校验的 Node **24.22.2**、真实 PostgreSQL **17.11**、实际 Chrome 跑发布检查。数据库测试随机 schema；恢复演练使用两座自动新建数据库，结束后清理，只剩原共享 PG 实例继续运行。测试 OAuth 是显式 testProvider；执行结果是标记清楚的 fixture。均不是外部真实账号/模型证据。

```sh
python3 src/integration/assemble-operations.py \
  --execution-ref ccb79ad --collaboration-ref 78dd4d0
# 在输出的临时组合根目录：
PATH=/tmp/production-operations-tools/node-v24.22.2-darwin-arm64/bin:$PATH \
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test \
DRILL_ADMIN_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test \
PG_BIN=/opt/homebrew/opt/postgresql@17/bin \
COLLABORATION_PORT=18764 \
DRILL_REPORT=/tmp/production-operations-final-drill.json \
sh src/integration/verify-release.sh
```

最终命令退出 0，**155 项测试通过、0 跳过**，全部模块类型检查及两个前端构建通过：

| 检查 | 通过数 |
| --- | ---: |
| 契约/旧服务/旧运行时/Web/广播/发布组合 | 59 |
| PostgreSQL persistence | 9 |
| identity | 15 |
| product | 21 |
| execution Node + React | 18 + 5 |
| operations 单元 | 5 |
| 访客 HTTP + React | 2 + 4 |
| 正式 HTTP + 运维 HTTP/PG + 正式子进程 | 1 + 6 + 1 |
| 正式桌面/窄屏 Chrome | 1 |
| collaboration 双 context/执行 UI | 8 |

正式进程测试使用真实 `production-start.ts`，占位配置不发 OAuth/模型网络调用；实际加载 execution 模块，未认证请求返回 403，数据库中 attempt 数为 0。两次 SIGTERM 正常退出0、重启保留数据。HTTP测试验证迁移校验失败不启动、断库 readiness503但healthz200、request id/日志脱敏、伪造转发头无法绕过、成本限流、SSE配额回收、旧任务固定版本恢复，以及关停不截断在途写响应。

曾发现并修复两个验收问题：新任务页已选择技能会要求离开确认，旧浏览器脚本需显式接受；Node24在SSE取消后可能留下未发送HTTP的替补TCP，默认closeIdleConnections不足，改为追踪socket活动状态，关闭空闲连接并保留在途响应。修复后专项复验及完整发布脚本均通过。没有用放宽超时或 skip 隐藏问题。

[原始最终运行日志](../deployment/evidence/verify-release.log)只来自测试fixture环境，含安全结构化请求日志；[验证摘要](../deployment/evidence/validation.json)记录命令、版本、分组结果、SHA及外部缺口。

## 备份恢复实证

[完整恢复报告](../deployment/evidence/backup-drill.json)来自真正 PG17 `pg_dump -Fc` / `pg_restore --exit-on-error --single-transaction --no-owner --no-acl`。数据涵盖用户/身份/成员、两版技能、作者未发布草稿、固定旧版任务及 execution_requests/execution_skills/execution_attempts/execution_results/execution_receipts；所有表及序列摘要一致。恢复后迁移checksum通过，业务读取固定版/草稿/结果一致，再发布v3成功。输出仅摘要与计数，不保存实际archive/secret/提示词。两座测试库都已删除。

耗时和规模以报告实测值为准，属于极小样本本地恢复，不能代表生产容量/RTO。计划每小时备份、保留14天，目标RPO≤1小时、RTO≤30分钟尚未经过生产负载验证；没有异机备份账号，未宣称完成异地灾备。

## 部署配置检查与外部缺口

官方下载并验证 SHA256 的 **Compose 5.6.1** `config --quiet` 通过；**Caddy 2.11.7** `validate` 通过；官方 SHA256 校验的 **Prometheus 3.13.5 LTS** `promtool check rules` 6规则、`test rules` 触发断言通过；全部 shell 语法检查、workflow YAML 解析通过。

本机无 Docker CLI/daemon。临时下载的是独立 Compose 配置校验工具，不能等同 Docker 引擎；**镜像 build/run 没有本地执行，GitHub CI 也没有被触发**（遵守不 push）。Dockerfile、smoke和workflow定义已完成，但这些验收仍要在有Docker的CI/目标机执行。

未完成的真实外部验收：公网 HTTPS/域名、真实两账号 GitHub OAuth、真实模型调用、容器实际部署/镜像启动、异机加密备份及外部告警通道。需要授权主机、DNS、OAuth client ID/secret，执行另需 Anthropic 服务端 key/model（必要时workspaceId）。没有读取个人开发工具凭据，没有用fixture冒充真实服务。

精确部署、配置/密钥、故障定位、备份周期、恢复/升级/回滚、公网最后验收步骤见 [部署运行手册](../deployment/runbook.md)。用户要求的“公网可用”保持未验收；已独立完成的工程和本地证据不因此搁置。
