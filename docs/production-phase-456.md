# Production phase 4–6 handoff

## 授权、基线与范围

用户要求：1–3 验收合并后，继续分发三个独立 worktree 开发 4–6。1–3 已合入 main e5c2989（组合修复）/12f363c（模块合并），107 项测试通过；当前新分支以包含本任务书的 main 为共同基线。用户目标是真实产品、general SDE 求职项目，可解释 Git 和数据库设计。使用中文产品文案，保持简洁 UI。

| 编号 | 任务 | 用户完成标准 |
| --- | --- | --- |
| 4 | 真实多人协作：两个账号同时编辑、更新提醒、差异处理、断线恢复、权限撤销 | 更新不丢输入；过期草稿不能发布；重连发现最新版 |
| 5 | 接入真实 Agent：关联任务、执行尝试、技能版本与结果 | 展示一次真实执行；重试与子任务保持原版本 |
| 6 | 上线运维：自动检查与部署、密钥管理、日志、错误监控、备份恢复、限流 | 公网可用；重部署保留数据；故障可定位；备份可恢复 |

架构确定为 PostgreSQL 模块化单体，共享宿主创建的 pg Pool，明确发布和接受任务事务边界。对象存储/外部消息队列只在确有需要时引入。当前业务 JSONB 配合生成列与关系约束，不应宣称所有业务字段都已拆为普通列；新增 execution 核心字段采用显式关系列，内容/提供方元数据才用 JSONB。不要把本轮扩展为无关的全库重写。

先读 src/AGENTS.md、docs/development-requirements.md、src/contracts/README.md、docs/acceptance/production-merged.md，以及 identity/persistence/product README。本任务书中的新授权优先于旧文档里仅 SQLite、无正式身份/真实执行、无部署的旧范围。各自独立实现、验证、提交；不要 merge/push、修改 main/他人工作区或删除分支，不再启动其他代理。只提交所属文件，保留工作区。完成后报告 SHA、实际命令/结果、接口、依赖 SHA 和未完成项。

## 目录所有权与协作

