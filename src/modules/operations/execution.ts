import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { IdentityService } from "../identity/types.ts";
export interface ExecutionExtension {
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}
export type ExecutionFactory = (context: {
  pool: Pool;
  identity: IdentityService;
}) => ExecutionExtension | Promise<ExecutionExtension>;
/** Only loads the actual module. Missing source/config is a startup error, never a fixture fallback. */
export function productionExecutionFactory(config: {
  apiKey: string;
  model: string;
}): ExecutionFactory {
  return async ({ pool, identity }) => {
    const moduleUrl = new URL("../execution/index.ts", import.meta.url).href;
    const {
      createExecutionService,
      createAnthropicProvider,
      createExecutionHttpHandler,
    } = await import(moduleUrl);
    const execution = createExecutionService({
      pool,
      provider: createAnthropicProvider(config),
    });
    return {
      handle: createExecutionHttpHandler({ execution, identity }),
      start: () => execution.start(),
      stop: () => execution.stop(),
    };
  };
}
