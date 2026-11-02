# Skill Library 管理服务 v2

SQLite `LibraryService` 实现共享 v2 契约，入口保持 `createLibraryService`。Node.js >=24；可使用原生 TypeScript stripping 或 `tsx` 加载 `index.ts`。

```sh
npm ci --prefix src/modules/service
npm run typecheck --prefix src/modules/service
npm test --prefix src/modules/service
```

宿主传入 `databasePath`，关闭时调用 `close()`。`Actor` 必须由可信服务端身份生成；可提供同步 `authorizeActor`、`isTeamMember`、`canEditScripts`、`validatePackage` 回调。没有身份回调时仅校验角色和存储的权限信息，不代表生产认证。默认禁止脚本修改；包校验回调只在发布时执行，不执行脚本。

作者可独立创建和发布，维护者清单可为空。contributor/admin 可编辑；指定维护者即使为 viewer 也可编辑。管理员配置维护者和读取团队审计；草稿仅作者可访问。未生效 Skill 仅创建者、维护者和管理员可见。所有操作仍校验团队和当前权限，包括成功请求重放。

`publishDraft` 是唯一发布入口，不提供旧 submit/review/merge 等方法。草稿修订、请求基线、保存的基线和当前版本必须一致，任何过期基线均返回 `STALE_REVISION`，不会自动合并。发布在一个 `BEGIN IMMEDIATE` 事务中写入不可变版本、当前指针、推进作者草稿、发布事件、审计和幂等回执。新版本 `reviewerId:null`、`approvalMode:'automatic'`。

`previewDraftUpdate` 接受未保存内容，复制并校验结构，返回基础/本地/最新内容、双方差异、三方候选和冲突；不修改保存的草稿。服务端随机 token 的持久快照及摘要绑定用户、团队、草稿、修订、原基线、本地输入和目标版本。普通文本使用行级合并；附件双边修改、删除/修改和复杂文本保守返回冲突，保留三方内容。

`applyDraftUpdate` 是作者显式确认；重新校验 token、修订、原基线和当前目标后，原子保存 resolvedContent 与新基线并递增修订。解决内容由作者决定，文件缺失表示删除，空字符串表示保留空文件。客户端必须明确展示并解决冲突；预览后又有本地输入时，必须使旧预览失效或明确纳入最新修改。契约不传入客户端编辑计数，服务端不能发现尚未发送的新输入，但另一个标签页的保存会使旧 token 失效。保存必须使用最新修订，避免旧自动保存覆盖已应用结果。

发布和应用幂等键按团队、用户、操作隔离；完全相同请求重试返回原始响应，同键不同内容返回 `CONFLICT`。重放不重新写入事件或审计，失败事务不消耗键。客户端需要当前草稿时重新 getDraft，不能将旧回执作为当前编辑内容。

草稿创建/保存/预览/应用只做结构、路径、UTF-8 文本、类型、最多256文件/2 MiB和脚本权限检查，允许缺失/空 SKILL.md、未补齐引用、未完成 JSON。发布额外要求非空 Markdown SKILL.md、JSON语法、本地 Markdown 引用完整和宿主包校验。不解析平台特定 frontmatter、YAML语义或动态导入；宿主可补充校验。

SQLite 使用 WAL、FULL synchronous 和5秒 busy timeout。schema v1 初始化时增加独立的 draft_previews 表并升级标记为2，不修改旧版本、旧提案、事件或审计内容。旧草稿继续用 getDraft/saveDraft；过期时 preview/apply 后发布。旧待评审提案仅保留历史存储，不能经任何服务方法发布。版本和事件保留不可更新/删除触发器。

仅发布写入持久更新事件；`listUpdateEvents(actor, afterSequence)` 按团队返回，序号允许团队间空隙。保存、预览、应用、失败和重放均不广播。HTTP/SSE、浏览器输入竞态、生产认证和真实 Agent 接入由其他模块/集成验收负责。

`faultInjector` 支持 after_version、after_pointer、after_draft、after_event、after_audit、after_request，抛错回滚整个事务。验收见 `docs/acceptance/service-v2.md`。
