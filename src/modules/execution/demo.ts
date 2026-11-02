/** Deliberately no fallback provider or fabricated credentials. One accepted task, one call. */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createExecutionService, createAnthropicProvider } from "./index.ts";
const names = [
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "EXECUTION_MODEL",
  "EXECUTION_DEMO_USER_ID",
  "EXECUTION_DEMO_TEAM_ID",
  "EXECUTION_DEMO_SKILL_ID",
] as const;
const missing = names.filter((n) => !process.env[n]?.trim());
if (missing.length) {
  console.error(`真实演示未执行，缺少配置：${missing.join(", ")}`);
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const provider = createAnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: process.env.EXECUTION_MODEL!,
    workspaceId: process.env.ANTHROPIC_WORKSPACE_ID,
  });
  const service = createExecutionService({
    pool,
    provider,
    maxAttempts: 1,
    maxOutputTokens: 256,
  });
  try {
    const actor = {
      userId: process.env.EXECUTION_DEMO_USER_ID!,
      teamId: process.env.EXECUTION_DEMO_TEAM_ID!,
      role: "viewer" as const,
    };
    // Existing real membership and published skill are required; the role above is reloaded in PG.
    const accepted = await service.accept(actor, {
      prompt:
        process.env.EXECUTION_DEMO_PROMPT ??
        "用中文简要概括所选技能可以完成的任务，并说明采用的技能版本。",
      skillIds: [process.env.EXECUTION_DEMO_SKILL_ID!],
      idempotencyKey: process.env.EXECUTION_DEMO_KEY ?? randomUUID(),
    });
    await service.runOnce(accepted.id);
    const result = await service.get(actor, accepted.id);
    console.log(
      JSON.stringify(
        {
          evidence: "real-anthropic-api",
          executionId: result.id,
          taskId: result.taskId,
          status: result.status,
          versions: result.snapshot.versions,
          attempts: result.attempts,
          result: result.result,
        },
        null,
        2,
      ),
    );
    if (result.status !== "succeeded") process.exitCode = 1;
  } catch (error) {
    console.error(
      "真实演示未通过：",
      error instanceof Error ? error.message : "执行错误",
    );
    process.exitCode = 1;
  } finally {
    await service.stop();
    await pool.end();
  }
}
