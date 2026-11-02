# 生产阶段 5：任务执行验收

2026-11-01（America/Los_Angeles）。Owner：`production-execution`。本轮开发、测试和提交均在独立 worktree 内完成；没有修改 main、其他 worktree、既有 001 迁移或 product/integration 文件，没有 merge/push 或创建其他代理。

## 结论与提交

- **实现完成**：真实 Anthropic Messages API 适配、PostgreSQL 执行请求/尝试/结果、原子接受任务、有限执行、重试/子任务版本固定、租约恢复、权限与取消、HTTP/client/React 任务面板均落地。
- **本地验证通过**：92 项（59 既有回归 + 9 persistence + 18 execution + 5 UI + 1 正式任务页 Chrome），无跳过；execution/persistence 类型检查与组合产品构建通过。提供方测试全部显式标注 fixture/fake fetch。
- **真实外部验证未通过验收**：当前服务环境未提供 `ANTHROPIC_API_KEY` / `EXECUTION_MODEL`，没有向真实模型发请求、没有展示真实模型执行结果。`npm run demo` 明确退出 1；不能把下面的测试证据称为真实 Agent 执行。真实 OAuth 与公网部署由 4/6 分别交付，不在此虚报。

进入任务时 `HEAD=daa1e826a684efac988c5936ddb3fa6acc94310f`，`git merge-base --is-ancestor` 成功。代码最终提交 `ccb79ad192c25f15853e0046a7bc57f51243ded3`，此前按交接先发布 `9011052` 接口/实现，再提交 `87b13ca` 完整测试、`c99f135` 输入保护修复；此报告随后的提交只添加验收记录/证据。

生产模块依赖共同基线的 identity/persistence/runtime；HTTP 宿主和 Product 最终挂载属于 6/4。本轮亲自执行的临时组合固定：collaboration `78dd4d08cd936da509568426a01f4d489676fc6d`、operations `b9ebb9763c430e904da94eb4d3f4cf90c666c43b`、execution `ccb79ad192c25f15853e0046a7bc57f51243ded3`。这些模块通过只读导出到临时目录组合，没有纳入本分支提交。

## 事务与数据库设计

002 在统一 `production_migrations` ledger 中执行，保持 checksum/连续版本验证，001 字节不变。新增以下关系：

| 表 | 含义与约束 |
| --- | --- |
| execution_requests | team/task/session/owner、prompt、provider/model、status、attempt_count/max_attempts、current_attempt_id、时间；复合 FK 保证任务与会话及其 owner 同属一个团队 |
| execution_skills | 本次实际选用技能；FK 精确指向该 task 固定的 skill/version，不可改写 |
| execution_attempts | 每次领取的 UUID、单调 number、状态、租约、provider/model、request id/error code、开始结束时间；同 execution 的 number 唯一 |
| execution_results | attempt 唯一结果文本、时间、提供方元数据；FK 同团队同 execution，结果不可改写 |
| execution_receipts | actor/team/operation/key 唯一、输入指纹、execution FK；不可改写 |

核心字段用显式列，只有提供方元数据是 JSONB。没有借本轮重写既有业务 JSONB，也没有另建运行时/身份数据库。

`createStore` 的 AsyncLocalStorage 以同一 Pool 共享事务范围。execution.accept 的外层事务先拿既有团队 advisory lock，再锁团队/成员/用户并重新读取权限；其内调用既有 RuntimeService.createSession/createTask/createChildTask 直接加入同一个事务。快照、固定资源映射、请求、所选技能与幂等回执一起提交；任何一步失败全部回滚。嵌套操作不能换 user/team，也不能把只读事务升级为写入。旧 RuntimeService 公共接口与返回保持兼容。

发布和接受任务各自在同库事务使用同一团队锁，因此发布/接受的先后有明确顺序。远端网络从不进入此事务：worker 领取并提交 claimed，按固定版本加载完整资源并校验 checksum，提交 running，再发模型请求。验证中故意阻塞提供方同时发布 v2，发布成功，原调用仍读 v1 完整资源。

## 状态与恢复取舍

