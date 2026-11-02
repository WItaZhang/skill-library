# 真实多人协作验收与跨模块契约

Owner：production-collaboration。共同基线 `daa1e826a684efac988c5936ddb3fa6acc94310f`。

本模块只放真实 HTTP / PostgreSQL / Chrome 验收 harness；业务仍使用宿主的 identity、persistence、broadcast 和 product，不另建协作存储或模拟服务。测试 OAuth 明确为 `mode:test` / `testProvider`，不等价于真实 GitHub 双账号验收。

## 给 execution / operations 的早期契约

- ProductScope 为每个用户、会话、团队、角色创建独立客户端，注入 `X-Team-Id`、`X-CSRF-Token` 和 scope AbortSignal。403/401 或权限失效时先销毁请求、SSE 与草稿 ID 缓存，再关闭旧工作区。执行 browser client 应接受注入 `fetch`，不可绕过 scope 使用全局 fetch。
- ExecutionPanel 与 browser client 由 execution 导出，已由 Product/App 最终挂载。实际签名：`createExecutionClient({teamId,csrfToken,fetch,onForbidden})`，`ExecutionPanel({client,scopeKey,skills,initialSkillId?,onDirtyChange?})`。详情“使用技能”进入预选技能的新任务，任务导航进入列表；详情展示真实请求、尝试、固定版本、结果和错误。查看者不调用 execution API。正式入口不再挂载访客的演示 TaskPage。
- Broadcast 的 `createLibraryHttpHandler` / `createSseSkillUpdateSource` 签名兼容现有宿主。SSE 每轮及每次发送前重新验证身份。新增控制事件 `access.revoked`（仅 `{code:"FORBIDDEN"}`，无团队/业务内容）用于身份或角色失效；浏览器收到后关闭 EventSource 并以 DomainError FORBIDDEN 通知 scope。网络错误仍为 UNAVAILABLE，不清除未保存输入。
- 宿主继续使用同一 Pool；发布事务、身份检查与执行任务接受事务保持 persistence 所有权。协作无新增 DDL，不在广播中写草稿、不跨事务调用外部执行器。
- 验收为随机独立 PostgreSQL schema；只清理本次 schema，不停止共享实例。Chrome 使用两个隔离 context 与独立 Cookie，经真实 OAuth 测试提供方跳转、邀请、HTTP RPC 和 SSE 完成协作。

工作区始终持有一条 SSE，编辑器复用同一连接；列表和执行结果页同样响应撤权。身份每次错误/重连重新核对、窗口聚焦及每 15 秒兜底。网络错误和身份接口 503 不能当作退出；只有明确无会话、权限变化或 FORBIDDEN 才关闭工作区。用户主动离开仍需确认未保存输入。服务端已保存的作者草稿保留在 PG，不在客户端保存正文。接口已通过 Orca 原生会话地址定向通知 5/6。

## 验证

最终依赖 5 的 execution/新迁移及 6 的 executionFactory 宿主。独立 worktree 不复制他人文件入 Git；可以只读导出到临时组合目录：

```sh
python3 src/modules/collaboration/assemble.py \
  --execution /Users/qianqian/orca/workspaces/skill-library/production-execution \
  --operations /Users/qianqian/orca/workspaces/skill-library/production-operations
# cd 到脚本输出的新目录；sources.json 记录三个来源 HEAD 与未提交状态。
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test \
  sh src/modules/collaboration/verify.sh
```

也可在最终合并仓库根目录直接运行 verify.sh。脚本安装本模块及 product/identity/persistence 自身 lockfile，构建正式 UI、检查类型、运行产品/广播及 8 项真实 PG/Chrome 场景；缺 DATABASE_URL / Chrome 直接失败，不跳过。默认端口 18754，可设置 `COLLABORATION_PORT`；`CHROME_PATH` 指向 Chrome/Chromium 可执行文件。测试串行运行，每项独立 schema、两个 browser context、独立 Cookie，启动/浏览器失败同样清理资源。

延迟响应测试用 Playwright `route.fetch()` 真实请求并延后原响应；发布丢包用真实提交后 abort，不生成假业务数据。重复/乱序通知的确定性调度另由 ProductEditor 组件 fixture 覆盖；真实 SSE 测试覆盖断线、重连、连续发布和读取最新版。执行 UI 使用明确命名的 fixture provider，只证明真实宿主/PG/HTTP/Chrome 集成；没有真实模型调用证据。

截图写入本模块 `test-results/`（不入 Git）。具体结果、已提交依赖与外部验收步骤见 `docs/acceptance/production-collaboration.md`。
