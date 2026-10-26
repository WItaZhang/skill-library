// Shared contract v1. Runtime validation is each receiving module's responsibility.
export type Id = string;
export type Role = 'viewer' | 'contributor' | 'admin';
export interface Actor { userId: Id; teamId: Id; role: Role }
export type ErrorCode = 'FORBIDDEN' | 'NOT_FOUND' | 'STALE_REVISION' | 'CONFLICT' | 'VALIDATION' | 'RESOURCE_MISSING' | 'UNAVAILABLE';
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message); this.name = 'DomainError'; this.code = code; this.details = details;
  }
}
export interface SkillFile { path: string; content: string; mediaType: string }
export interface SkillContent { files: SkillFile[] }
export interface Skill {
  id: Id; teamId: Id; name: string; description: string; maintainerIds: Id[];
  currentVersionId: Id | null; createdAt: string;
}
export interface SkillVersion {
  id: Id; skillId: Id; teamId: Id; number: number; parentVersionId: Id | null;
  content: SkillContent; checksum: string; changeSummary: string;
  authorId: Id; reviewerId: Id; createdAt: string;
}
export interface Draft {
  id: Id; skillId: Id; teamId: Id; authorId: Id; baseVersionId: Id | null;
  revision: number; content: SkillContent; updatedAt: string;
}
export type ProposalStatus = 'pending' | 'changes_requested' | 'conflicted' | 'rejected' | 'withdrawn' | 'merged';
export interface Proposal {
  id: Id; skillId: Id; teamId: Id; authorId: Id; baseVersionId: Id | null;
  revision: number; content: SkillContent; changeSummary: string;
  status: ProposalStatus; reviewComment?: string; mergedVersionId?: Id; createdAt: string;
}
export interface FileDiff { path: string; kind: 'added' | 'removed' | 'modified'; before?: string; after?: string }
export interface MergeConflict { path: string; base?: string; current?: string; proposed?: string }
export interface MergePreview {
  proposalId: Id; proposalRevision: number; currentVersionId: Id | null;
  content: SkillContent; conflicts: MergeConflict[]; confirmationToken: string;
}
export interface SkillUpdateEvent {
  id: Id; sequence: number; teamId: Id; skillId: Id;
  previousVersionId: Id | null; versionId: Id; createdAt: string;
}
export interface AuditEntry {
  id: Id; teamId: Id; actorId: Id; action: string; objectId: Id; createdAt: string;
  metadata: Record<string, unknown>;
}
export interface CreateSkillInput { name: string; description: string; maintainerIds: Id[]; content: SkillContent }
export interface SaveDraftInput { draftId: Id; expectedRevision: number; content: SkillContent }
export interface SubmitInput { draftId: Id; expectedRevision: number; changeSummary: string; idempotencyKey: string }
export interface ReviewInput { proposalId: Id; expectedRevision: number; action: 'request_changes' | 'reject'; comment: string }
export interface MergeInput {
  proposalId: Id; expectedRevision: number; expectedCurrentVersionId: Id | null;
  confirmationToken: string; idempotencyKey: string;
}
export interface CatalogSnapshot { teamId: Id; versions: Record<Id, Id>; capturedAt: string }

// Service module owns persistence and validation. HTTP transport is integration-stage work.
export interface LibraryService {
  listSkills(actor: Actor, query?: string): Promise<Skill[]>;
  getSkill(actor: Actor, skillId: Id): Promise<Skill>;
  createSkill(actor: Actor, input: CreateSkillInput): Promise<{ skill: Skill; draft: Draft }>;
  setMaintainers(actor: Actor, skillId: Id, userIds: Id[]): Promise<Skill>;
  listVersions(actor: Actor, skillId: Id): Promise<SkillVersion[]>;
  getVersion(actor: Actor, versionId: Id): Promise<SkillVersion>;
  compareVersions(actor: Actor, beforeId: Id, afterId: Id): Promise<FileDiff[]>;
  createDraft(actor: Actor, skillId: Id, sourceVersionId?: Id): Promise<Draft>;
  getDraft(actor: Actor, draftId: Id): Promise<Draft>;
  saveDraft(actor: Actor, input: SaveDraftInput): Promise<Draft>;
  submitProposal(actor: Actor, input: SubmitInput): Promise<Proposal>;
  listProposals(actor: Actor, skillId?: Id): Promise<Proposal[]>;
  getProposal(actor: Actor, proposalId: Id): Promise<Proposal>;
  reviewProposal(actor: Actor, input: ReviewInput): Promise<Proposal>;
  withdrawProposal(actor: Actor, proposalId: Id, expectedRevision: number): Promise<Proposal>;
  previewMerge(actor: Actor, proposalId: Id): Promise<MergePreview>;
  mergeProposal(actor: Actor, input: MergeInput): Promise<SkillVersion>;
  catalogSnapshot(actor: Actor): Promise<CatalogSnapshot>;
  listUpdateEvents(actor: Actor, afterSequence: number): Promise<SkillUpdateEvent[]>;
  listAudit(actor: Actor): Promise<AuditEntry[]>;
}

export type SessionMode = 'latest' | 'pinned';
export interface SessionPreference {
  sessionId: Id; skillId: Id; mode: SessionMode; pinnedVersionId: Id | null; revision: number;
}
export interface TaskSnapshot {
  taskId: Id; sessionId: Id; teamId: Id; actorId: Id; versions: Record<Id, Id>;
  preferenceRevisions: Record<Id, number>; createdAt: string; parentTaskId?: Id;
}
export interface Invocation {
  id: Id; taskId: Id; sessionId: Id; skillId: Id; versionId: Id; checksum: string; createdAt: string;
}
export interface SessionUpdate {
  sessionId: Id; skillId: Id; usedVersionId: Id; latestVersionId: Id;
  preference: SessionPreference | null;
}
export interface PreferenceInput {
  sessionId: Id; skillId: Id; mode: SessionMode; targetVersionId: Id;
  expectedRevision: number;
}
// The runtime consumes a host-provided consistent catalog; it must never re-resolve latest during execution.
export interface RuntimeHost {
  catalogSnapshot(actor: Actor): Promise<CatalogSnapshot>;
  getVersion(actor: Actor, versionId: Id): Promise<SkillVersion>;
}
export interface RuntimeService {
  createSession(actor: Actor): Promise<{ id: Id }>;
  createTask(actor: Actor, sessionId: Id, taskId: Id): Promise<TaskSnapshot>;
  getTask(actor: Actor, taskId: Id): Promise<TaskSnapshot>;
  createChildTask(actor: Actor, parentTaskId: Id, taskId: Id): Promise<TaskSnapshot>;
  resolveSkill(actor: Actor, taskId: Id, skillId: Id): Promise<SkillVersion>;
  recordInvocation(actor: Actor, taskId: Id, skillId: Id): Promise<Invocation>;
  listInvocations(actor: Actor, sessionId: Id): Promise<Invocation[]>;
  getSessionUpdates(actor: Actor, sessionId: Id): Promise<SessionUpdate[]>;
  setPreference(actor: Actor, input: PreferenceInput): Promise<SessionPreference>;
}

