# PostgreSQL persistence

共享契约：`src/contracts/production.ts`。统一 DDL：`migrations/001-production.sql` 与新增 `002-execution.sql`，共用迁移 ledger。Node >=24，PostgreSQL 17+。

```ts
import pg from 'pg';
import {migrate, createPostgresLibraryService, createPostgresRuntimeService} from './index.ts';
const pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
await migrate(pool);
const library = createPostgresLibraryService({pool});
const runtime = createPostgresRuntimeService({pool});
// Pass this SAME pool to createIdentityService({pool,...}). Host owns pool.end().
```

服务不创建、不关闭 Pool，不接收数据库路径。`createPostgresRuntimeService` 直接读取同库 catalog，无需 host 参数。用户/会话由 identity 认证；persistence 每次重新加载用户、团队和成员状态及 role，不相信调用方 role。未发布技能的可见性、维护者编辑权限、作者私有草稿、脚本默认拒绝、资源限制、v1 checksum、三方比较、显式同步和 v2 自动发布语义保留。资源/差异验证代码由冻结 service/content.ts 移植，此模块独立维护依赖。

## 结构和事务

身份核心表：users、auth_identities、auth_sessions、teams、team_memberships、team_invitations。UUID 标识、timestamptz 时间；users.email 可空且不唯一，只存已验证邮箱，不按邮箱合并身份。provider+provider_subject 唯一。成员复合主键；last-admin trigger 阻止最后一位 active admin 被降权/移除。identity 管理操作先锁 teams，再锁成员；业务层仍负责邀请邮箱验证、令牌单次使用和可信登录。

业务表：skills、versions、drafts、proposals（仅旧历史）、skill_maintainers、events、audit、requests、draft_previews。DTO 使用 JSONB 保留资源和旧历史字段；生成列抽取 UUID、版本号、作者和基线并施加真实 FK/unique/check，非无约束 JSON 文档库。技能当前指针、父版本、草稿基线和事件版本都通过 `(team_id,skill_id,version_id)` 约束，不能跨技能/团队关联。维护者由触发器同步至关系表。正式版本、事件、审计、幂等回执、预览不可 update/delete。

运行时表：runtime_sessions、runtime_tasks、runtime_task_versions、runtime_preferences、runtime_invocations。任务插入触发器核对固定版本 checksum 并建立 FK 关联；任务和调用记录不可改写。接受任务、发布和偏好变更在同一 Pool、同一 PostgreSQL 数据库内使用同一个团队事务锁，catalog 和任务提交不再存在旧 SQLite 的跨库窗口。此保证不扩展至外部 Agent 执行器或其他数据库。

事务使用每团队 PostgreSQL advisory lock 串行化写入，再按 teams→成员顺序锁定当前权限。发布基线/revision 检查、版本、指针、草稿推进、持久事件、审计、幂等回执同事务。团队锁也保证同团队事件 sequence 分配与提交顺序一致，SSE 游标不会跳过延迟提交的低序号事件。序列允许回滚空洞；锁按团队而非技能，牺牲单团队并行写吞吐以简化一致性。只读操作持有身份行共享锁；使用 READ COMMITTED，不承诺多请求全局快照。

## 管理扩展

- `listManagedSkills(actor,{query?,includeArchived?})` 可列出归档；`listSkills`/catalog 排除归档。
- `listDrafts(actor,skillId)` 只返回本团队本人草稿，updatedAt 降序（同时间按 id 降序），供 UI 显式选择恢复。getDraft 可读归档草稿。
- 新建 skill revision=1；元信息、归档、恢复、维护者变更、发布均递增。update/archive/restore 检查 expectedRevision。
- 归档不删历史；getVersion 和既有任务仍能读固定资源，所有调用仍重新检查成员资格。归档禁止新草稿/保存/发布/同步，恢复后可继续。
- 所有管理写入有审计；预览仅保存完整性凭据，不发事件。恢复旧版通过 createDraft(actor,skillId,sourceVersionId) 产生当前基线的新草稿，随后正常发布。
- JSONB 会重排键，因此请求/预览摘要使用稳定键排序。资源 checksum 保留旧约定的 path/content/mediaType 顺序，未改变内容哈希。

## 迁移、备份与恢复

`await migrate(pool)` 或 `DATABASE_URL=... npm run migrate`。迁移 ledger `production_migrations` 存版本/checksum/applied_at，事务级 advisory lock 防多进程初始化竞态，DDL 和 ledger 同事务。失败回滚后修正原因并重试；拒绝未知版本或已应用 SQL checksum 漂移。001 尚未发布过线上版本；合入后不可修改，应添加新的版本化迁移及迁移代码。

