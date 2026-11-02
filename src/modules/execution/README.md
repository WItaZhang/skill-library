# 任务执行（接口 v1）

供 production-collaboration / production-operations 接入的稳定签名；实现与测试已在本 worktree 完成，远端真实验收状态见验收报告。共享 DTO 仅新增 `src/contracts/execution.ts`，不改旧 contracts 行为。

## 服务端（index.ts）

```ts
const provider = createAnthropicProvider({apiKey: process.env.ANTHROPIC_API_KEY!, model: process.env.EXECUTION_MODEL!, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID});
const execution = createExecutionService({pool, provider});
const executionHandler = createExecutionHttpHandler({
  execution, identity, // identity: Pick<IdentityService,'resolveActor'|'assertCsrf'>
  beforeRequest: async ({req, actor, operation}) => { /* 宿主限流；抛 DomainError */ },
});
execution.start();
// if (await executionHandler(req,res)) return;
// 关闭 HTTP 接入后 await execution.stop(); 最后宿主 pool.end()
```

`createExecutionService({pool: Pool, provider: ExecutionProvider, pollIntervalMs?: number, timeoutMs?: number, leaseMs?: number, maxAttempts?: number, maxOutputTokens?: number, onError?:(code:string)=>void}) : ExecutionService & ExecutionLifecycle`。
复用同一个 Pool；内部创建同库 RuntimeService，避免注入跨库 runtime 破坏原子性。不会创建/关闭 Pool 或运行迁移。宿主先 `await migrate(pool)`（新增 002），再 start。start 幂等，stop 停止领取、中止本进程请求并等待落库；runOnce(executionId?:string)/recover 供确定性运维和测试，指定 executionId 只领取该任务。stop 后实例不可重新 start；重新创建实例恢复。SQL 等待由宿主连接/语句超时和 shutdown deadline 兜底。onError 只提供安全错误码，供宿主日志/指标使用。默认单 worker，每 task 最多 3 attempts，每 attempt 最多一次外部请求；不自动重试远端失败/不确定调用。

HTTP 全部 `POST /api/execution/{accept,get,list,retry,cancel}`，请求为 input JSON；get/cancel 是 `{executionId}`，list 是 `{}`。响应 `{data}` 或 `{error:{code,message}}`，handler `Promise<boolean>`（非 execution 路径 false）。每次身份/CSRF 校验；不接受 body Actor/provider/model。beforeRequest 在认证后、操作前调用，operation 为上述五种；accept/retry 是执行成本入口，宿主统一做 IP/身份限流，服务自身限制每用户待处理队列和 attempt 上限。数据库权限在接受、领取、读取、完成重验。

## 浏览器（client.ts、components.tsx）

```tsx
const client = createExecutionClient({baseUrl: '', teamId, csrfToken, fetch, onForbidden});
<ExecutionPanel client={client} scopeKey={`${userId}:${teamId}:${csrfToken}`} skills={skills.map(s=>({id:s.id,name:s.name}))} />
// 身份/团队切换先卸载，client.dispose()；onForbidden 关闭整个旧工作区。
```

`createExecutionClient({baseUrl?:string, teamId:string, csrfToken:string, fetch?:typeof fetch, onForbidden?:()=>void}): ExecutionClient`。
`ExecutionPanel({client:ExecutionClient, scopeKey:string, skills:{id:string;name:string}[], onDirtyChange?:(dirty:boolean)=>void, initialSkillId?:string})`。initialSkillId 有效时首次挂载打开新建并预选；onDirtyChange 通知宿主离开保护，卸载清理。React/browser 入口不引入 pg/服务端代码。任务列表、创建、详情分开；详情显示固定版本、attempt、结果/错误与重试/子任务/取消。轮询刷新，身份销毁阻止迟到响应。重试保留 taskId；子任务传 parentTaskId 继承完整 snapshot，选择的 skillIds 必须属于父版本映射。新任务默认取会话策略允许的最新版。

## 数据与调用边界

接受任务在团队事务锁内完成身份检查、RuntimeService 固定快照、execution_requests 写入及幂等回执；发布也用此锁。事务提交后 worker 领取 attempt、解析固定资源并检查 checksum；提交 running 标记后才调用提供方，不持数据库锁等待网络。

状态：queued → claimed → running → succeeded/failed/uncertain/cancelled。claimed 租约过期可重新排队；running 过期标记 uncertain，不能自动重新调用。明确重试才建立新 attempt；uncertain 重试必须 acknowledgeUncertain=true（可能重复计费）。attempt ID 是 fencing token，迟到结果只能更新仍有效的 running attempt。取消阻止结果发布，不能保证提供方停止计费。权限撤销会中止本进程调用，阻止后续领取和结果读取。

