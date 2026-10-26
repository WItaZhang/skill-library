# 管理服务模块验收

状态：**模块验收通过，等待用户审阅和合并**。不是上线验收、真实身份验收或 Agent 平台验收。

## 范围与交付

- 分支：`WItaZhang/skill-service`；工作区：`/Users/qianqian/orca/workspaces/skill-library/skill-service`。
- 仅新增 `src/modules/service/**` 和本报告；共享契约、其他模块、根构建脚本未改动。
- 导出 `createLibraryService({ databasePath, ...optionalConfig })`，返回严格满足共享 `LibraryService` 的对象及幂等 `close()`；独立 package.json、package-lock.json、TypeScript 配置、说明文档。
- 真实 `node:sqlite` 数据库，独立进程测试使用独立 SQLite 连接；无内存生产替身、HTTP、订阅、推送或前端。
- 提交 SHA 通过本次 `worker_done` 报告，避免在提交内容内自引用；保留分支和 worktree，不合并、不推送、不删除。

## 命令和实际结果

执行日期：2026-10-26；macOS；系统 Node `v26.11.1`、npm `11.20.0`；兼容性测试 Node `v24.22.1`。

从工作区根目录执行：

```sh
npm ci --prefix src/modules/service
npm run typecheck --prefix src/modules/service
npm test --prefix src/modules/service
npm audit --prefix src/modules/service
git diff --check
```

结果：干净安装成功（18 个包，审计 19 个包）；类型检查成功；**17 tests / 17 pass / 0 fail / 0 skipped**（Node 26，约 0.84 秒）；依赖审计 **0 vulnerabilities**；`git diff --check` 无输出。npm 11 输出 esbuild/fsevents 安装脚本未列入 allowScripts 的提示，但安装、tsx 加载、类型检查及测试均实际成功，未修改全局 npm 策略。

从 `src/modules/service` 执行：

```sh
npm exec --yes --package=node@24 -- node --version
npm exec --yes --package=node@24 -- node --import tsx --test test/*.test.ts
```

结果：Node `v24.22.1`；**17 tests / 17 pass / 0 fail / 0 skipped**，约 0.80 秒，包括子进程并发测试。安装工具缓存不属于应用文件；所有应用依赖清单、锁文件和测试均在模块目录。

开发过程已修正的失败：首次 typecheck 对 `String.isWellFormed` 的 ES2023 lib 提示已改为 ES2024；引入完整 Markdown 解析后，一条原测试的引用定义缺少段落分隔，不是有效 Markdown 链接，修正测试输入后全部通过。依赖初次安装发现 diff/markdown-it 已知漏洞，已升级到锁定的 diff 8.0.4 / markdown-it 14.3.3，最终审计为零；没有遗留失败测试。

## 需求覆盖与证据

| 需求 | 实现及可重现实验 |
| --- | --- |
| M1 角色、团队隔离、维护者 | 每次方法调用校验 Actor；数据库所有读取按团队过滤；viewer、contributor、admin 和持久化维护者独立授权；测试覆盖跨团队 Skill、草稿、提案、版本、事件、审计、列表及创建草稿访问；草稿仅本人可读写 |
| M1 自审与撤权 | 创建/提交要求非作者维护者；作者即使 admin/maintainer 仍不能评审、合并；作者可以预览冲突；预览后撤销维护者、host gate 撤销身份时合并被拒绝；空维护者、无有效评审人返回中文校验指引 |
| M2 不可变完整版本、资源、历史 | 完整 UTF-8 包与标准 SHA-256 一同持久化；SQL 触发器禁止版本 UPDATE/DELETE；附件更新后旧资源保持不变；历史序号、作者、评审人、父版本、说明、时间可读；附件 diff、历史恢复新提案生成 v3、损坏 checksum 被拒绝均通过 |
| M2 首次生效、目录 | 首次 Skill 没有当前版本，普通 viewer 看不到且 catalogSnapshot 无映射；评审合并后才进入可用目录；名称搜索通过 |
| M3 独立草稿、乐观修订 | 两连接旧修订保存失败，最后成功内容保持；不同作者草稿独立；无变更、缺说明不提交；保存不改变已提交快照；再次提交原子撤回旧提案，旧预览/旧修订/旧评审不能生效 |
| M3/M4 提案与评审 | 每次提交新不可变快照，保留草稿关联；SQL 触发器禁止修改关键提案快照字段；请求修改、重提、拒绝、撤回及审计通过；不存在修改已提交内容的接口 |
| M4/E1 三方合并与确认 | 同一正文不同位置替换/插入形成包含双方内容的候选；当前版本变化后旧预览拒绝，必须重新确认；伪造 token 和仅替换 expectedCurrentVersionId 均拒绝 |
| M4/E2 冲突 | 同行冲突、非文本合并附件冲突返回 base/current/proposed；冲突禁止合并；复杂 diff 达上限也保守返回冲突，三方原文完整保存 |
| M4 并发 | 两个 fork OS 进程、两个独立 DB 连接在 ready barrier 后竞争同一 current 的两个提案：恰好一个成功，另一个 STALE_REVISION；重新预览后另一提案成功，v3 同时包含双方修改，恰好三版三事件 |
| M4/E12 幂等 | 两个独立进程对同一请求合并，都返回同一个版本 ID；重新打开 DB 重试仍返回同版；同键不同请求拒绝；提交幂等也通过；没有额外事件或版本 |
| M4/E11 原子性与事件 | 在 after_version、after_pointer、after_proposal、after_event、after_audit 五处逐一抛错：另一连接读到旧指针、仅旧版本/事件、pending 提案、未增加审计；原请求重试成功；幂等结果同事务写入 |
| M7 持久化、校验、审计 | 关闭工厂、新工厂与全新 OS 进程读回版本、事件、当前映射；路径遍历/重复/缺 SKILL.md/缺引用/非法类型/无效 UTF-8/非法 JSON/脚本未授权拒绝；合并结果再校验避免自动合并导致断引用；host validator 拒绝通过；创建、保存、恢复、提交、撤回、评审、配置维护者、合并均审计 |

