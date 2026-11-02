import type { Actor, Skill, LibraryService, Draft, CreateSkillInput } from './index.ts';
export interface ProductionSkill extends Skill { revision: number; archivedAt: string | null }
export interface UpdateSkillInput { skillId: string; expectedRevision: number; name: string; description: string }
export interface ArchiveSkillInput { skillId: string; expectedRevision: number }
export interface ManagedSkillsQuery { query?: string; includeArchived?: boolean }
export interface ProductionLibraryService extends LibraryService {
  listDrafts(actor: Actor, skillId: string): Promise<Draft[]>;
  getSkill(actor: Actor, skillId: string): Promise<ProductionSkill>;
  listSkills(actor: Actor, query?: string): Promise<ProductionSkill[]>;
  listManagedSkills(actor: Actor, options?: ManagedSkillsQuery): Promise<ProductionSkill[]>;
  createSkill(actor: Actor, input: CreateSkillInput): Promise<{skill: ProductionSkill; draft: Draft}>;
  setMaintainers(actor: Actor, skillId: string, userIds: string[]): Promise<ProductionSkill>;
  updateSkill(actor: Actor, input: UpdateSkillInput): Promise<ProductionSkill>;
  archiveSkill(actor: Actor, input: ArchiveSkillInput): Promise<ProductionSkill>;
  restoreSkill(actor: Actor, input: ArchiveSkillInput): Promise<ProductionSkill>;
}
