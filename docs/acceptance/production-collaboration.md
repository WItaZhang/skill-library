# Production 4：真实多人协作交付与验收

2026-11-01（America/Los_Angeles）。独立分支 `WItaZhang/production-collaboration`，起始 HEAD 正是共同基线 `daa1e826a684efac988c5936ddb3fa6acc94310f`，已执行 ancestor 检查。完整读取 phase 4–6 任务书及其指定基线文档后开发；没有改 main、他人 worktree、共享契约、DDL 或 integration，没有 merge/push，也没有创建其他代理。

## 交付及依赖

| 提交 | 内容 |
| --- | --- |
| `ced09be` | 提前发布 collaboration README 跨模块契约，经 Orca 定向通知 5/6 |
| `02702de` | 真实双浏览器复现、SSE 撤权控制与 scope 销毁、发布重试保留下一版输入 |
| `fb5be9c` | 正式执行 UI 挂载、预览核对竞态修复、完整验收 harness 与隔离组合脚本 |
| `78dd4d08cd936da509568426a01f4d489676fc6d` | 验收导出脚本兼容本机 Python 3.9；最终业务代码检查点 |

本报告后续独立提交，不改变上述业务代码。最终本地组合固定以下已提交源码，不混入其他工作区未提交文件：

- collaboration：`78dd4d08cd936da509568426a01f4d489676fc6d`。
- execution / 执行增量 persistence / execution.ts：`ccb79ad192c25f15853e0046a7bc57f51243ded3`（其报告提交为 `403566aad75bdb72f98aa8af54871e6a47a3b972`）。
- operations / 正式宿主：`2e6f3bdf1fd9913c4d798703a468b806035be901`。较早也已验证 `b9ebb97` 的稳定工厂接口。

随后 operations 交付 `9ee8c23e5f433169ee8d3478e5e409315d8bf719`，修复 Node 24 的空闲 TCP 优雅关闭，并经 Orca 告知已在 Node 24 跑通本模块 8 场景及正式 Chrome。该结果属于 operations 的独立验证，不混入下表本人 Node 26 的检查计数；合并部署应采用其含该兼容修复的交付。

最终组合目录：`/var/folders/8g/tf_4yqbs6fbfkhxzd_m66v840000gn/T/skill-collaboration-combined-wceqoist`。`sources.json` 记录精确 SHA 和是否带本工作区未提交改动。组合脚本只读 peer 的 `git archive` 并写新临时目录，未将别人的文件纳入本分支。

## 先复现，再修复

1. **撤权后旧工作区仍停留。** 初次双 context 的真实 HTTP/PG/Chrome 测试走通 v1 → v2 提醒 → v3 同步发布、离线 v4/v5 与重连后，在撤权检查失败：2 秒内 SKILL.md textbox 数量应为 0，实际为 1。基线只将 SSE 断开当成普通网络错误，主要等聚焦或 15 秒身份轮询。
2. **发布回包丢失后的说明被清空。** 真实发布提交后中断回包，作者填写下一版说明，重试原请求。版本/正文均正确，但“下一版说明应保留”实际变成空字符串。修复后只清理原请求的 changeSummary；保留新正文和新说明，原幂等键只对应原 payload。
3. **新预览超越旧版本查询时误判永久失效。** 连续发布及三方比较过程中，预览已是 v4，在途 getSkill 仍返回 v3，旧 effect 过早将预览标为 invalid，后续拿到 v4 也不能确认。现在在版本核对中暂停应用，待权威查询完成后再判定目标是否过期。确定性测试延后真实 getSkill 回包，保证覆盖该时序。

SSE 新增 `access.revoked` 控制帧，只含 `{code:"FORBIDDEN"}`，没有团队/技能内容；服务端每轮及发送前重新校验用户、团队、角色。浏览器收到后同步销毁 scope、执行 client、在途请求、旧 SSE 和该身份的草稿 ID 缓存，再卸载工作区。它不是技能发布通知，不写发布事件。初次握手或离线期间撤权可能没有控制帧，error/reconnect 会额外核对身份 HTTP；401/403、会话消失、角色变化才关闭。普通断网、身份接口 503 均保留输入。

每个 workspace 一条 SSE，列表、任务页和编辑器共用，避免每个消费者重复建立连接。App 的身份异步响应带 epoch 检查；旧会话迟到结果不能恢复已销毁的工作区。自动保存、预览与同步继续使用编辑 generation 和修订保护；同步回包期间的新输入进入明确的对照恢复流程，确认整合前暂停保存/发布。

