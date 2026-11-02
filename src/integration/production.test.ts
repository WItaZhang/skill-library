import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createProductionApplication } from "./production-server.ts";
import type { OAuthProvider } from "../modules/identity/types.ts";

const databaseUrl = process.env.DATABASE_URL;
test(
  "真实 PostgreSQL + 身份 HTTP + 产品适配：两位测试提供方用户、发布、管理、SSE、撤销",
  { skip: !databaseUrl, timeout: 30000 },
  async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const schema = "product_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    const origin = "http://127.0.0.1:18743";
    // Explicit test provider exercises real OAuth state/cookie/session flow, not GitHub credentials.
    const provider: OAuthProvider = {
      name: "product-test-provider",
      authorizationUrl: ({ state, redirectUri }) =>
        `${redirectUri}?state=${state}&code=alice`,
      exchange: async ({ code }) => ({
        subject: code,
        displayName: code === "alice" ? "测试作者甲" : "测试作者乙",
        verifiedEmail: `${code}@example.test`,
      }),
    };
    const app = await createProductionApplication({
      pool,
      publicOrigin: origin,
      mode: "test",
      testProvider: provider,
      webDir: "src/modules/product/dist",
      pollIntervalMs: 20,
    });
    await new Promise<void>((done) =>
      app.server.listen(18743, "127.0.0.1", done),
    );
    async function login(name: string) {
      const first = await fetch(origin + "/api/identity/login", {
        redirect: "manual",
      });
      const stateCookie = first.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
      const callback = new URL(first.headers.get("location")!);
      callback.searchParams.set("code", name);
      const result = await fetch(callback, {
        redirect: "manual",
        headers: { Cookie: stateCookie },
      });
      assert.equal(result.status, 302);
      const cookie = result.headers
        .getSetCookie()
        .filter((v) => v.startsWith("sl_session="))
        .map((v) => v.split(";")[0])
        .join("; ");
      const session = await (
        await fetch(origin + "/api/identity/session", {
          headers: { Cookie: cookie },
        })
      ).json();
      return { cookie, csrf: session.data.csrfToken, user: session.data.user };
    }
    type User = Awaited<ReturnType<typeof login>>;
    async function request(
      user: User,
      path: string,
      body: unknown,
      team?: string,
    ) {
      return fetch(origin + path, {
        method: "POST",
        headers: {
          Cookie: user.cookie,
          Origin: origin,
          "X-CSRF-Token": user.csrf,
          "X-Team-Id": team ?? "",
          "X-Skill-Library": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }
    async function identity(user: User, method: string, input: unknown) {
      const response = await request(user, "/api/identity/" + method, input);
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).data;
    }
    async function rpc(
      user: User,
      team: string,
      method: string,
      args: unknown[],
      management = false,
    ) {
      const response = await request(
        user,
        `/api/${management ? "management" : "library"}/${method}`,
        { args },
        team,
      );
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).result;
    }
    try {
      const alice = await login("alice"),
        bob = await login("bob");
      const team = await identity(alice, "createTeam", {
        name: "产品集成测试团队",
      });
      const invite = await identity(alice, "invite", {
        teamId: team.id,
        email: "bob@example.test",
        role: "contributor",
      });
      await identity(bob, "accept", { token: invite.token });
      const initial = {
        files: [
          {
            path: "SKILL.md",
            mediaType: "text/markdown",
            content: "# 真实 PostgreSQL 内容",
          },
        ],
      };
      const { skill, draft } = await rpc(alice, team.id, "createSkill", [
        {
          name: "集成技能",
          description: "测试",
          maintainerIds: [],
          content: initial,
        },
      ]);
      const v1 = await rpc(alice, team.id, "publishDraft", [
        {
          draftId: draft.id,
          expectedRevision: draft.revision,
          expectedBaseVersionId: null,
          changeSummary: "首次发布",
          idempotencyKey: randomUUID(),
        },
      ]);
      const bd = await rpc(bob, team.id, "createDraft", [skill.id]);
      const bs = await rpc(bob, team.id, "saveDraft", [
        {
          draftId: bd.id,
          expectedRevision: bd.revision,
          content: { files: [{ ...initial.files[0], content: "# 乙的内容" }] },
        },
      ]);
      const abort = new AbortController();
      const stream = await fetch(
        `${origin}/api/events?teamId=${team.id}&after=0`,
        { headers: { Cookie: bob.cookie }, signal: abort.signal },
      );
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader();
      let received = "";
      const v2 = await rpc(bob, team.id, "publishDraft", [
        {
          draftId: bs.id,
          expectedRevision: bs.revision,
          expectedBaseVersionId: v1.id,
          changeSummary: "乙发布",
          idempotencyKey: randomUUID(),
        },
      ]);
      while (!received.includes(v2.id)) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        received += new TextDecoder().decode(chunk.value);
      }
      assert.match(received, /skill.updated/);
      const diffs = await rpc(alice, team.id, "compareVersions", [
        v1.id,
        v2.id,
      ]);
      assert.equal(diffs[0].after, "# 乙的内容");
      const restore = await rpc(alice, team.id, "createDraft", [
        skill.id,
        v1.id,
      ]);
      assert.equal(restore.content.files[0].content, initial.files[0].content);
      assert.equal(restore.baseVersionId, v2.id);
      const drafts = await rpc(alice, team.id, "listDrafts", [skill.id], true);
      assert.ok(drafts.some((d: any) => d.id === restore.id));
      assert.ok(drafts.every((d: any) => d.authorId === alice.user.id));
      const runtimeCall = async (
        user: User,
        method: string,
        args: unknown[],
      ) => {
        const response = await request(
          user,
          "/api/runtime/" + method,
          { args },
          team.id,
        );
        assert.equal(response.status, 200, await response.clone().text());
        return (await response.json()).result;
      };
      const runtimeSession = await runtimeCall(alice, "createSession", []);
      const task = await runtimeCall(alice, "createTask", [
        runtimeSession.id,
        randomUUID(),
      ]);
      assert.equal(task.versions[skill.id], v2.id);
      const current = await rpc(alice, team.id, "getSkill", [skill.id]);
      const updated = await rpc(
        alice,
        team.id,
        "updateSkill",
        [
          {
            skillId: skill.id,
            expectedRevision: current.revision,
            name: "新名称",
            description: "新简介",
          },
        ],
        true,
      );
      assert.equal(updated.name, "新名称");
      const conflict = await request(
        alice,
        "/api/management/updateSkill",
        {
          args: [
            {
              skillId: skill.id,
              expectedRevision: current.revision,
              name: "旧修订覆盖",
              description: "",
            },
          ],
        },
        team.id,
      );
      assert.equal(conflict.status, 409);
      const archived = await rpc(
        alice,
        team.id,
        "archiveSkill",
        [{ skillId: skill.id, expectedRevision: updated.revision }],
        true,
      );
      assert.ok(archived.archivedAt);
      assert.equal((await rpc(bob, team.id, "listSkills", [])).length, 0);
      const newTask = await runtimeCall(alice, "createTask", [
        runtimeSession.id,
        randomUUID(),
      ]);
      assert.equal(newTask.versions[skill.id], undefined);
      assert.equal(
        (await runtimeCall(alice, "resolveSkill", [task.taskId, skill.id])).id,
        v2.id,
      );
      assert.equal(
        (
          await rpc(
            alice,
            team.id,
            "listManagedSkills",
            [{ includeArchived: true }],
            true,
          )
        ).length,
        1,
      );
      assert.equal((await rpc(bob, team.id, "getVersion", [v1.id])).id, v1.id);
      await rpc(
        alice,
        team.id,
        "restoreSkill",
        [{ skillId: skill.id, expectedRevision: archived.revision }],
        true,
      );
      const forged = await request(
        bob,
        "/api/management/archiveSkill",
        {
          args: [{ skillId: skill.id, expectedRevision: 99 }],
          actor: { ...alice.user, role: "admin" },
        },
        team.id,
      );
      assert.equal(forged.status, 400);
      const other = await identity(bob, "createTeam", { name: "隔离团队" });
      assert.equal(
        (
          await request(
            bob,
            "/api/library/getSkill",
            { args: [skill.id] },
            other.id,
          )
        ).status,
        404,
      );
      await identity(alice, "removeMember", {
        teamId: team.id,
        userId: bob.user.id,
      });
      assert.equal(
        (
          await request(
            bob,
            "/api/library/getSkill",
            { args: [skill.id] },
            team.id,
          )
        ).status,
        403,
      );
      let ended = false;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            ended = true;
            break;
          }
        }
      } catch {
        ended = true;
      }
      assert.ok(ended);
      abort.abort();
      // JSON escaping can make a valid 2 MiB package exceed its raw byte size.
      const largeContent = "\n".repeat(2 * 1024 * 1024);
      const large = await rpc(alice, team.id, "createSkill", [{
        name: "最大合法文本包", description: "传输边界", maintainerIds: [],
        content: { files: [{ ...initial.files[0], content: largeContent }] },
      }]);
      assert.equal(large.draft.content.files[0].content, largeContent);
      const noCsrf = await fetch(origin + "/api/management/listManagedSkills", {
        method: "POST",
        headers: {
          Cookie: alice.cookie,
          Origin: origin,
          "X-Team-Id": team.id,
          "X-Skill-Library": "1",
          "Content-Type": "application/json",
        },
        body: '{"args":[]}',
      });
      assert.equal(noCsrf.status, 403);
      assert.equal(
        (await fetch(origin + "/api/demo/bootstrap", { method: "POST" }))
          .status,
        404,
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
