import type { Pool } from "pg";
import { DomainError } from "../../contracts/index.ts";
import type {
  ExecutionProvider,
  ExecutionService,
  ExecutionLifecycle,
} from "../../contracts/execution.ts";
import { createExecutionRepository } from "../persistence/execution.ts";
import { ProviderError } from "./provider.ts";
export interface ExecutionOptions {
  pool: Pool;
  provider: ExecutionProvider;
  pollIntervalMs?: number;
  timeoutMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  maxOutputTokens?: number;
  /** Receives only a safe code. Host may increment a metric/log without private text. */
  onError?: (code: string) => void;
}
export function createExecutionService({
  pool,
  provider,
  pollIntervalMs = 1000,
  timeoutMs = 60000,
  leaseMs = 90000,
  maxAttempts = 3,
  maxOutputTokens = 2048,
  onError = () => {},
}: ExecutionOptions): ExecutionService & ExecutionLifecycle {
  const bounded = (n: number, min: number, max: number) =>
    Number.isSafeInteger(n) && n >= min && n <= max;
  if (
    !provider?.name ||
    !provider.model ||
    !bounded(pollIntervalMs, 20, 60000) ||
    !bounded(timeoutMs, 20, 120000) ||
    !bounded(leaseMs, timeoutMs + 100, 300000) ||
    !bounded(maxAttempts, 1, 10) ||
    !bounded(maxOutputTokens, 1, 4096)
  )
    throw new Error("Invalid execution limits/provider");
  const repository = createExecutionRepository({
    pool,
    provider: provider.name,
    model: provider.model,
    maxAttempts,
    leaseMs,
  });
  let timer: ReturnType<typeof setTimeout> | undefined,
    started = false,
    stopped = false;
  let active: Promise<boolean> | null = null,
    controller: AbortController | null = null;
  const run = async (executionId?: string) => {
    if (stopped) return false;
    await repository.recover();
    if (stopped) return false;
    const claim = await repository.claim(executionId);
    if (!claim) return false;
    if (stopped) return true; // A committed claim is reclaimed safely after its lease.
    const abort = new AbortController();
    controller = abort;
    let timeout: ReturnType<typeof setTimeout> | undefined,
      watch: ReturnType<typeof setTimeout> | undefined,
      finished = false,
      dispatched = false;
    try {
      const skills = await repository.begin(claim);
      if (!skills) return true;
      if (stopped) abort.abort();
      timeout = setTimeout(() => abort.abort(), timeoutMs);
      const check = async () => {
        try {
          if (!(await repository.live(claim))) abort.abort();
        } catch {
          abort.abort();
        }
        if (!finished && !abort.signal.aborted)
          watch = setTimeout(() => void check(), Math.min(1000, timeoutMs));
      };
      watch = setTimeout(() => void check(), Math.min(1000, timeoutMs));
      if (abort.signal.aborted)
        throw new ProviderError("CALL_ABORTED_UNCERTAIN", true);
      // Race abort even for a badly behaved injected provider. Promise.race observes late rejection.
      const cancelled = new Promise<never>((_, reject) => {
        const stop = () =>
          reject(new ProviderError("CALL_ABORTED_UNCERTAIN", true));
        if (abort.signal.aborted) stop();
        else abort.signal.addEventListener("abort", stop, { once: true });
      });
      dispatched = true;
      const result = await Promise.race([
        provider.execute({
          prompt: claim.prompt,
          skills,
          signal: abort.signal,
          maxOutputTokens,
          onRequestId: (id) => repository.noteRequestId(claim, id),
        }),
        cancelled,
      ]);
      if (
        typeof result.text !== "string" ||
        Buffer.byteLength(result.text) > 262144
      )
        throw new ProviderError(
          "RESULT_TOO_LARGE",
          true,
          result.providerRequestId,
        );
      await repository.finish(claim, { status: "succeeded", ...result });
    } catch (error) {
      const e =
        error instanceof ProviderError
          ? error
          : error instanceof DomainError
            ? new ProviderError(error.code, dispatched)
            : new ProviderError("INTERNAL_UNCERTAIN", true);
      try {
        await repository.finish(claim, {
          status: e.uncertain ? "uncertain" : "failed",
          errorCode: e.code,
          providerRequestId: e.providerRequestId,
        });
      } catch {
        onError("EXECUTION_FINALIZE_FAILED");
      }
      await repository.recover();
    } finally {
      finished = true;
      clearTimeout(timeout);
      clearTimeout(watch);
      controller = null;
    }
    return true;
  };
  const runOnce = (executionId?: string) => {
    if (active) return active;
    active = run(executionId).finally(() => {
      active = null;
    });
    return active;
  };
  const tick = async () => {
    try {
      await runOnce();
    } catch {
      onError("EXECUTION_WORKER_FAILED");
    }
    if (started && !stopped)
      timer = setTimeout(() => void tick(), pollIntervalMs);
  };
  return {
    accept: repository.accept,
    get: repository.get,
    list: repository.list,
    retry: repository.retry,
    cancel: repository.cancel,
    recover: repository.recover,
    runOnce,
    start() {
      if (started || stopped) return;
      started = true;
      void tick();
    },
    async stop() {
      stopped = true;
      started = false;
      clearTimeout(timer);
      controller?.abort();
      await active;
    },
  };
}
