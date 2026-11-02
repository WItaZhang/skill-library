# 正式技能管理前端

正式入口为 `main.tsx` / `App.tsx`，构建输出 `dist`，由 `src/integration/production-start.ts` 提供同源 HTTP。依赖已完成的 identity、persistence、broadcast 和 web 公共组件；它们保持各自目录所有权。

`Product.tsx` 保持列表 → 详情 → 独立编辑器。`Editor.tsx` 从冻结版编辑器继承保存/同步/发布竞态处理，并将修改说明、资源路径和进行中的写入纳入离开保护。`management.tsx` 负责元信息冲突对照、归档恢复、服务端作者草稿列表和历史比较。恢复历史每次创建独立新草稿，服务端以当前正式版为基线，不修改历史。

`client.ts` 创建可销毁的用户/会话/团队/角色 scope：请求带 X-Team-Id、X-CSRF-Token；SSE 带 teamId 选择器，身份仍由 Cookie 验证。销毁会中止请求、拒绝迟到结果、关闭 SSE、删除该身份的草稿 ID 缓存。服务端每次请求与 SSE 轮询重验成员；客户端收到 403 即关闭工作区，另在窗口重新聚焦和每 15 秒复核会话/角色。用户主动切换或退出先确认未保存输入；会话失效或权限撤销直接清除旧工作区，不保留可继续访问的内容。

`fixture.ts` 仅被组件测试引用；生产入口无内存 demo、伪身份、演示控制。访客演示仍使用独立 `src/integration/browser.tsx`、`server.ts`、`start.ts` 和旧 compose.py，建议不同 origin/端口。正式服务器不路由 `/api/demo/*`。

## 第 4–6 阶段集成

正式任务页挂载 execution 的 `ExecutionPanel`，由 ProductScope 注入携带身份/CSRF 的 execution client。详情“使用技能”预选当前技能，任务列表、创建与详情分开；查看者只见权限说明，不调用编辑者专用执行 API。执行表单把脏状态交给工作区离开保护。访客 TaskPage 保留原演示流程，正式入口不再引用它。

每个工作区复用一条 SSE，编辑器订阅复用此连接。身份/角色撤销的 `access.revoked` 控制事件立即销毁整个 scope、所有请求/执行客户端与缓存，不等 React 卸载；普通断网/503 保留输入。重新连接核对 session、成员角色及正式版本，不能把旧身份内容带入新工作区。

发布丢包后的原请求重试只清理原发布的修改说明，保留后续说明/正文。预览超越在途版本查询时等待权威核对后再判定有效性；旧保存/预览/同步响应不能覆盖后续输入。确认同步期间新输入保留在恢复对照区，明确整合前暂停自动保存和发布。

最终构建依赖 execution 与 operations 的已提交接口，不往本 worktree 复制他人源码。`src/modules/collaboration/assemble.py` 可只读导出组合目录；完整复现见 `docs/acceptance/production-collaboration.md`。

复现、真实数据库和 Chrome 验收命令见 `docs/acceptance/production-product.md`。OAuth 集成测试显式使用 testProvider；没有真实 GitHub 凭证验证。邀请 token 在登录前临时存入 sessionStorage，接受成功后删除。
