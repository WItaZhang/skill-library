# 运维宿主跨模块契约（4/5/6）

基线 `daa1e826a684efac988c5936ddb3fa6acc94310f`，operations 负责 `integration/production-server.ts` 与 `production-start.ts`。2026-11-01 先行公布；实际 execution 导出就绪后在这里固定最终签名。

- 同一个宿主 `pg.Pool` 注入 identity、persistence library/runtime、execution。启动先 `await migrate(pool)`，失败不 listen；模块不得关闭池。生产单实例（pending OAuth state 在内存），数据库使用持久 volume。
- execution 请导出工厂、HTTP handler、显式 start/stop lifecycle。建议 `createExecutionService({pool,runtime,provider,...})`，`createExecutionHttpHandler({execution,resolveActor,assertCsrf,publicOrigin})` 返回异步 `(req,res)=>boolean`；`start()` 开始领取，`close()/stop()` 停止领取并有界等待/取消外部调用。实际签名以 execution README/类型为准，由 operations 适配。
- HTTP 路径统一 `/api/execution/<method>`。请尽早列出读取/接受/重试/子任务/取消路径，宿主按身份 + IP 限制写入和执行成本；仅接受可信 identity 身份，不信任请求 Actor 或任意 X-Forwarded-For。
- 执行成本限流应在产生收费尝试之前生效；HTTP 层限制接受/重试/子任务次数，worker 内的并发/超时/每任务调用次数由 execution 保证。外部调用必须在数据库事务外。重复请求消耗 HTTP 配额可接受，不得产生额外远端执行。
- 优雅关闭：先 readiness=false、停止接入和领取，关闭 SSE，再有界等待正在进行请求/执行，最后宿主关闭 Pool。liveness `/healthz`、数据库 readiness `/readyz`、私有 `/metrics`；request id 由宿主生成并响应，结构化日志仅记录路由类别/状态/耗时及安全错误码，不记正文、Cookie、邀请、OAuth query 或完整结果。
- 4 继续拥有 Product/App，5 的 React ExecutionPanel 由 4 挂载；6 保留原访客/HTTP/Chrome 回归。4 请在自身 collaboration 目录提供无凭据也可运行的真实 PG + 双 context 浏览器命令，缺 PG/Chrome 必须失败，不 skip 绿灯。
- CI 从最终合并仓库安装各模块自身 lockfile，运行 typecheck/build、真实 PG、浏览器关键回归。operations 独立分支先运行可用基线；临时组合测试使用导出目录，不修改任何其他 worktree。
- 外部 GitHub OAuth、真实模型调用、公网 HTTPS 分别验收；testProvider/fixture 只证明本地 HTTP/PG/浏览器集成。
