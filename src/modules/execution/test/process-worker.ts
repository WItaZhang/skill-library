import pg from "pg";
import { createExecutionService } from "../service.ts";
const input = JSON.parse(process.argv[2]);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: input.options,
});
const service = createExecutionService({
  pool,
  timeoutMs: 200,
  leaseMs: 400,
  provider: {
    name: "test-fixture",
    model: "deterministic-fixture",
    execute: async () => {
      process.send?.("dispatched");
      return new Promise(() => {});
    },
  },
});
process.on("message", async () => {
  await service.runOnce(input.executionId);
  await service.stop();
  await pool.end();
  process.exit(0);
});
process.send?.("ready");
