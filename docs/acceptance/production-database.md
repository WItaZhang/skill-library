# 数据库改造验收

2026-11-01（America/Los_Angeles）。分支 `WItaZhang/production-database`，基线 main `0098e0f`。实现与本报告一并提交，最终 SHA 由交付消息及 `git log -1 --format=%H` 给出。不 merge、不 push、不启动代理。

## 实现

统一 `src/contracts/production.ts` 与 `src/modules/persistence/migrations/001-production.sql`，先公开路径供 identity/product 只读对齐。身份表保持任务书字段、UUID、timestamptz、provider/subject 唯一、last-admin 约束；users.email 不唯一，不做邮箱自动合并。业务使用真实 PostgreSQL FK、unique、check、不可变触发器；结构化 JSONB 保留既有 DTO/资源字段，关联列由数据库生成并约束。

`migrate(pool)` 使用事务级迁移锁、连续版本和 checksum ledger，拒绝未知或被改写的迁移；失败可以重试。`createPostgresLibraryService({pool})` 保留全部 LibraryService v2 语义，扩展元信息/归档/revision/listManagedSkills/listDrafts；每次从当前数据库成员关系取得权限。listDrafts 仅本人同团队同技能，updatedAt 降序，支持 UI 显式恢复。

发布的版本、指针、草稿、回执、审计和持久事件同一事务；按团队锁串行化写入。修复 JSONB 重排键导致摘要失配的问题，资源 checksum 原格式不变。归档排除新任务 catalog，历史读取和已有任务固定版本保留，成员撤销立即阻断后续调用。

额外提供 `createPostgresRuntimeService({pool})`，完整 RuntimeService 接口，与身份/技能使用同一宿主 Pool。任务接受、发布、偏好修改共用团队事务锁，任务关联及 checksum 由数据库触发器验证；不再让正式产品落回 SQLite。此单库事务保证不代表外部 Agent/跨库原子性。

`importSqlite({pool,sourceKey,servicePath,runtimePath?,users?,teams?})` 只读 SQLite，在一个 PostgreSQL 事务中导入历史、草稿、审计、回执、事件、会话、任务固定版本、偏好、调用。既有 UUID 不变；非 UUID 明确映射，原始旧行另存不可变 archive。未知用户/团队禁用，不导入登录凭证、不自动绑定邮箱。支持导入回执重试、源变化拒绝、完整失败回滚。旧预览需重新生成，映射 ID 的客户端需重载及新请求键，SSE 游标需重置。详细切换步骤见模块 README。

## 实际验证

环境：macOS arm64、Node.js 26、Homebrew PostgreSQL 17.11。安装真实 PostgreSQL，未使用 mock；未注册开机服务。临时测试 cluster 仅 loopback，测试按独立随机 schema 隔离。

从仓库根目录执行并通过：

```sh
npm ci --prefix src/modules/persistence
npm run typecheck --prefix src/modules/persistence
sh src/modules/persistence/test-local.sh
```

最后一次完整运行：**8 tests / 8 pass / 0 fail / 0 skipped**。脚本创建独立 PostgreSQL cluster，结束自动停止和清理。

| 测试 | 真实验证内容 |
| --- | --- |
| migration + concurrent publish | 双连接争抢同基线恰好一人成功；另一草稿保留；成功回执重试；同 key 不同内容拒绝；作者预览/同步再发布；旧内容不变 |
| authorization + constraints | 伪造 admin role 不生效；非作者拒绝；跨团队 API/FK 拒绝；身份唯一；版本/事件不可变；last-admin；归档 revision 冲突与恢复；移除成员拒绝 |
| publish faults | after_version/pointer/draft/request/event/audit 六阶段故障均回滚，重试成功，无半提交 |
| draft/update protections | 本人草稿发现；预览后保存或目标更新拒绝旧 apply；保留内容；草稿可空，发布严格验证；路径/脚本限制 |
| runtime | 同 Pool 任务/子任务/重试固定旧版本；新任务最新版；会话 pin/latest 与 revision 冲突；归档后新目录为空、旧任务资源保留；禁用用户拒绝 |
| SQLite import | 真实 SQLite v1 历史/评审人/草稿/任务导入；故障后目标无残留；幂等导入；原始版本 JSON 字符串保留；任务 checksum/固定版本保留；未知身份禁用；导入后新发布不改旧任务 |
| migration recovery | DDL 中途失败无 ledger/半建表；修正后重试；未知版本/漂移 checksum fail closed |
| independent processes | 两个独立 Node 进程连接 PostgreSQL 发布，同基线恰好一成功；持久事件顺序和当前版本一致 |

另用共享开发连接 `DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test npm test --prefix src/modules/persistence` 验证通过。该实例位于 `/tmp/skill-library-pg-production/data`，保留供其余模块测试；停止方式见 README。无 DATABASE_URL 时测试会明确 skip，不能视为真实数据库验收。

## 接口与依赖

本模块运行仅依赖已存在的 `src/contracts/index.ts`、新增 production.ts 和自身 manifest/lockfile，不依赖旧 SQLite service/runtime 模块。冻结源码仅作为语义移植与本地参考，复制的其他模块/integration 文件保持未提交，未更改他人 worktree。

完整产品依赖 `WItaZhang/production-identity` 与 `WItaZhang/production-product`（由各自提交/验收）。identity 注入同一 Pool，负责可信 resolveActor、Cookie/CSRF/OAuth、邀请和权限业务；product 组合 factory、HTTP 和 UI。已通过 Orca 定向通知 schema、迁移入口、测试数据库、listDrafts 及 runtime factory；无代理启动、合并或推送。

Identity 已回报 15 项其自有真实 PG/HTTP 测试通过，此处作为跨模块沟通记录，不计入本模块 8 项测试。其余模块最终组合结果及 SHA 以各自报告为准。

## 限制与恢复

- 001 最终 SHA-256：`326f63257fdc64c2715942857d96280cb6700f156e9c4d242dcbfc1f06bb2a20`。早期开发者已应用的临时 001 需使用新测试 schema；禁止修改 ledger 掩盖漂移。正式发布后只能新增迁移。
- 单团队写串行化，有吞吐权衡；尚未压测、大数据分页、托管部署、生产备份恢复演练。
- SQLite 导入需要停写的一致 service/runtime 备份；不承诺对仍在变化的多个 SQLite 文件做跨库快照。非 UUID 映射及客户端重置要求在 README 明确列出。
- 无破坏性 down migration；备份后升级，失败自动回滚，恢复应在新库校验后切换。
- Compose 配置仅提供复现选项，本机无 Docker，未执行镜像测试。真实验证使用本地 PostgreSQL。
- 未配置/验证真实 GitHub OAuth 凭据、外部 Agent 生命周期或跨数据库原子性，本模块不将其列为已验证。