凭据仅服务端注入；不读取开发工具登录信息；不执行用户脚本、shell 或模型工具。实际提供方为 Anthropic Messages API，固定 HTTPS endpoint；网络错误/超时结果不确定，保留 attempt、请求 ID（如已收到），不自动重试。配置缺失不得替代为 fixture。fixture 测试不算真实执行验收。


## 明确的限制与恢复策略

- 只有活跃 contributor/admin 可接受、领取和读取本人任务；不信任调用方 role。viewer 不挂载执行入口。禁用用户/团队、移除成员、降为 viewer 后在数据库侧拒绝访问。远端请求已发出时，权限撤销不能撤回已传给提供方的内容；worker 每秒复核并中止本地等待，完成事务仍会重新校验。
- prompt 最多 16 KiB；选择 1–10 个技能，模型输入为这些技能的完整固定资源（上限 1 MiB JSON）；结果最多 256 KiB，远端响应最多 512 KiB。默认 maxOutputTokens=2048、timeout=60s、lease=90s；每用户每团队最多 10 个待处理任务。worker 每实例单并发；宿主另做 IP/身份成本限流。
- taskId 永久不变，snapshot 包含接受时完整目录和偏好修订。重试使用原 taskId；子任务复制整个父快照及 checksum。execution_skills 明确记录本次选用的子集并 FK 到 runtime_task_versions。
- receipt 唯一 `(team_id,owner_id,operation,key)`；同 key 同规范化输入返回同一执行记录的当前状态，不再排队。同 key 不同输入返回 CONFLICT。key 不跨 accept/retry 混用；重试回执即使已完成也不会再次启动 attempt。
- 租约使用数据库时钟；claimed 超时允许重新领取（仍消耗 attempt 次数），running 超时进入 uncertain。新实例扫描数据库恢复，不依赖内存队列。即使提供方已返回但数据库无法确认提交，也保守进入 uncertain/等待租约恢复。
- 请求一旦进入 running，数据库无法证明远端是否收到；不承诺 exactly-once。人工确认 uncertain/已发出后取消的任务才可重试，可能重复收费。provider.execute 只能调用一次生成 API，无 SDK 隐式重试。已有 request-id 收到后立即写入 attempt，超时/崩溃仍可追踪。
- 默认查询最近 30 个本人任务，详情可以按 id 查旧任务；暂未提供分页、输出流、工具执行、多轮 Agent 循环。队列记录保存原 provider/model，配置改变时旧队列仅由匹配配置 worker 消费，恢复原配置后继续。无远端查询 API 自动对账承诺。

## 实际提供方协议

适配器调用固定 `https://api.anthropic.com/v1/messages`，按官方 2026-10-21 API 版本，使用服务端 Authorization Bearer、model、max_tokens、system 与 messages；未提供 tools，不执行 shell/脚本。只接受文本结果，截断、拒绝及异常响应均记录失败/不确定。原始提供方报错正文不会返回或记录。

2026-11-01 核实：[API overview](https://platform.claude.com/docs/en/api/overview)、[Create a Message](https://platform.claude.com/docs/en/api/messages/create)、[API versioning](https://platform.claude.com/docs/en/api/versioning)。需要有权使用所选模型的服务端 API key；非 workspace-scoped key 还需 `workspaceId`（建议环境变量 ANTHROPIC_WORKSPACE_ID）。不要读取开发工具登录缓存。

## 验证与一次真实演示

```sh
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test sh src/modules/execution/verify.sh
```

真实 PG 测试使用独立随机 schema 并清理，缺 DATABASE_URL 明确失败。提供方测试显式 fake fetch/fixture，不访问远端，不等于真实执行验收。

一次有界真实调用使用**已迁移、已有活跃成员及已发布技能**的数据库；通过服务端 secret 环境设置 `DATABASE_URL`、`ANTHROPIC_API_KEY`、`EXECUTION_MODEL`、`EXECUTION_DEMO_USER_ID`、`EXECUTION_DEMO_TEAM_ID`、`EXECUTION_DEMO_SKILL_ID`（必要时 `ANTHROPIC_WORKSPACE_ID`）。这些 ID 来自真实产品，CLI 不伪造身份或建立 fixture 数据。固定 `EXECUTION_DEMO_KEY` 可在命令中断后重查同一请求，`EXECUTION_DEMO_PROMPT` 可选。

```sh
npm run demo --prefix src/modules/execution
```

demo 只运行所接受的一个 executionId，maxAttempts=1、maxOutputTokens=256、超时 60 秒，不扫其他排队任务。输出真实执行编号、固定版本、attempt/request id、结果；记录保留在同库，当前身份的产品任务页可查看。任一必要配置缺失立即退出 1，绝不退回 fixture。没有真实凭据时，本地验证和远端验收分别报告。
