# 真实多人协作验收与跨模块契约

Owner：production-collaboration。共同基线 `daa1e826a684efac988c5936ddb3fa6acc94310f`。

本模块只放真实 HTTP / PostgreSQL / Chrome 验收 harness；业务仍使用宿主的 identity、persistence、broadcast 和 product，不另建协作存储或模拟服务。测试 OAuth 明确为 `mode:test` / `testProvider`，不等价于真实 GitHub 双账号验收。

## 给 execution / operations 的早期契约

- ProductScope 为每个用户、会话、团队、角色创建独立客户端，注入 `X-Team-Id`、`X-CSRF-Token` 和 scope AbortSignal。403/401 或权限失效时先销毁请求、SSE 与草稿 ID 缓存，再关闭旧工作区。执行 browser client 应接受注入 `fetch`，不可绕过 scope 使用全局 fetch。
- ExecutionPanel 与 browser client 由 execution 导出；Product/App 最终挂载由 collaboration 负责。UI 输入应包含 execution client、当前 `sessionId`、可选 requested skill；任务页展示真实请求、尝试、固定版本、结果和错误，不增加工程调试控件。最终签名以 execution README 为准，收到接口后在此记录。
- Broadcast 的 `createLibraryHttpHandler` / `createSseSkillUpdateSource` 签名兼容现有宿主。SSE 每轮及每次发送前重新验证身份。新增控制事件 `access.revoked`（仅 `{code:"FORBIDDEN"}`，无团队/业务内容）用于身份或角色失效；浏览器收到后关闭 EventSource 并以 DomainError FORBIDDEN 通知 scope。网络错误仍为 UNAVAILABLE，不清除未保存输入。
- 宿主继续使用同一 Pool；发布事务、身份检查与执行任务接受事务保持 persistence 所有权。协作无新增 DDL，不在广播中写草稿、不跨事务调用外部执行器。
- 验收为随机独立 PostgreSQL schema；只清理本次 schema，不停止共享实例。Chrome 使用两个隔离 context 与独立 Cookie，经真实 OAuth 测试提供方跳转、邀请、HTTP RPC 和 SSE 完成协作。

接口通知通过 Orca 定向发送；当前另外两工作区为原生 chat，worktree group 尚不能解析为终端收件人，继续查找其原生会话地址，独立开发不等待。

具体测试命令、证据和限制见 `docs/acceptance/production-collaboration.md`（交付时补齐）。
