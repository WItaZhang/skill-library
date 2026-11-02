# 任务执行（接口 v1）

供 production-collaboration / production-operations 立即接入的稳定签名；实现与测试正在本 worktree 完成。共享 DTO 仅新增 `src/contracts/execution.ts`，不改旧 contracts 行为。

## 服务端（index.ts）

```ts
const provider = createAnthropicProvider({apiKey: process.env.ANTHROPIC_API_KEY!, model: process.env.EXECUTION_MODEL!});
const execution = createExecutionService({pool, provider});
const executionHandler = createExecutionHttpHandler({
  execution, identity, // identity: Pick<IdentityService,'resolveActor'|'assertCsrf'>
  beforeRequest: async ({req, actor, operation}) => { /* 宿主限流；抛 DomainError */ },
});
execution.start();
// if (await executionHandler(req,res)) return;
// 关闭 HTTP 接入后 await execution.stop(); 最后宿主 pool.end()
```

`createExecutionService({pool: Pool, provider: ExecutionProvider, pollIntervalMs?: number, timeoutMs?: number, leaseMs?: number, maxAttempts?: number, maxOutputTokens?: number}) : ExecutionService & ExecutionLifecycle`。
复用同一个 Pool；内部创建同库 RuntimeService，避免注入跨库 runtime 破坏原子性。不会创建/关闭 Pool 或运行迁移。宿主先 `await migrate(pool)`（新增 002），再 start。start 幂等，stop 停止领取、中止本进程请求并等待落库；runOnce/recover 供确定性运维和测试。默认单 worker，每 task 最多 3 attempts，每 attempt 最多一次外部请求；不自动重试远端失败/不确定调用。

HTTP 全部 `POST /api/execution/{accept,get,list,retry,cancel}`，请求为 input JSON；get/cancel 是 `{executionId}`，list 是 `{}`。响应 `{data}` 或 `{error:{code,message}}`，handler `Promise<boolean>`（非 execution 路径 false）。每次身份/CSRF 校验；不接受 body Actor/provider/model。beforeRequest 在认证后、操作前调用，operation 为上述五种；accept/retry 是执行成本入口，宿主统一做 IP/身份限流，服务自身限制每用户待处理队列和 attempt 上限。数据库权限在接受、领取、读取、完成重验。

## 浏览器（client.ts、components.tsx）

```tsx
const client = createExecutionClient({baseUrl: '', teamId, csrfToken, fetch, onForbidden});
<ExecutionPanel client={client} scopeKey={`${userId}:${teamId}:${csrfToken}`} skills={skills.map(s=>({id:s.id,name:s.name}))} />
// 身份/团队切换先卸载，client.dispose()；onForbidden 关闭整个旧工作区。
```

`createExecutionClient({baseUrl?:string, teamId:string, csrfToken:string, fetch?:typeof fetch, onForbidden?:()=>void}): ExecutionClient`。
`ExecutionPanel({client:ExecutionClient, scopeKey:string, skills:{id:string;name:string}[]})`。React/browser 入口不引入 pg/服务端代码。任务列表、创建、详情分开；详情显示固定版本、attempt、结果/错误与重试/子任务/取消。轮询刷新，身份销毁阻止迟到响应。重试保留 taskId；子任务传 parentTaskId 继承完整 snapshot，选择的 skillIds 必须属于父版本映射。新任务默认取会话策略允许的最新版。

## 数据与调用边界

接受任务在团队事务锁内完成身份检查、RuntimeService 固定快照、execution_requests 写入及幂等回执；发布也用此锁。事务提交后 worker 领取 attempt、解析固定资源并检查 checksum；提交 running 标记后才调用提供方，不持数据库锁等待网络。

状态：queued → claimed → running → succeeded/failed/uncertain/cancelled。claimed 租约过期可重新排队；running 过期标记 uncertain，不能自动重新调用。明确重试才建立新 attempt；uncertain 重试必须 acknowledgeUncertain=true（可能重复计费）。attempt ID 是 fencing token，迟到结果只能更新仍有效的 running attempt。取消阻止结果发布，不能保证提供方停止计费。权限撤销会中止本进程调用，阻止后续领取和结果读取。

凭据仅服务端注入；不读取开发工具登录信息；不执行用户脚本、shell 或模型工具。实际提供方为 Anthropic Messages API，固定 HTTPS endpoint；网络错误/超时结果不确定，保留 attempt、请求 ID（如已收到），不自动重试。配置缺失不得替代为 fixture。fixture 测试不算真实执行验收。
