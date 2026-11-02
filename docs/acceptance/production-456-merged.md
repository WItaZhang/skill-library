# Production 4–6 组合验收与合并

2026-11-02。用户授权“开发完了么，验收合并”。从 main daa1e82 建立独立 production-456-acceptance 工作区，合并三个已提交分支，无代码冲突。保留源分支/工作区，不 push、不修改主工作区既有未跟踪文件。

## 纳入源码

| 任务 | 分支交付提交 | 验收结论 |
| --- | --- | --- |
| 多人协作 | 2c081a20c41f7220468c8545a19ec7d65b620ba5 | 实现与本地双 context HTTP/PG/Chrome 通过；真实 GitHub 双账号待验收 |
| 任务执行 | 403566aad75bdb72f98aa8af54871e6a47a3b972 | 提供方适配、任务/尝试/结果、恢复与隔离通过；真实模型调用待验收 |
| 上线运维 | d39ba2f（完整 SHA 见下方证据 JSON） | CI/部署配置、日志限流、进程重启与数据库恢复通过；镜像/公网待验收 |

合并源码检查点 1e92c42，随后本工作区补充执行 HTTP 边界修复。最终合并提交由 git log 给出，不在本文件自引用。

## 亲自复验

官方 Node 24.22.2、本机真实 PostgreSQL 17.11、真实 Chrome。测试使用独立 schema，备份演练使用两座临时库并清理，未触碰业务库或停共享实例。

```sh
PATH=/tmp/production-operations-tools/node-v24.22.2-darwin-arm64/bin:$PATH \
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test \
DRILL_ADMIN_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test \
PG_BIN=/opt/homebrew/opt/postgresql@17/bin COLLABORATION_PORT=18784 \
DRILL_REPORT=/tmp/skill-456-backup-drill.json \
sh src/integration/verify-release.sh
```

命令退出 0：**155 项通过、0 失败、0 跳过**；全部模块/集成类型检查、正式与原 Web 构建通过。覆盖双用户输入保护、过期拒绝、差异同步、断线重连、撤权、并发领取、崩溃/不确定执行恢复、重试及子任务固定版本、限流/日志脱敏、正式子进程关闭/重启。

真实 pg_dump/pg_restore 后核对全表与序列摘要、版本/草稿/任务/执行结果，再发布新版成功。小样本本地总耗时 273ms，只证明此测试数据恢复成功，不代表生产 RTO。已查看新生成的 390px 任务详情截图，内容可读且无横向溢出。

完整日志保留 /tmp/skill-456-release.log；计数与摘要见同目录 production-456-evidence.json。前序模块报告中的历史日志不是本次亲自运行的替代。

## 合并前修复

执行 HTTP 限制为 32 KiB，而合法的 16 KiB decoded prompt 经 JSON 转义最多膨胀约六倍。新增真实 HTTP/PG 断言复现“任务内容过大”，提高有界 JSON 传输限制为 128 KiB；服务和数据库的正文 16 KiB 限制保持不变。验证最大合法正文可完整读取，超一字节仍返回 VALIDATION。该边界测试不调用远端模型。

修复后重新运行 execution 全部 18 项及类型检查，全部通过，0 跳过。完整 155 项检查是在修复前的合并源码完成；最终改动涉及的 execution 测试已专项复验，不重复计为新增 18 项。另清理两处文件末尾空行，git diff --check 通过。

审查了发布/执行共用事务、租约与迟到结果保护、提供方协议、部署/密钥/限流/关闭路径。Anthropic 鉴权和版本请求头与 [官方 Messages API](https://platform.claude.com/docs/en/api/messages/create) 对照一致；这不是实际外部调用证据。

## 保留的外部验收缺口

- 真实两个 GitHub 账号登录、邀请和协作：需 OAuth client 配置、真实账号与 HTTPS origin。
- 真实模型执行：需服务端 ANTHROPIC_API_KEY、EXECUTION_MODEL（必要时 workspace id）。现有结果均明确 fixture，不称真实执行成功。
- Docker 镜像 build/run、GitHub CI 实际运行、公网 HTTPS/域名和容器上线：本机无 Docker，引擎和部署账号未提供；没有 push 触发 CI。
- 异机加密备份、外部告警通道、生产容量恢复和负载：未完成，详见部署手册。

因此本次批准合并的是工程实现与已验证的本地集成；用户提出的“真实执行、公网可用”完成标准仍待外部验收。部署路径与最后配置见 docs/deployment/runbook.md。