## 事务及接口约定

1. SQLite WAL、`synchronous=FULL`、`busy_timeout=5000`；变更采用 `BEGIN IMMEDIATE` 串行化；只读方法采用读事务。服务内部事务无 `await`，所有宿主回调必须同步，不执行外部 I/O。
2. 版本、当前指针、提案状态、事件、审计与幂等记录同事务提交。事件有全局单调 sequence，团队查询允许序号有空隙；无删除/清理 API，历史资源始终保留。
3. 确认 token 为服务器随机值并持久化，仅签发的团队/预览者可用；摘要绑定提案 ID/修订、当前版本、合并内容及冲突。合并重新运行三方算法并核对，客户端不能自行生成有效 token。
4. 幂等按团队、用户、操作和键隔离，并绑定全部请求字段。请求重试返回最初成功响应快照；读取当前状态用 getProposal。成功后重新配置权限仍会影响重复请求是否可访问。
5. 管理端于 2026-10-26 澄清预览是检查操作：允许作者及当前维护者预览 pending/changes_requested/conflicted 提案，撤回/已拒绝/已合并仍拒绝；测试覆盖作者冲突预览、需修改提案可比较却不能直接合并，merge/review 仍独立校验非作者维护者与 pending。无类型变更，管理端同步 contracts/README。冲突预览不自动修改提案状态；有冲突时确认合并返回 CONFLICT。解决流程为当前版新草稿、人工解决、撤回旧提案、重新提交。未增加契约外修改提案接口。
6. D4/D6 按建议规则：contributor/admin 可创建，必须另一位维护者，只有 admin 配置维护者，至少一位；viewer 指定为维护者时可修改和评审。该权限组合可由宿主身份映射实现，不代表产品 D4-D6 已最终确认。
7. 有界内容：256 文件、2 MiB；Markdown/plain text 支持行级三方合并，其他资源按整体附件冲突。每侧超过 20,000 行或编辑距离超过 2,000 则保守冲突，不尝试语义合并。

## 明确未验收及集成缺口

- **真实身份/成员关系未提供。** 本模块接收可信服务器 Actor，可注入 authorizeActor/isTeamMember，并默认禁止脚本变更；未接回调时无法独立验证成员真实有效性或团队归属。集成不得转发浏览器任意 Actor，需提供认证、撤权和同步可信成员快照。本次仅证明角色与团队约束在可信输入边界内工作，绝不宣称生产认证完成。
- 平台 Skill frontmatter/名称规范、YAML 语义、动态脚本 import、任意自然语言文件引用与运行效果无正式规范；通用校验只保证必需 SKILL.md、规范路径、文本包、JSON 语法和解析到的 Markdown 本地链接/图片，使用 validatePackage 补足平台规则。HTML 禁用；外部链接不读取。二进制资源不支持，脚本授权仅有默认拒绝及 host callback 边界，未执行脚本。
- 没有真实 Agent、任务生命周期、子任务、恢复及会话集成；M5/M6 和完整 E5-E10/E14-E15 留给 runtime 与第二/三阶段。本报告不把静态历史资源测试称作真实运行任务版本固定验收。
- 持久事件及 cursor 查询已实现，但消费者投递状态、ACK、重试队列、推送、积压监控、延迟指标未实现；无订阅或外部通知。E11 仅证明事件和指针原子持久化，未做真实传输故障恢复。
- catalogSnapshot 单次读取一致，但与独立 runtime DB 的偏好/接受事务跨模块排序仍须第二阶段约束；实时权限撤销与 host 检查/事务的排序也须集成验证。
- 异常注入证明事务回滚；未做强制 kill/断电/磁盘满、损坏数据库修复、在线备份恢复演练或网络文件系统测试。WAL 文件需与数据库按 SQLite 推荐方式备份，不能直接只复制正在写入的主文件。
- 未做千 Skill/百会话负载、P95、长时并发公平性或安全渗透测试；同步 SQLite 与三方计算会占用 Node 线程，生产宿主需评估隔离与容量。请求/预览/审计保留暂不清理，生产需设计保留策略且不能破坏幂等重试和历史引用。

## 合并注意事项

只审阅/合并本模块与本报告；使用模块独立锁文件安装。无共享契约修改。与 runtime/web 均仅通过共享接口组合，服务数据库由本模块独占。下一阶段提供可信身份适配、HTTP 路由、宿主格式校验、事件消费者及跨模块一致性验收；D1-D6 与真实平台接入仍为发布门槛。
