import type { Actor, TaskSnapshot, SkillVersion } from "./index.ts";
export type ExecutionStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "cancelled";
export interface AcceptExecutionInput {
  prompt: string;
  skillIds: string[];
  idempotencyKey: string;
  sessionId?: string;
  parentTaskId?: string;
}
export interface RetryExecutionInput {
  executionId: string;
  idempotencyKey: string;
  acknowledgeUncertain?: boolean;
}
export interface ExecutionAttempt {
  id: string;
  number: number;
  status: Exclude<ExecutionStatus, "queued">;
  provider: string;
  model: string;
  providerRequestId: string | null;
  errorCode: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface ExecutionRecord {
  id: string;
  taskId: string;
  teamId: string;
  ownerId: string;
  prompt: string;
  skillIds: string[];
  status: ExecutionStatus;
  snapshot: TaskSnapshot;
  attempts: ExecutionAttempt[];
  result: {
    text: string;
    attemptId: string;
    providerRequestId: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}
export interface ExecutionService {
  accept(actor: Actor, input: AcceptExecutionInput): Promise<ExecutionRecord>;
  get(actor: Actor, executionId: string): Promise<ExecutionRecord>;
  list(actor: Actor): Promise<ExecutionRecord[]>;
  retry(actor: Actor, input: RetryExecutionInput): Promise<ExecutionRecord>;
  cancel(actor: Actor, executionId: string): Promise<ExecutionRecord>;
}
export interface ExecutionClient {
  accept(input: AcceptExecutionInput): Promise<ExecutionRecord>;
  get(executionId: string): Promise<ExecutionRecord>;
  list(): Promise<ExecutionRecord[]>;
  retry(input: RetryExecutionInput): Promise<ExecutionRecord>;
  cancel(executionId: string): Promise<ExecutionRecord>;
  dispose(): void;
}
/** Server-only provider. A single invocation must make at most one remote generation request. */
export interface ExecutionProvider {
  name: string;
  model: string;
  execute(input: {
    prompt: string;
    skills: SkillVersion[];
    signal: AbortSignal;
    maxOutputTokens: number;
    onRequestId?: (id: string) => Promise<void>;
  }): Promise<{
    text: string;
    providerRequestId: string | null;
    metadata?: Record<string, unknown>;
  }>;
}
export interface ExecutionLifecycle {
  start(): void;
  stop(): Promise<void>;
  runOnce(executionId?: string): Promise<boolean>;
  recover(): Promise<number>;
}
