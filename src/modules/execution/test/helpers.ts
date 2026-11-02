import type { TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  migrate,
  createPostgresLibraryService,
} from "../../persistence/index.ts";
import { createExecutionService } from "../service.ts";
import type { Actor, Draft } from "../../../contracts/index.ts";
import type { ExecutionProvider } from "../../../contracts/execution.ts";
export const content = (text = "v1") => ({
  files: [
    { path: "SKILL.md", content: text, mediaType: "text/markdown" },
    {
      path: "reference.txt",
      content: `resource ${text}`,
      mediaType: "text/plain",
    },
  ],
});
export const publication = (d: Draft) => ({
  draftId: d.id,
  expectedRevision: d.revision,
  expectedBaseVersionId: d.baseVersionId,
  changeSummary: "test publication",
  idempotencyKey: randomUUID(),
});
export const fixtureProvider: ExecutionProvider = {
  name: "test-fixture",
  model: "deterministic-fixture",
  execute: async ({ skills }) => ({
    text: skills[0].content.files[0].content,
    providerRequestId: "fixture-request",
  }),
};
export async function fixture(
  t: TestContext,
  provider: ExecutionProvider = fixtureProvider,
  options: Record<string, number> = {},
) {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(
      "DATABASE_URL required: real PostgreSQL tests must not skip",
    );
  const root = new pg.Pool({ connectionString: url });
  const schema = "execution_" + randomUUID().replaceAll("-", "");
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: url,
    options: `-c search_path=${schema}`,
  });
  const services: ReturnType<typeof createExecutionService>[] = [];
  t.after(async () => {
    await Promise.all(services.map((s) => s.stop()));
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  });
  await migrate(pool);
  const a: Actor = {
      userId: randomUUID(),
      teamId: randomUUID(),
      role: "admin",
    },
    b: Actor = { userId: randomUUID(), teamId: a.teamId, role: "contributor" },
    v: Actor = { userId: randomUUID(), teamId: a.teamId, role: "viewer" },
    other: Actor = {
      userId: randomUUID(),
      teamId: randomUUID(),
      role: "admin",
    };
  for (const actor of [a, other])
    await pool.query("INSERT INTO teams(id,name) VALUES($1,$2)", [
      actor.teamId,
      "test team",
    ]);
  for (const actor of [a, b, v, other]) {
    await pool.query("INSERT INTO users(id,display_name) VALUES($1,$2)", [
      actor.userId,
      "test user",
    ]);
    await pool.query(
      "INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,$3)",
      [actor.teamId, actor.userId, actor.role],
    );
  }
  const library = createPostgresLibraryService({ pool });
  const { skill, draft } = await library.createSkill(a, {
    name: "真实 PG 测试技能",
    description: "",
    maintainerIds: [],
    content: content(),
  });
  const version = await library.publishDraft(a, publication(draft));
  const make = (p = provider, opts: Record<string, number> = {}) => {
    const service = createExecutionService({
      pool,
      provider: p,
      ...options,
      ...opts,
    });
    services.push(service);
    return service;
  };
  const service = make();
  const input = (prompt = "summarize") => ({
    prompt,
    skillIds: [skill.id],
    idempotencyKey: randomUUID(),
  });
  const publish = async (text: string) => {
    let d = await library.createDraft(a, skill.id);
    d = await library.saveDraft(a, {
      draftId: d.id,
      expectedRevision: d.revision,
      content: content(text),
    });
    return library.publishDraft(a, publication(d));
  };
  return {
    pool,
    root,
    schema,
    a,
    b,
    v,
    other,
    skill,
    version,
    library,
    service,
    make,
    input,
    publish,
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
