// UI test fixture only. Never imported by the production browser/server.
import { createDemo } from "../web/demo";
import { DomainError, type Draft } from "../../contracts";
import type {
  ProductionLibraryService,
  ProductionSkill,
} from "../../contracts/production";
export async function createProductFixture() {
  const demo = await createDemo();
  const managed = new Map<string, Partial<ProductionSkill>>();
  const drafts = new Map<string, Draft>();
  const enrich = (skill: any): ProductionSkill => ({
    ...skill,
    ...(managed.get(skill.id) ?? { revision: 1, archivedAt: null }),
  });
  const library: ProductionLibraryService = {
    ...demo.library,
    setMaintainers: async (a, id, users) =>
      enrich(await demo.library.setMaintainers(a, id, users)),
    getSkill: async (a, id) => enrich(await demo.library.getSkill(a, id)),
    listSkills: async (a, q) =>
      (await demo.library.listSkills(a, q))
        .map(enrich)
        .filter((s) => !s.archivedAt),
    listManagedSkills: async (a, o) =>
      (await demo.library.listSkills(a, o?.query))
        .map(enrich)
        .filter((s) => o?.includeArchived || !s.archivedAt),
    createSkill: async (a, i) => {
      const r = await demo.library.createSkill(a, i);
      drafts.set(r.draft.id, r.draft);
      return { ...r, skill: enrich(r.skill) };
    },
    createDraft: async (a, id, source) => {
      const d = await demo.library.createDraft(a, id, source);
      drafts.set(d.id, d);
      return d;
    },
    listDrafts: async (a, id) =>
      [...drafts.values()].filter(
        (d) => d.skillId === id && d.authorId === a.userId,
      ),
    updateSkill: async (a, i) => {
      const s = await library.getSkill(a, i.skillId);
      if (s.revision !== i.expectedRevision)
        throw new DomainError("STALE_REVISION", "名称已经更新");
      managed.set(s.id, {
        ...s,
        name: i.name,
        description: i.description,
        revision: s.revision + 1,
      });
      return library.getSkill(a, s.id);
    },
    archiveSkill: async (a, i) => {
      const s = await library.getSkill(a, i.skillId);
      managed.set(s.id, {
        ...s,
        revision: s.revision + 1,
        archivedAt: new Date().toISOString(),
      });
      return library.getSkill(a, s.id);
    },
    restoreSkill: async (a, i) => {
      const s = await library.getSkill(a, i.skillId);
      managed.set(s.id, { ...s, revision: s.revision + 1, archivedAt: null });
      return library.getSkill(a, s.id);
    },
  };
  return { ...demo, library };
}
