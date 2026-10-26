# Skill Library Web v2

独立中文 React / TypeScript / Vite 应用，只依赖共享 contracts，不导入 service、runtime 或 broadcast 实现。生产身份由宿主负责。

## 启动与验证

Node >=24，从仓库根目录运行：

```sh
npm ci --prefix src/modules/web
npm run dev --prefix src/modules/web -- --port 5174
npm run typecheck --prefix src/modules/web
npm test --prefix src/modules/web
npm run build --prefix src/modules/web
```

独立入口是明确标记的一次性内存演示；刷新重置数据。编辑器的“演示：模拟另一作者发布新版”会以另一个演示作者创建、保存并发布草稿，再通过注入的 SkillUpdateSource 发送已提交事件。演示按文件做三方比较，不是实际服务的文本合并、持久化、事务、HTTP/SSE 或真实 Agent 验收证据。两个真实浏览器客户端的跨进程联调由组合验收完成。

## 宿主接线

```tsx
<App library={libraryClient} runtime={runtimeClient} actor={hostActor}
  updateSource={skillUpdateSource} initialSessionId={hostSessionId} />
```

`updateSource` 为可选注入参数，连接真实服务时必须提供。宿主切换身份时应重挂载整个 App；前端 Actor 不是服务端身份凭证。事件按当前编辑 Skill 和团队过滤，序号去重；只触发权威 getSkill 核对，不使用事件正文更改草稿。打开和每次重连都核对，连续事件合并请求，卸载取消监听。会话运行时策略和已有会话刷新行为保持不变。

- 无人工评审导航或提案操作。publishDraft 绑定修订、基线、说明与幂等键，成功显示自动生效。历史保留已有真实评审人；新版本 reviewerId 为 null。
- 过期草稿仍可编辑、保存，只有作者确认同步后才可发布。自动保存防抖 1.8 秒，失败不循环重试。
- 更新比较传递当前未保存内容，展示基础、本地、最新、双方差异及候选。每个重叠路径需明确采用新版、保留本地、手动文本或删除；空文本与删除不同。无重叠也必须勾选确认。
- applyDraftUpdate 用服务令牌原子推进内容和基线。目标、修订或本地输入变化使旧预览失效；刷新比较保留手动选择，但必须重新检查。服务器修订冲突可读取服务器草稿，对照后明确采用修订号，本地输入不替换。
- 保存、预览、应用和发布共享互斥请求守卫。比较面板打开时暂停自动保存。文本输入在请求期间仍可编辑，旧响应只更新已保存快照，不覆盖后续输入。应用期间输入会进入明确的对照恢复区，展示服务端已同步内容；自动保存及发布持续暂停，直到作者整合并确认恢复。
- 发布失败显示“重试原发布请求”，保留原始完整请求及幂等键；即使发布已成功但响应丢失，也能查询同一结果而不重复发布。本地后续输入保留。既有维护者即使角色为 viewer 也保留服务授权的编辑能力；其他 viewer 不能编辑。
- sessionStorage 仅存按团队/作者/技能/来源隔离的草稿 ID；未保存正文不持久化到浏览器，离开及关闭页面有提示。

D1：版本选择只影响本会话后续任务。D2：保留实际使用过的旧版直到选择新版或结束会话。D3：未选择则新任务默认最新。这些仍是暂定默认策略；当前任务、子任务、重试和恢复固定原快照，跨库任务接受顺序仍由宿主保证。

没有订阅产品、通知中心、外部消息、真实登录或 Agent 执行。首次创建技能、维护者管理、审计运维和二进制资源 UI 仍在本次范围之外；文本以原文安全显示。