## 本地验证

本次使用 Node 26.11.1、本机 PostgreSQL 17、真实 Chrome。数据库每项新建随机 `collaboration_*` schema，结束（包括启动失败）清理自己的 schema；没有停共享 55432 实例或清理其他人的 schema。

下表共 **60 项通过、0 skip**（类型检查和构建另计）。

| 检查 | 结果与证据边界 |
| --- | --- |
| product 组件 | 21 通过；包括重复/乱序事件调度 fixture、SSE 复用、迟到结果拒绝、503 不误注销、执行与 scope 的 AbortSignal 组合 |
| broadcast 传输 | 8 通过；HTTP 白名单、SSE 重放/游标、团队隔离、撤权、背压等 |
| 新 collaboration HTTP/PG/Chrome | 8 通过、0 skip；下表逐项列明 |
| identity | 15 通过、0 skip；真实 PG/HTTP，OAuth upstream 明确 testProvider |
| 访客旧流程 | HTTP 2 + React 4 通过；未修改访客入口/组件 |
| 正式旧流程 | 真实 PG/HTTP 1 + Chrome 1 通过，保留创建/编辑/历史/恢复/归档/窄屏回归；任务步骤由 operations 适配新组件 |
| 类型/构建 | product、collaboration、broadcast、identity、正式宿主类型检查通过；正式 Vite 构建通过 |
| 缺配置负向检查 | `env -u DATABASE_URL sh src/modules/collaboration/verify.sh` 立即非零退出；不能把跳过当验收 |

新增 8 场景：

| 场景 | 实际断言 |
| --- | --- |
| 双作者完整闭环 | 独立 Cookie/context，同团队 A/B 从 v1 独立草稿；B 未保存时 A UI 发布 v2，B 提醒不改输入；HTTP 过期发布 409，UI 禁用发布；基础/本地/最新三方处理后 UI 发布 v3；离线期间发布 v4/v5，重连核对 v5；撤权后无聚焦/写入触发，2 秒内旧编辑器消失，读写 403、草稿缓存清空 |
| 并发与幂等 | 同基线并发一人 200、一人 409；失败方草稿保留；原请求重试返回原版本；版本和持久事件数量一致；无冲突预览不推进基线，明确同步后才能发布；不能读取另一作者私有草稿 |
| 延迟响应 | 保存、预览、应用均经真实 HTTP/PG，延后原响应；继续输入不被旧响应替换；同步中输入进入恢复区；明确整合并保存后刷新恢复同一作者草稿 |
| 无冲突确认 | 本地正文与远端新增资源不重叠，仍须勾选确认；确认前基线不变，确认后两份改动均保留，且不发发布事件 |
| 连续远端与另标签 | 预览期间 v3/v4 连续发布；新预览超越旧查询仍可恢复；手工选择保留且须重查；同 Cookie 的第二标签保存同一草稿，旧应用拒绝，服务器内容、本地内容与手工选择都保留，明确采用新修订并重新比较后完成 |
| 发布丢包重试 | 真实 PG 已提交，Chrome 收不到回包；原请求重试不新增版本/事件，不清空后来输入的正文与说明 |
| 权限/缓存 | 降权立即关闭旧 SSE/workspace；viewer 合法读取仍可用而写入被拒；切换团队清旧缓存、没有其他团队内容；离线撤权重连关闭；同 context 换另一账号不会继承旧团队/草稿 |
| 执行最终挂载 | 真实宿主、HTTP、PG、执行 service + **明确 fixture provider**；失败显示错误、重试还是 v1、子任务还是 v1、新独立任务取 v2，实际 attempts/result 可读；详情/list/form 分开；撤权清除结果并禁止读取；390px 不横向溢出 |

延迟测试只调度 `route.fetch()` 得到的真实服务响应；丢包在真实提交后 abort，不伪造业务响应。连续/离线更新走真实 SSE；任意重复/乱序调度另用明确组件 fixture 验证，不能将后者称为网络自然产生乱序。执行第 8 场景的返回文本明确写“fixture，非真实模型”。

## 复现命令与证据

从本 worktree 根目录：

```sh
python3 src/modules/collaboration/assemble.py \
  --execution /Users/qianqian/orca/workspaces/skill-library/production-execution \
  --execution-ref ccb79ad192c25f15853e0046a7bc57f51243ded3 \
  --operations /Users/qianqian/orca/workspaces/skill-library/production-operations \
  --operations-ref 2e6f3bdf1fd9913c4d798703a468b806035be901
# cd 到新生成的组合目录
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test \
  sh src/modules/collaboration/verify.sh
```

