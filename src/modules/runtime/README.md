# SQLite RuntimeService

模块实现共享 `RuntimeService`，通过注入的 `RuntimeHost` 读取授权目录与不可变版本。没有 Agent 执行器、HTTP 服务、订阅或事件传输。中文错误采用共享 `DomainError`。

```ts
import { createRuntimeService } from './index.ts';
const runtime = createRuntimeService({ databasePath: '/persistent/runtime.sqlite', host });
const session = await runtime.createSession(actor);
const task = await runtime.createTask(actor, session.id, platformTaskId);
const version = await runtime.resolveSkill(actor, task.taskId, skillId);
// 平台在实际调用边界记录；仅浏览/解析不记为调用。
await runtime.recordInvocation(actor, task.taskId, skillId);
// 应用结束前，在未完成操作全部结束后：
runtime.close();
```

Node >=24，使用内建 `node:sqlite`；数据库父目录须存在。模块直接导出 TypeScript，宿主应支持类型剥离或自行编译；不依赖根构建配置。

```sh
cd src/modules/runtime
npm ci --no-audit --no-fund
npm run typecheck
npm test
```

任务 ID 全库唯一。相同 ID、会话和父任务返回原快照；不同请求占用同 ID 返回 `CONFLICT`。快照包含完整目录和偏好修订；所有版本在首次接受前校验，执行时再次按固定 ID 校验。除主契约字段外，内部保存接受时各包校验值，防止 Host 偷换相同版本 ID 后重新计算校验值。子任务复制父任务全部版本和校验值。资源由 Host 保留，runtime 不复制内容；缺失或更改直接失败，不回退最新版。路径只接受规范相对路径（拒绝重复、空段、点段、反斜杠、控制字符及 URL 特殊字符），必须包含 `SKILL.md`，按契约精确计算完整包 SHA-256。

会话仅属于创建者与其团队，管理员不绕过所有权。所有读取先验证本地所有权，并由 Host 校验当前团队访问或版本访问。生产 Actor 必须来自认证服务；Host 必须在 `getVersion` 执行权限撤销检查，不能因历史版本而跳过。对象结果是副本，修改返回值不会改写存储。

## 暂定 D1–D3

导出的 `provisionalDefaults` 明确标识本波策略，尚非已确认产品决策：D1 选择仅影响该会话未来新任务；D2 保留按会话与 Skill，直到显式选择新版（新会话没有旧偏好）；D3 未选择默认最新版。契约没有会话结束接口，宿主结束会话后应停止继续使用该 ID。本波不提供其他策略组合；最终确认不同规则时须统一修改契约、策略和验收预期。

`expectedRevision=0` 表示尚无偏好。保留目标必须是该会话实际调用过的版本。新版目标须仍是 Host 当前版本；校验资源后再次检查目标，旧目标报 `STALE_REVISION`。新版选择记录已处理目标，避免持续重复提示；后续发布再次显示。保留选择保持提示中的 preference，以便持续显示旧版标记。每个 Skill 最多一条提示，采用保留版本或最后一条实际调用记录为 usedVersionId；契约未表达每个并发任务的不同版本，任务详情应单独读取 `getTask`。

提示按实际调用记录和当前 Host 目录重建，没有依赖事件游标或事件到达顺序。第一次调用先检查 Host 当前目录；提示查询随时重新计算。宿主可在调用记录后、收到任何更新事件后或重连时调用 `getSessionUpdates`。同一事件重复触发查询不会累积提示，但本模块不测试实际事件投递或浏览器推送。`recordInvocation` 每次调用创建独立记录；契约没有调用幂等键，宿主不能把网络重试自动当作同一次调用。

## 事务边界与集成约束

SQLite 使用 WAL、外键和 `BEGIN IMMEDIATE`。偏好与会话 epoch 同事务更新；接受任务先读 epoch 和全部偏好，取得 Host 一致目录并验证资源，然后在写事务里比较 epoch 并插入完整快照。若偏好已变化，重新捕获，最多八次；持续竞争报可重试的 `STALE_REVISION`。两个连接同 ID 接受由事务内再次检查解决。SQLite 不跨 `await` 持锁。任务和调用记录有不可更新/删除触发器。

**Host 的目录捕获与 runtime SQLite 提交不是跨库原子事务。** `capturedAt` 仅是 Host 元数据，不是可验证的目录 revision。Host 必须保证单次 catalog 是一致的、版本内容不可变且可保留。本波明确的任务选版点是成功尝试中的目录捕获，快照提交后才返回接受成功；捕获期间完成的正常更新不能更换该快照。偏好本地提交若交错会使尝试重读目录，但 Host 在目录响应之后到本地提交之前仍能发布新版本或撤权。新版偏好第二次检查也无法消除跨进程的最后窗口。

阶段 2 若需要“恰好在平台任务接受提交时”的最新版和绝对拒绝该窗口的过期目标，须由集成统一串行化发布、目录捕获、偏好确认及任务接受，或协调扩展 Host 契约为带 revision 的条件提交/租约。不能用本地锁或多读一次宣称解决分布式原子性。两库备份、历史版本保留与真实身份撤销竞态也需联合验证；没有擅自修改共享契约。
