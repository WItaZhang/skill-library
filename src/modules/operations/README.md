# Operations

宿主共享 Pool，不写业务 DDL/不自建身份或执行数据库。

- `config.ts`：正式环境校验、互斥 env/_FILE secret 注入；不支持生产 testProvider。
- `telemetry.ts`：服务端 request id、结构化脱敏日志、私有 Prometheus 指标。
- `rate-limit.ts`：单实例 IP/可信用户写入、执行成本、SSE 连接配额；只信任明确代理 IP 的单值转发头。
- `execution.ts`：实际 execution factory 的宿主桥接。禁用时 API 明确不可用，不自动使用 fixture。
- `backup.ts` / `backup-drill.ts`：真实 pg_dump/restore；全表与序列摘要、业务版本/草稿/任务/执行记录检查。只在自动创建的新库恢复。

测试：`npm test --prefix src/modules/operations`；`DATABASE_URL=... node --test src/integration/operations.test.ts`。最终完整 `DATABASE_URL=... DRILL_ADMIN_URL=... sh src/integration/verify-release.sh` 不允许缺模块/PG/Chrome 跳过。部署与外部验收边界见 `docs/deployment/runbook.md`。