脚本默认 collaboration 端口 18754，支持 `COLLABORATION_PORT`；Chrome 默认 macOS 安装路径，可设置 `CHROME_PATH`。8 场景完整执行约 20 秒；每次有独立身份、团队与 schema。依赖安装使用模块各自 lockfile，源依赖链接只建在该临时目录。

另外实际执行：

```sh
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test npm test --prefix src/modules/identity
npm run typecheck --prefix src/modules/identity
npm ci --prefix src/modules/service --no-audit --no-fund
node --test src/integration/application.test.ts
(cd src/integration && ../modules/product/node_modules/.bin/vitest run --config vite.test.config.ts)
src/modules/product/node_modules/.bin/tsc -p src/modules/broadcast/tsconfig.json
src/modules/product/node_modules/.bin/tsc -p src/integration/production-tsconfig.json
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test \
  node --test src/integration/production.test.ts src/integration/production.browser.test.ts
```

正式旧流程测试只在临时副本将端口 18743/18744 改为 18773/18774，避免与 operations 同时验收冲突，无业务/断言替换。访客 HTTP 第一次因未安装其 service 的 `diff` 依赖失败，补做该模块 npm ci 后 2 项通过。

本 worktree 保留本地证据（test-results 不入 Git，可重跑生成）：

- `src/modules/collaboration/test-results/verify.log`：最终构建、类型和 37 项核心检查输出。
- `src/modules/collaboration/test-results/production.log`：正式 HTTP/Chrome 回归。
- `src/modules/collaboration/test-results/sources.json`：最终组合来源。
- `src/modules/collaboration/test-results/three-way.png`、`execution-desktop.png`、`execution-mobile.png`：已打开查看三方界面与执行详情；390px 无横向溢出，移动图头部未重复。

## 架构及事务边界

协作负责浏览器状态、身份 scope 与广播适配，**没有新建业务存储或 DDL**。继续使用宿主注入的统一 Pool。正式业务仍是已有 JSONB DTO + 生成列/FK/unique/check，并未重写成全普通列。

发布在 persistence 的团队锁事务内核对作者、实时权限、修订和基线，再写不可变版本、当前指针、审计、草稿推进、事件及幂等回执。浏览器提醒只更新“有新版”元信息，不应用正文或基线。作者明确同步是另一个原子保存草稿/基线的事务，不发布、不发事件。服务端拒绝过期是并发一致性的保证，前端禁用只是交互提示。

执行接受由 execution/persistence 在同库事务固定快照并写执行请求；UI 只调用实际 execution client，不在浏览器组装任务快照。重试/子任务沿用已固定映射，外部 provider 调用在事务外；本模块没有修改这些边界。向 owner 反馈并由其修复同一 PG client 并发 query，最终固定 ccb79ad 已无该警告。

## 未完成的真实外部验收

实现与本地真实 HTTP/PG/浏览器验收完成；**真实 GitHub 两账号、真实模型调用、公网 HTTPS 没有判为通过**。未读取个人开发工具凭据，也未创建收费资源。

最后仍需：

1. 部署提供真实 HTTPS `PUBLIC_ORIGIN`、同源 GitHub OAuth App 的 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`，callback 精确为 `/api/identity/callback`；提供真实服务端数据库配置。正式模式不启用 testProvider。
2. 用户用两个真实 GitHub 账号，在两个隔离浏览器 profile/context 完成登录；A 建团队并邀请 B 已验证邮箱，B 接受邀请。执行本报告首个闭环及断线、刷新、降权/撤权；保存无敏感 token 的录屏或截图。当前 fixture OAuth 证据不能替代这一步。
3. 服务端提供 `ANTHROPIC_API_KEY`、`EXECUTION_MODEL` 并启用真实执行配置，跑一次有界真实调用。记录 execution/task/attempt、固定版本、provider request id 和实际结果，再核对重试/子任务固定版本；不能将本地 fixture 输出算模型验收。
4. 公网、部署、备份恢复及 Node 24 宿主兼容性最终以 operations 报告为准；本报告自运行环境为 Node 26，不冒称已经亲跑 Node 24 或公网。

未保存正文只在当前工作区内存中保护；刷新/离开仍提示确认，刷新恢复的是 **PG 已保存** 的作者草稿。身份失效时按要求移除旧工作区，不为保留输入继续暴露无权访问内容。