升级前停止写入并使用 PostgreSQL pg_dump 备份，保留应用 SHA；恢复在新空库用 pg_restore，再校验历史与任务资源后切换。没有自动 down migration，禁止靠删 ledger 绕过失败。生产数据库备份/恢复演练、托管与容量压测未验证。

## SQLite 导入

```ts
await importSqlite({pool, sourceKey:'backup-2026-11-01', servicePath:'/backup/library.sqlite',
  runtimePath:'/backup/runtime.sqlite', users:{legacyUserId:productionUserUuid},
  teams:{legacyTeamId:productionTeamUuid}});
```

必须在停止旧服务写入后，使用一致的 service/runtime SQLite 备份，向已迁移的空业务目标导入；identity 可提前建好用户/团队。SQLite 只读打开。所有目标记录与导入回执在一个 PostgreSQL 事务中，故障全部回滚，完全相同 sourceKey/快照可安全重试；源变化明确拒绝，不做静默合并。不同 sourceKey 对已有相同 UUID 的重复导入会冲突回滚。

既有 UUID 保持；非 UUID 标识按 sourceKey+实体类型映射成确定性 UUID；返回/保存 idMap。只重写结构化 ID 字段，不改资源文本、checksum、历史作者/评审关系、版本顺序或任务固定版本。旧行（包括 retired proposals/previews）完整原始字符串存入不可变 legacy_records。JSONB 本身不承诺原字符串键顺序，原始备份行可由 legacy_records 精确取回。

未提供映射的旧用户/团队生成 disabled 占位记录，成员为 removed/viewer，不创建登录身份；禁止凭邮箱自动绑定或导入演示凭证。管理员需显式核对映射/启用权限。旧预览必须重新生成；导入后客户端重置 SSE 游标（事件按源顺序分配新序号）。旧成功回执保留；UUID 未变的原 payload 可按旧摘要重试；发生 ID 映射的客户端应重载对象并使用新幂等键。旧待审提案只作历史，不能绕过 v2 发布。

## 实际测试

```sh
cd src/modules/persistence
npm ci
npm run typecheck
sh test-local.sh
# 或已有数据库（每项测试独立随机 schema，不清空 public）
DATABASE_URL=postgresql://skill_library@127.0.0.1:55432/skill_library_test npm test
```

`test-local.sh` 默认 Homebrew PostgreSQL 17，创建一次性本地 cluster，结束后停止清理；Linux 设置 PG_TEST_BIN=/usr/lib/postgresql/17/bin。默认 PG_TEST_PORT=55439 可覆盖。仅本地测试使用 trust，禁止用于部署。无 DATABASE_URL 的 npm test 会明确 skip 数据库测试，不作为验收通过。

开发期间共享测试实例位于 `/tmp/skill-library-pg-production/data`，loopback 55432，用户 skill_library，无密码；保留供 identity/product 验证。全部工作结束后可用 `/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /tmp/skill-library-pg-production/data -m fast stop` 停止。未注册开机服务。

另提供 compose.yaml（仅临时测试 tmpfs）；本机没有 Docker，Compose 未执行。真实验收使用本地 PostgreSQL 17.11，不是 mock。


## 执行增量（002）

002 不修改 001，不改旧任务快照。新增 execution_requests、execution_skills、execution_attempts、execution_results、execution_receipts；team/task/session/owner/attempt/status/provider/model/request id/error/timestamps 均为显式列，文本结果、prompt 也是普通列，仅提供方元数据 JSONB。复合 FK 阻止跨团队、跨任务或不同 session owner 关联；结果、技能选择、回执不可改写。

createStore 的 AsyncLocalStorage 现在按同一 Pool 共享：外层 execution 接受事务中的 RuntimeService 创建会话/任务直接加入此事务，不再单独 COMMIT。嵌套调用必须同 user/team 且不能从只读升级写入；外层负责唯一提交与回滚，团队 advisory lock 和身份行锁仍按旧顺序持有。只有数据库操作进入此范围，外部提供方调用严格在事务提交以后。旧 RuntimeService 工厂/接口保持兼容。

状态机、领取租约、取消和不确定调用处理详见 [execution README](../execution/README.md)。升级测试实际从有版本/任务的 001 数据库迁移到 002，核对旧内容/快照完全不变。