| 转移 | 条件/保证 |
| --- | --- |
| queued → claimed | 团队锁 + 条件行锁；并发 worker 只有一个得到 attempt UUID，租约用数据库时钟 |
| claimed → running | 再验成员与固定资源；先持久化“可能发出”标记再调用提供方 |
| running → succeeded | 完成事务重验权限、当前 attempt、状态和未过期租约；一次写结果和终态 |
| claimed 过期 → queued/failed | 尚未允许远端调用，可重新领取；每次领取仍消耗有限 attempt 次数 |
| running 过期 → uncertain | 即使进程在调用前一瞬崩溃，也不能证明没发出；不会自动重试收费调用 |
| failed/uncertain/cancelled → queued | 用户显式新幂等键重试；uncertain/已开始后取消必须确认潜在重复费用；仍沿用 taskId/snapshot/provider/model |
| 撤权/取消 → cancelled | 阻止后续领取和结果发布；进行中本地等待中止，不能保证提供方停止计费或撤回已发送内容 |

每任务默认 3 attempts，每 attempt 最多一次外部生成请求；SDK 隐式重试为零。子任务复制父完整快照和 checksum，新任务使用接受时目录（保留既有显式 session 偏好）。晚到结果只能命中仍有效的同一 attempt，不能覆盖新尝试。收到 provider request-id 后立即持久化，超时后仍可追踪；没有远端自动对账或 exactly-once 承诺。

仅 active contributor/admin 可接受、领取、读取本人的执行任务。Cookie/CSRF 由 identity 处理，body Actor/provider/model 字段拒绝；库内每次重新读取角色，伪造 role 无效。撤权期间已发出的内容无法撤回；worker 每秒复核，结果事务再次拒绝暴露。

限制：prompt 16 KiB，1–10 技能，远端输入 1 MiB JSON、响应 512 KiB、结果 256 KiB；默认输出 2048 tokens、60 秒超时、90 秒租约；每用户每团队最多 10 个待处理任务。单实例 worker 单并发，宿主另按 IP/身份限流。模型仅获取 prompt 和固定文本资源，不接触服务器环境/密钥，没有 shell、脚本或工具执行。

## 已交付接口

详见 [execution README](../../src/modules/execution/README.md) 与 [类型](../../src/contracts/execution.ts)。

- `index.ts`: `createExecutionService({pool,provider,...limits,onError?})`；`createAnthropicProvider({apiKey,model,workspaceId?})`；`createExecutionHttpHandler({execution,identity,beforeRequest?})`。
- lifecycle: `start()`、`stop()`、`runOnce(executionId?)`、`recover()`；不创建/关闭 Pool，不隐式迁移。宿主先 migrate 后 start，关闭接入后 stop 再 pool.end。stop 中止远端等待，SQL 超时与最终退出 deadline 由宿主兜底。
- HTTP: `POST /api/execution/{accept,get,list,retry,cancel}`；认证后 beforeRequest 为 6 提供成本/身份限流入口，accept/retry/带 parentTaskId 的 accept 计入成本。
- `client.ts`: `createExecutionClient({teamId,csrfToken,baseUrl?,fetch?,onForbidden?})`，含 `dispose()`，接受 Product scoped fetch、AbortSignal/身份销毁，拒绝迟到响应。
- `components.tsx`: `ExecutionPanel({client,scopeKey,skills,onDirtyChange?,initialSkillId?})`，任务列表/创建/详情分开，固定版本、尝试、结果、中文错误、重试确认与子任务；scopeKey 同步卸载旧身份内容；初始选技能、未提交任务离开确认与宿主 dirty 回调已接入。

通过 Orca 向 4/6 先发契约与工厂签名，后续逐次通知提交。实际使用的技能为 [orchestration](/Users/qianqian/.agents/skills/orchestration/SKILL.md)（本机位置 `/Users/qianqian/.agents/skills/orchestration/SKILL.md`），仅定向通知已有原生会话，不建立代理或 DAG。

## 可复现命令和实际结果

本机 Node 26.11.1，真实 PostgreSQL 17，独立随机 schema；共享实例 `postgresql://skill_library@127.0.0.1:55432/skill_library_test` 经 pg_isready 探活，只清理自己 schema，不停实例。

```sh
# 仓库根目录；脚本分别 npm ci 三个模块，缺 DATABASE_URL 直接失败
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test sh src/modules/execution/verify.sh
# 既有回归，先 npm ci runtime/service/web/broadcast 各自 manifest
npm test --prefix src
```

