import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  DomainError,
  type Actor,
  type SkillVersion,
} from "../../contracts/index.ts";
import type {
  AcceptExecutionInput,
  RetryExecutionInput,
  ExecutionRecord,
  ExecutionStatus,
} from "../../contracts/execution.ts";
import { createStore } from "./store.ts";
import { createPostgresRuntimeService } from "./runtime.ts";

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = (
  code: "VALIDATION" | "CONFLICT" | "FORBIDDEN" | "NOT_FOUND",
  message: string,
): never => {
  throw new DomainError(code, message);
};
const date = (v: Date | null) => v?.toISOString() ?? null;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface ExecutionClaim {
  id: string;
  attemptId: string;
  actor: Actor;
  prompt: string;
  skillIds: string[];
  taskId: string;
}
export function createExecutionRepository({
  pool,
  provider,
  model,
  maxAttempts,
  leaseMs,
}: {
  pool: Pool;
  provider: string;
  model: string;
  maxAttempts: number;
  leaseMs: number;
}) {
  const { transaction, query } = createStore(pool);
  const runtime = createPostgresRuntimeService({ pool });
  const permitted = (actor: Actor) => {
    if (actor.role === "viewer") fail("FORBIDDEN", "当前权限不能执行任务");
  };
  const owned = async (actor: Actor, id: string) => {
    if (!uuid(id)) fail("VALIDATION", "任务标识无效");
    const row = (
      await query(
        "SELECT * FROM execution_requests WHERE id=$1 AND team_id=$2 AND owner_id=$3",
        [id, actor.teamId, actor.userId],
      )
    ).rows[0];
    if (!row) fail("NOT_FOUND", "执行任务不存在");
    return row;
  };
  const record = async (actor: Actor, id: string): Promise<ExecutionRecord> => {
    const row = await owned(actor, id);
    const attempts = (
      await query(
        "SELECT * FROM execution_attempts WHERE execution_id=$1 ORDER BY number",
        [id],
      )
    ).rows;
    const result = (
      await query(
        "SELECT r.text,r.attempt_id,a.provider_request_id FROM execution_results r JOIN execution_attempts a ON a.id=r.attempt_id WHERE r.attempt_id=$1",
        [row.current_attempt_id],
      )
    ).rows[0];
    return {
      id: row.id,
      taskId: row.task_id,
      teamId: row.team_id,
      ownerId: row.owner_id,
      prompt: row.prompt,
      status: row.status,
      skillIds: (
        await query(
          "SELECT skill_id FROM execution_skills WHERE execution_id=$1 ORDER BY skill_id",
          [id],
        )
      ).rows.map((r) => r.skill_id),
      snapshot: await runtime.getTask(actor, row.task_id),
      attempts: attempts.map((a) => ({
        id: a.id,
        number: a.number,
        status: a.status,
        provider: a.provider,
        model: a.model,
        providerRequestId: a.provider_request_id,
        errorCode: a.error_code,
        createdAt: date(a.created_at)!,
        startedAt: date(a.started_at),
        finishedAt: date(a.finished_at),
      })),
      result:
        result && row.status === "succeeded"
          ? {
              text: result.text,
              attemptId: result.attempt_id,
              providerRequestId: result.provider_request_id,
            }
          : null,
      createdAt: date(row.created_at)!,
      updatedAt: date(row.updated_at)!,
    };
  };
  const receipt = async (
    actor: Actor,
    operation: string,
    key: string,
    fingerprint: string,
  ) => {
    if (typeof key !== "string" || key.length < 1 || key.length > 128)
      fail("VALIDATION", "幂等键无效");
    const row = (
      await query(
        "SELECT * FROM execution_receipts WHERE team_id=$1 AND owner_id=$2 AND operation=$3 AND key=$4",
        [actor.teamId, actor.userId, operation, key],
      )
    ).rows[0];
    if (row && row.fingerprint !== fingerprint)
      fail("CONFLICT", "幂等键已经用于另一请求");
    return row?.execution_id as string | undefined;
  };
  const saveReceipt = (
    actor: Actor,
    operation: string,
    key: string,
    fingerprint: string,
    id: string,
  ) =>
    query(
      "INSERT INTO execution_receipts(team_id,owner_id,operation,key,fingerprint,execution_id) VALUES($1,$2,$3,$4,$5,$6)",
      [actor.teamId, actor.userId, operation, key, fingerprint, id],
    );
  const queueLimit = async (actor: Actor) => {
    const count = Number(
      (
        await query(
          "SELECT count(*) FROM execution_requests WHERE team_id=$1 AND owner_id=$2 AND status IN ('queued','claimed','running')",
          [actor.teamId, actor.userId],
        )
      ).rows[0].count,
    );
    if (count >= 10) fail("CONFLICT", "待执行任务过多，请等待现有任务完成");
  };
  const get = (actor: Actor, id: string) =>
    transaction(actor, false, async (a) => {
      permitted(a);
      return record(a, id);
    });
  return {
    get,
    list: (actor: Actor) =>
      transaction(actor, false, async (a) => {
        permitted(a);
        const rows = (
          await query(
            "SELECT id FROM execution_requests WHERE team_id=$1 AND owner_id=$2 ORDER BY created_at DESC,id DESC LIMIT 30",
            [a.teamId, a.userId],
          )
        ).rows;
        const records: ExecutionRecord[] = [];
        for (const row of rows) records.push(await record(a, row.id));
        return records;
      }),
    accept: (actor: Actor, input: AcceptExecutionInput) =>
      transaction(actor, true, async (a) => {
        permitted(a);
        if (
          !input ||
          typeof input.prompt !== "string" ||
          !input.prompt.trim() ||
          Buffer.byteLength(input.prompt) > 16384 ||
          !Array.isArray(input.skillIds) ||
          input.skillIds.length < 1 ||
          input.skillIds.length > 10 ||
          !input.skillIds.every(uuid)
        )
          fail("VALIDATION", "请输入任务内容并选择 1–10 个技能");
        if (
          (input.sessionId !== undefined && !uuid(input.sessionId)) ||
          (input.parentTaskId !== undefined && !uuid(input.parentTaskId))
        )
          fail("VALIDATION", "会话或父任务标识无效");
        const skillIds = [...new Set(input.skillIds)].sort();
        const fingerprint = digest({
          prompt: input.prompt,
          skillIds,
          sessionId: input.sessionId ?? null,
          parentTaskId: input.parentTaskId ?? null,
        });
        const prior = await receipt(
          a,
          "accept",
          input.idempotencyKey,
          fingerprint,
        );
        if (prior) return record(a, prior);
        await queueLimit(a);
        // Nested RuntimeService calls join this very same Pool transaction/team lock.
        const taskId = randomUUID();
        const snapshot = input.parentTaskId
          ? await runtime.createChildTask(a, input.parentTaskId, taskId)
          : await runtime.createTask(
              a,
              input.sessionId ?? (await runtime.createSession(a)).id,
              taskId,
            );
        if (input.sessionId && snapshot.sessionId !== input.sessionId)
          fail("CONFLICT", "父任务不属于此会话");
        for (const skillId of skillIds)
          if (!snapshot.versions[skillId])
            fail("VALIDATION", "所选技能不在任务固定版本中");
        const id = randomUUID();
        await query(
          "INSERT INTO execution_requests(id,team_id,task_id,session_id,owner_id,prompt,provider,model,max_attempts) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            id,
            a.teamId,
            taskId,
            snapshot.sessionId,
            a.userId,
            input.prompt,
            provider,
            model,
            maxAttempts,
          ],
        );
        for (const skillId of skillIds)
          await query(
            "INSERT INTO execution_skills(team_id,execution_id,task_id,skill_id,version_id) VALUES($1,$2,$3,$4,$5)",
            [a.teamId, id, taskId, skillId, snapshot.versions[skillId]],
          );
        await saveReceipt(a, "accept", input.idempotencyKey, fingerprint, id);
        return record(a, id);
      }),
    retry: (actor: Actor, input: RetryExecutionInput) =>
      transaction(actor, true, async (a) => {
        permitted(a);
        if (!input || !uuid(input.executionId))
          fail("VALIDATION", "执行任务标识无效");
        const fingerprint = digest({
          executionId: input.executionId,
          acknowledgeUncertain: input.acknowledgeUncertain === true,
        });
        const prior = await receipt(
          a,
          "retry",
          input.idempotencyKey,
          fingerprint,
        );
        if (prior) return record(a, prior);
        const row = await owned(a, input.executionId);
        if (!["failed", "uncertain", "cancelled"].includes(row.status))
          fail("CONFLICT", "当前任务不能重试");
        // Cancellation after dispatch is also potentially billed remotely.
        const remote = (
          await query("SELECT started_at FROM execution_attempts WHERE id=$1", [
            row.current_attempt_id,
          ])
        ).rows[0]?.started_at;
        if (
          (row.status === "uncertain" ||
            (row.status === "cancelled" && remote)) &&
          input.acknowledgeUncertain !== true
        )
          fail("CONFLICT", "上次调用可能已产生费用，请确认后再试");
        if (row.attempt_count >= row.max_attempts)
          fail("CONFLICT", "此任务已达到执行次数上限");
        if (row.provider !== provider || row.model !== model)
          fail("CONFLICT", "提供方配置已变更，请恢复原模型后重试");
        await queueLimit(a);
        await query(
          "UPDATE execution_requests SET status='queued',updated_at=clock_timestamp() WHERE id=$1",
          [row.id],
        );
        await saveReceipt(
          a,
          "retry",
          input.idempotencyKey,
          fingerprint,
          row.id,
        );
        return record(a, row.id);
      }),
    cancel: (actor: Actor, id: string) =>
      transaction(actor, true, async (a) => {
        permitted(a);
        const row = await owned(a, id);
        if (["queued", "claimed", "running"].includes(row.status)) {
          await query(
            "UPDATE execution_attempts SET status='cancelled',error_code='CANCELLED',finished_at=clock_timestamp() WHERE id=$1 AND status IN ('claimed','running')",
            [row.current_attempt_id],
          );
          await query(
            "UPDATE execution_requests SET status='cancelled',updated_at=clock_timestamp() WHERE id=$1",
            [id],
          );
        }
        return record(a, id);
      }),
    claim: async (executionId?: string): Promise<ExecutionClaim | null> => {
      if (executionId !== undefined && !uuid(executionId))
        fail("VALIDATION", "执行任务标识无效");
      // The scan is only a hint. The team lock plus conditional row lock is the authority.
      const candidates = (
        await pool.query(
          "SELECT id,team_id,owner_id FROM execution_requests WHERE status='queued' AND provider=$1 AND model=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at,id LIMIT 30",
          [provider, model, executionId ?? null],
        )
      ).rows;
      for (const candidate of candidates) {
        const actor: Actor = {
          userId: candidate.owner_id,
          teamId: candidate.team_id,
          role: "viewer",
        };
        try {
          const claimed = await transaction(actor, true, async (a) => {
            permitted(a);
            const r = (
              await query(
                "SELECT * FROM execution_requests WHERE id=$1 AND status='queued' FOR UPDATE SKIP LOCKED",
                [candidate.id],
              )
            ).rows[0];
            if (!r) return null;
            if (r.attempt_count >= r.max_attempts) {
              await query(
                "UPDATE execution_requests SET status='failed',updated_at=clock_timestamp() WHERE id=$1",
                [r.id],
              );
              return null;
            }
            const attemptId = randomUUID();
            await query(
              "INSERT INTO execution_attempts(id,team_id,execution_id,task_id,number,status,provider,model,lease_expires_at) VALUES($1,$2,$3,$4,$5,'claimed',$6,$7,clock_timestamp()+$8*interval '1 millisecond')",
              [
                attemptId,
                a.teamId,
                r.id,
                r.task_id,
                r.attempt_count + 1,
                provider,
                model,
                leaseMs,
              ],
            );
            await query(
              "UPDATE execution_requests SET status='claimed',current_attempt_id=$2,attempt_count=attempt_count+1,updated_at=clock_timestamp() WHERE id=$1",
              [r.id, attemptId],
            );
            const skillIds = (
              await query(
                "SELECT skill_id FROM execution_skills WHERE execution_id=$1 ORDER BY skill_id",
                [r.id],
              )
            ).rows.map((x) => x.skill_id);
            return {
              id: r.id,
              attemptId,
              actor: a,
              prompt: r.prompt,
              skillIds,
              taskId: r.task_id,
            };
          });
          if (claimed) return claimed;
        } catch (error) {
          if (!(error instanceof DomainError && error.code === "FORBIDDEN"))
            throw error;
        }
      }
      return null;
    },
    begin: async (claim: ExecutionClaim): Promise<SkillVersion[] | null> =>
      transaction(claim.actor, true, async (a) => {
        permitted(a);
        const r = await owned(a, claim.id);
        const attempt = (
          await query(
            "SELECT id FROM execution_attempts WHERE id=$1 AND status='claimed' AND lease_expires_at>clock_timestamp()",
            [claim.attemptId],
          )
        ).rows[0];
        if (
          r.status !== "claimed" ||
          r.current_attempt_id !== claim.attemptId ||
          !attempt
        )
          return null;
        const skills: SkillVersion[] = [];
        for (const id of claim.skillIds) {
          skills.push(await runtime.resolveSkill(a, claim.taskId, id));
          await runtime.recordInvocation(a, claim.taskId, id);
        }
        await query(
          "UPDATE execution_attempts SET status='running',started_at=clock_timestamp(),lease_expires_at=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1",
          [claim.attemptId, leaseMs],
        );
        await query(
          "UPDATE execution_requests SET status='running',updated_at=clock_timestamp() WHERE id=$1",
          [claim.id],
        );
        return skills;
      }),
    live: async (claim: ExecutionClaim) =>
      transaction(claim.actor, false, async (a) => {
        permitted(a);
        const r = await owned(a, claim.id);
        return (
          r.status === "running" &&
          r.current_attempt_id === claim.attemptId &&
          !!(
            await query(
              "SELECT 1 FROM execution_attempts WHERE id=$1 AND lease_expires_at>clock_timestamp()",
              [claim.attemptId],
            )
          ).rowCount
        );
      }),
    noteRequestId: async (claim: ExecutionClaim, id: string) =>
      transaction(claim.actor, true, async (a) => {
        permitted(a);
        const r = await owned(a, claim.id);
        if (r.current_attempt_id === claim.attemptId && r.status === "running")
          await query(
            "UPDATE execution_attempts SET provider_request_id=$2 WHERE id=$1 AND status='running'",
            [claim.attemptId, id.slice(0, 256)],
          );
      }),
    finish: async (
      claim: ExecutionClaim,
      outcome: {
        status: "succeeded" | "failed" | "uncertain";
        text?: string;
        providerRequestId?: string | null;
        errorCode?: string;
        metadata?: Record<string, unknown>;
      },
    ) =>
      transaction(claim.actor, true, async (a) => {
        permitted(a);
        const r = await owned(a, claim.id);
        const attempt = (
          await query(
            "SELECT status FROM execution_attempts WHERE id=$1 AND status IN ('claimed','running') AND lease_expires_at>clock_timestamp()",
            [claim.attemptId],
          )
        ).rows[0];
        if (
          r.current_attempt_id !== claim.attemptId ||
          !["claimed", "running"].includes(r.status) ||
          !attempt
        )
          return false;
        if (
          outcome.status === "succeeded" &&
          (attempt.status !== "running" ||
            typeof outcome.text !== "string" ||
            Buffer.byteLength(outcome.text) > 262144)
        )
          fail("VALIDATION", "执行结果无效或过大");
        if (outcome.status === "succeeded")
          await query(
            "INSERT INTO execution_results(attempt_id,team_id,execution_id,text,metadata) VALUES($1,$2,$3,$4,$5)",
            [
              claim.attemptId,
              a.teamId,
              claim.id,
              outcome.text,
              JSON.stringify(outcome.metadata ?? {}),
            ],
          );
        await query(
          "UPDATE execution_attempts SET status=$2,provider_request_id=COALESCE($3,provider_request_id),error_code=$4,finished_at=clock_timestamp() WHERE id=$1",
          [
            claim.attemptId,
            outcome.status,
            outcome.providerRequestId ?? null,
            outcome.errorCode ?? null,
          ],
        );
        await query(
          "UPDATE execution_requests SET status=$2,updated_at=clock_timestamp() WHERE id=$1",
          [claim.id, outcome.status],
        );
        return true;
      }),
    recover: async () => {
      // Internal maintenance is intentionally independent of a now-revoked actor.
      // It only closes/fences work; it never returns private content or executes it.
      const rows = (
        await pool.query(`SELECT e.id,e.team_id FROM execution_requests e LEFT JOIN execution_attempts a ON a.id=e.current_attempt_id
    WHERE e.status IN ('queued','claimed','running') AND (
     NOT EXISTS(SELECT 1 FROM team_memberships m JOIN users u ON u.id=m.user_id JOIN teams t ON t.id=m.team_id WHERE m.team_id=e.team_id AND m.user_id=e.owner_id AND m.status='active' AND m.role<>'viewer' AND u.status='active' AND t.status='active')
     OR (e.status IN ('claimed','running') AND a.lease_expires_at<=clock_timestamp())) ORDER BY e.created_at LIMIT 100`)
      ).rows;
      let count = 0;
      for (const row of rows) {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await c.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,731402662))",
            [row.team_id],
          );
          const e = (
            await c.query(
              "SELECT * FROM execution_requests WHERE id=$1 AND status IN ('queued','claimed','running') FOR UPDATE",
              [row.id],
            )
          ).rows[0];
          if (!e) {
            await c.query("COMMIT");
            continue;
          }
          const active = (
            await c.query(
              "SELECT 1 FROM team_memberships m JOIN users u ON u.id=m.user_id JOIN teams t ON t.id=m.team_id WHERE m.team_id=$1 AND m.user_id=$2 AND m.status='active' AND m.role<>'viewer' AND u.status='active' AND t.status='active'",
              [e.team_id, e.owner_id],
            )
          ).rowCount;
          const expired = (
            await c.query(
              "SELECT 1 FROM execution_attempts WHERE id=$1 AND lease_expires_at<=clock_timestamp()",
              [e.current_attempt_id],
            )
          ).rowCount;
          if (!active || expired) {
            const status: ExecutionStatus = !active
              ? "cancelled"
              : e.status === "running"
                ? "uncertain"
                : e.attempt_count >= e.max_attempts
                  ? "failed"
                  : "queued";
            await c.query(
              "UPDATE execution_attempts SET status=$2,error_code=$3,finished_at=clock_timestamp() WHERE id=$1 AND status IN ('claimed','running')",
              [
                e.current_attempt_id,
                !active
                  ? "cancelled"
                  : e.status === "running"
                    ? "uncertain"
                    : "failed",
                !active
                  ? "ACCESS_REVOKED"
                  : e.status === "running"
                    ? "LEASE_EXPIRED_UNCERTAIN"
                    : "LEASE_EXPIRED_BEFORE_DISPATCH",
              ],
            );
            await c.query(
              "UPDATE execution_requests SET status=$2,updated_at=clock_timestamp() WHERE id=$1",
              [e.id, status],
            );
            count++;
          }
          await c.query("COMMIT");
        } catch (error) {
          await c.query("ROLLBACK");
          throw error;
        } finally {
          c.release();
        }
      }
      return count;
    },
  };
}