- production-collaboration（4）：src/modules/product/**、src/modules/identity/**、src/modules/broadcast/**、新增 src/modules/collaboration/**（端到端测试/验收 harness）、docs/acceptance/production-collaboration.md。拥有 Product/App 的最终 UI 集成；执行组件由 5 提供、由 4 挂载。不改 persistence、正式服务入口或已有 integration 测试。
- production-execution（5）：src/modules/execution/**、src/contracts/execution.ts、src/modules/persistence/**（仅执行相关增量与必要原子边界重构）、docs/acceptance/production-execution.md。唯一新增 DDL 所有者；不修改 001 已提交迁移，新增 002 及后续连续版本。React ExecutionPanel、客户端和 HTTP handler 放 execution 自有目录，不直接改 product/integration。不改变已发布 contracts/index.ts/production.ts 的兼容行为。
- production-operations（6）：src/modules/operations/**、src/deployment/**、src/integration/**、src/package.json、docs/deployment/**、docs/acceptance/production-operations.md。另明确授权 .github/workflows/** 作为 CI 必需例外；应用代码/部署配置仍在 src。拥有 production-server/start/http 的宿主挂载及 Docker/发布入口；不改业务模块/DDL/Product。保留已通过的 HTTP/浏览器/访客回归，避免重置分支内容。

各模块 manifest/lockfile 位于自身目录。需要跨目录修复，先把明确需求、接口/最小 patch 发给该 owner，由 owner 实施；其他工作区可只读参考，临时组合导出到自己临时目录，勿把别人文件纳入自己的提交。可用 Orca worktree list/terminal list 找到另外两位并定向沟通；先读 orchestration 技能和当前 CLI 指南，普通一对一接口通知不建立协调 DAG。本轮是完整交接，不要等待管理端持续轮询。

5 要尽早发布 execution README 和类型，4/6 读其接口后各自接入；不能等到最后才告诉对方工厂签名。4/6 同样尽早告知依赖要求。未完成的模块可用明确标记的测试适配器开发，但最终报告不得把适配器叫成真实集成。

## 4：多人协作

以已有真实 PG/身份/HTTP/SSE 为基线补齐浏览器双用户闭环，优先复现问题再修复，不重建一套模拟协作。使用两个隔离浏览器 context、独立 Cookie、同团队不同用户，浏览器流程必须走真实 HTTP/PG。

必须验证：A/B 从 v1 独立建草稿；B 有未保存输入时 A 发布 v2，B 收到提醒但输入不变；B 过期发布被拒并保留草稿；B 看基础/本地/最新三方差异，明确同步后发布 v3。无文本冲突仍需确认。预览后本地继续编辑/远端再发布/另标签保存时旧响应不得覆盖输入。覆盖同基线并发发布、幂等重试、连续/重复/乱序提醒、掉线间发布和重连核对、刷新恢复作者草稿、切换账号团队不串缓存、撤销成员/降权后读写和 SSE 失效。

身份失效后关闭旧工作区，不能为了保留输入继续暴露其他团队内容。真实 GitHub 两账号验收需要实际凭据与用户登录；显式 testProvider 的双账号端到端只算 HTTP/PG/浏览器证据，不能标为两个真实 GitHub 账号通过。缺凭据继续完成所有独立工作并给出精确最后验收步骤。

5 提供执行 UI/客户端后在现有任务页接入，显示实际任务、尝试、固定版本、结果与错误，保持列表/详情/编辑分开；不要向用户显示工程调试控件。4 的验收不因 5 的远端凭据缺失而停滞。

## 5：真实执行器与任务边界

在现有 RuntimeService 固定版本机制上接入至少一个实际可调用的 Agent/LLM 执行提供方；这是产品内真实执行适配，不能把当前开发代理或确定性 fixture 输出当作真实执行。可选择合适的常用 API/Agent SDK，查官方资料核实当前接口，保持 provider 注入。凭据只从服务端环境/secret 获取；不要读取/复制个人开发工具登录凭据用于服务器。现有可用且明确授权的服务凭据可做一次有界真实演示；没有凭据则把适配、错误处理、测试、UI 全部完成，明确真实演示未验收及缺哪个配置。

数据库表将执行请求、任务、尝试、结果关联，使用显式 team_id、task_id、owner_id、attempt number、status、timestamps、provider/model、provider request id、error code 等核心列；跨团队/任务 FK、唯一键、合理索引由库保障。沿用统一 migration ledger，不另建身份/运行时库。设计并记录状态机、幂等键、租约/并发领取与过期回收，防止迟到 attempt 覆盖新结果。现有永久任务快照和版本不可变。

接受新执行任务时，固定版本快照与待执行请求应在同一 PostgreSQL 事务提交（复用现有团队锁和权限检查）；若重构 RuntimeService，保持现有接口及回归。外部网络调用在事务外，不能持锁等待模型。区分数据库提交保证和远端调用边界，不承诺不可证明的 exactly-once；断开/超时无法确定远端结果时保留可追踪状态，避免盲目无限重试和额外费用。

每次执行从已接受任务固定版本解析完整资源，校验 checksum。重试是原任务新 attempt，子任务继承父快照；新用户任务才取最新版。权限在请求/领取/结果读取重验；撤销后停止后续执行和暴露结果。提供有限超时、取消、结果大小和调用次数限制。第一版执行器不执行用户上传脚本或任意 shell；任务文本/技能资源不能获得服务器密钥权限。

对外早发工厂/HTTP handler/browser client/React ExecutionPanel 与 lifecycle 协议，均从 execution 导出，由 6 注入同一 Pool/identity/runtime 并挂载，由 4 注入当前身份 scope 和挂载组件。不要占用其文件。提供真实 PG 下并发领取、重复请求、重试/子任务固定版本、崩溃恢复、迟到回包、权限撤销和错误测试，以及独立可复现真实演示命令。清楚区分 fixture tests 与真实提供方执行证据。

## 6：上线与运维

用户此前明确没有服务器，当前未提供托管账号、域名或真实 GitHub OAuth 配置。自主完成代码、部署产物和本地演练，再明确需要的外部配置；不要因无账号停止全部工作，不创建付费资源或擅自修改无关网站。配置已存在且授权范围明确时可执行相应部署；缺配置不称公网已上线。不 push 分支，提供 CI/部署定义与可审查部署步骤。

先保持单实例应用 + 持久 PostgreSQL（OAuth pending state 目前实例内存）。没有分布式 state 前不假称多副本登录可用。正式镜像从合并仓库构建，Node >=24、非 root、健康/就绪检查、优雅关闭、SSE 清理、迁移失败 fail closed，重部署不丢数据库；CI 实际运行类型检查、构建、真实 PG 和浏览器关键回归，缺依赖/配置要明确失败不能靠 skip 绿灯。

完成环境变量模板/校验、secret 注入说明、HTTPS/反向代理配置、日志 request id、结构化错误与延迟、最小可用错误监控/指标及故障定位手册。敏感 Cookie/token/邀请/完整提示词和结果默认不记录。限流覆盖登录、写入、执行成本、SSE 连接，身份与 IP 维度清楚，不能相信任意 X-Forwarded-For；按部署拓扑明确单实例或共享计数边界。向 5 提出执行限流/lifecycle 接口，宿主统一挂载。

真实执行 pg_dump/pg_restore 恢复到新临时库，核对用户/成员、版本、草稿、任务固定版本/执行记录；不触碰真实业务库。记录备份周期/保留、RPO/RTO 与迁移/回滚策略，区分目标和实测。Docker 如可用实际构建启动验证，缺 Docker 则报告并完成其他测试。提供一种明确可执行的部署路径，选择需查官方最新文档，不散列大量平台清单。

## 验收基线与资源

主基线详见 docs/acceptance/production-merged.md。生产验证：DATABASE_URL=... sh src/integration/verify-production.sh。本机之前存在独立 PG17 测试实例 postgresql://skill_library@127.0.0.1:55432/skill_library_test；先探活，测试随机 schema、执行结束清理，不能删别人的 schema 或停共享实例。也可 test-local.sh 创建独立 cluster，端口与其他任务错开。Chrome 可通过 CHROME_PATH 指定。每个独立 worktree 自行 npm ci；src/node_modules 统一链接由验证脚本建立。

新增文档需解释做法、事务边界和取舍，让用户能在面试中说清楚；不得只列 buzzwords。每份交付写清实现完成/本地验证/真实外部验证三者，并给出真实证据路径。不代用户把缺外部账号的完成标准判成通过。
