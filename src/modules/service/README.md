# Skill Library 管理服务

第一阶段可关闭的 SQLite `LibraryService`，实现共享 `src/contracts/index.ts`，不包含 HTTP、前端、推送或 Agent 执行。

```sh
npm ci --prefix src/modules/service
npm run typecheck --prefix src/modules/service
npm test --prefix src/modules/service
```

Node.js >=24；源文件为 TypeScript ESM，宿主使用 `tsx` 或支持 TypeScript 的构建流程加载 `index.ts`。独立数据库路径必须位于已存在的可写目录；测试使用临时目录。

```ts
import { createLibraryService } from './src/modules/service/index.ts';

const library = createLibraryService({
  databasePath: '/absolute/path/library.sqlite',
  // 由集成端提供同步、可信的身份/成员快照检查，不能信任浏览器传入的 Actor。
  authorizeActor: actor => trustedIdentitySnapshot.isActive(actor),
  isTeamMember: (teamId, userId) => trustedMemberSnapshot.has(teamId, userId),
  // 默认禁止修改脚本；接入现有平台权限后才能开放。
  canEditScripts: (actor, path) => trustedScriptPolicy.canEdit(actor, path),
  validatePackage: (actor, content) => platformValidator.validate(actor, content),
});
// Actor 必须由服务端根据真实身份产生。
// await library.listSkills(authenticatedActor);
// 宿主关闭时调用：
library.close();
```

示例中的 `trustedIdentitySnapshot`、`trustedMemberSnapshot`、`trustedScriptPolicy` 和 `platformValidator` 是宿主依赖占位符，本模块没有伪造生产实现。回调必须同步；异步身份查询应在进入服务前完成，并在集成阶段明确撤权与写事务的排序。没有回调时服务仅校验 Actor 结构、其角色和持久化维护者配置，不能独立证明真实身份、成员有效性或维护者属于该团队。

角色规则：viewer 可读已生效内容；contributor/admin 可创建和修改；指定维护者可修改、评审其他人的提案，即使 Actor.role 为 viewer。管理员独有维护者配置、团队审计读取权限，但不是维护者时不能评审，也不能自审。未生效 Skill 仅创建者、指定维护者和管理员可见；管理员若不是创建者/维护者仍不能获取首次草稿。个人草稿只对其作者可读写。提交时必须存在另一位有效维护者。

SQLite 使用 WAL、FULL synchronous、5 秒 busy timeout。所有变更在 `BEGIN IMMEDIATE` 事务内进行；只读方法使用读事务。版本/资源以完整 JSON 包保存于不可更新、不可删除的版本行，SHA-256 严格遵守共享契约；没有可变的外部附件地址。schema v1 随工厂初始化，模块独占该数据库结构，不要让其他模块直接修改表。

作者及当前维护者可预览 pending/changes_requested/conflicted 提案以解决冲突；已撤回、已拒绝或已合并的提案不能预览。此权限不授予作者评审或合并权。每次预览返回服务端随机 token，持久化绑定预览者、团队、提案修订、当前版本、最终内容与冲突。合并时重新比较并校验，旧 token 不能用于新版。普通文本/Markdown 用行级三方合并；其他资源双边修改按完整附件冲突处理。相同位置插入、删除/修改或复杂文本可能保守地返回冲突。每侧最多 20,000 行且 diff 编辑距离最多 2,000；超限进入人工冲突处理，不自动覆盖。

冲突解决使用共享契约流程：从当前版创建新草稿，保存解决后的完整内容，撤回旧提案，提交新提案；本模块不修改已提交内容。预览有冲突时返回全部三方内容，不自动改变提案状态；确认合并返回 `CONFLICT`。请求修改/拒绝须填写意见并审计，新提交会原子撤回同一草稿所有未合并的旧提案。

提交/合并的幂等键按团队、用户和操作隔离。重试必须使用完全相同请求字段；同键不同参数返回 `CONFLICT`。重试返回原始响应快照；如需当前提案状态再调用 `getProposal`。重新预览后应使用新幂等键；失败事务不会消耗键。重复合并仍重新验证当前权限。

内容限制：完整包最多 256 个文件、2 MiB；规范相对路径，拒绝遍历/重复/控制字符；非空 `text/markdown` 的 `SKILL.md` 必须存在。支持 `text/plain`、`text/markdown`、`text/csv`、`text/javascript`、`text/x-python`、`text/x-shellscript`、`text/yaml`、`application/json`、`application/yaml`、`application/javascript`；JSON 检查语法。Markdown 内本地链接/图片（包括有效引用式链接）须存在；代码示例不当作引用，原始 HTML 不启用，外部链接不获取。任意自然语言提及的文件、动态脚本导入、平台特定 frontmatter、YAML 语义和实际执行效果不由通用校验器保证；使用 `validatePackage` 补充平台规则。不会运行任何脚本。

`listUpdateEvents(actor, afterSequence)` 是持久化游标查询，不是订阅/通知；全局递增序号允许团队间有空隙。返回仅本团队事件，新任务查当前指针无需等待事件投递。投递确认、重试调度、消费者游标、推送监测属于集成阶段。

`faultInjector` 仅用于可控故障验收，五个阶段抛错均回滚整个合并事务。运行时错误返回中文 `DomainError`；底层异常信息不会通过响应泄漏。验收证据与生产缺口见 `docs/acceptance/service.md`。