| 检查 | 结果 |
| --- | --- |
| persistence 类型检查 / execution 类型检查 | 通过 |
| persistence PG（含 001→002 带数据升级、旧发布/运行时/导入回归） | 9/9，无跳过 |
| execution Node 测试 | 18/18，无跳过：含 13 个 PG 执行场景、1 个真实 HTTP/PG 身份场景、1 个浏览器 client 生命周期测试、3 个 fake fetch 协议测试 |
| execution React/jsdom | 5/5：详情/版本/结果、子任务、输入保留和幂等键、身份隔离、uncertain 确认、返回列表保护 |
| 既有 contracts/service/runtime/web/broadcast/publication | 59/59，无跳过 |
| 临时组合 product build | TypeScript + Vite 成功 |
| 正式产品 Chrome 任务页 + HTTP/PG | 1/1，无跳过；明确 fixture 提供方，非真实模型 |
| 无凭据真实 demo | exit 1，准确列出配置缺口，没有调用远端或退回 fixture |

PG 执行用例覆盖接受中途故障回滚、重复请求指纹、真正同时从两个独立 Pool 领取、网络期间发布、原任务重试/子任务固定完整资源、超时/取消、claimed 和 running 租约恢复、迟到回包、撤权/降权、跨 owner/team、checksum 损坏、队列/attempt 上限、独立 Node worker 实际 SIGKILL、shutdown 与 request-id 恢复。

Chrome 在临时导出目录执行（固定上述三个 SHA）：

```sh
npm run build --prefix src/modules/product
# 先确认选中的测试存在，避免 Node 名称过滤零命中时只有文件级通过
rg -q '正式任务页' src/modules/collaboration/collaboration.test.ts
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test \
  COLLABORATION_PORT=18759 node --test --test-name-pattern='正式任务页' \
  src/modules/collaboration/collaboration.test.ts
```

测试实际使用两个隔离 context 经 Cookie/身份/真实 HTTP/PG 完成任务；OAuth exchange 和执行输出为明确 fixture。验证失败→重试保持 v1，子任务保持 v1，发布后新任务用 v2，撤销成员后工作区与结果消失。查看了桌面和 390px 图片，无横向溢出。首次 resize 后立即 fullPage 截图出现拼接残影，在临时 harness 截图前等待 400ms 后图像正常；该临时等待只用于诊断截图，没有修改其他工作区源码；最终 78dd4d0 固定源码复验没有此临时修改，实际具名用例运行 9.69 秒通过。

证据见 [execution/evidence](../../src/modules/execution/evidence/)：模块验证原始日志（17 项 execution/4 项 UI 的阶段，后续新增检查见 summary）、最终 Chrome 日志与桌面/手机 PNG、最终已执行命令与计数 summary。全部模型输出标注 fixture。临时组合保留在 `/var/folders/8g/tf_4yqbs6fbfkhxzd_m66v840000gn/T/skill-library-execution-review-z5llie0f`。

## 最后外部缺口与真实演示步骤

实现可以接入真实服务，但“展示一次真实执行”目前**未验收**。当前环境没有服务端 API key 或模型配置；也没有读取/复制个人开发工具凭据。

1. 在真实产品数据库迁移至 002，以真实登录用户创建团队并发布至少一个技能，记下真实 user/team/skill UUID；部署由 6 挂载同一个 Pool，产品由 4 挂载任务面板。
2. 用服务端 secret 配置 `ANTHROPIC_API_KEY`、可用模型 `EXECUTION_MODEL`（如 API key 非 workspace-scoped，再配置 `ANTHROPIC_WORKSPACE_ID`）；不要放进客户端构建或提交 Git。
3. 真实 UI 发起任务，或配置 `DATABASE_URL`、`EXECUTION_DEMO_USER_ID`、`EXECUTION_DEMO_TEAM_ID`、`EXECUTION_DEMO_SKILL_ID` 和固定 `EXECUTION_DEMO_KEY`，运行 `npm run demo --prefix src/modules/execution`。CLI 再验真实成员权限，只执行该 executionId，最多一次调用、256 output tokens；中断后同 key 不重复创建请求。
4. 记录 succeeded、非 fixture 的 provider request-id、实际结果和固定版本，并在真实用户任务页查看。若 uncertain，先核实提供方记录/费用；不得循环重试。需要验证“真实重试/子任务”时，由用户显式再执行，并核对仍使用原版本。

这一步仍需要真实外部配置，不以本地协议或 fixture 测试代替。正式公网、OAuth 账号和生产备份恢复的完成状态由各 owner 的验收报告决定；本分支没有宣称它们完成。
