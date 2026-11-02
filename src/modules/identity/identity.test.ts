import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import { createIdentityService, createIdentityHttpHandler } from "./index.ts";
import { createIdentityClient } from "./client.ts";
import type { OAuthProvider } from "./types.ts";
const database = process.env.DATABASE_URL;
const schemaFile =
  process.env.IDENTITY_SCHEMA_FILE ??
  new URL("../persistence/migrations/001-production.sql", import.meta.url);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const fixture: OAuthProvider = {
  name: "explicit-test-fixture",
  authorizationUrl({ state, challenge, redirectUri }) {
    return `https://fixture.invalid/?${new URLSearchParams({ state, challenge, redirectUri })}`;
  },
  async exchange({ code, verifier }) {
    assert.ok(verifier.length >= 43);
    return {
      subject: code,
      displayName: code,
      verifiedEmail:
        code === "unverified"
          ? null
          : `${code.startsWith("same-") ? "shared" : code}@example.com`,
    };
  },
};
const req = (headers: Record<string, string> = {}, url = "/") =>
  ({ headers, url }) as IncomingMessage;

test("生产配置缺失、测试提供方、非 HTTPS 来源均关闭登录", () => {
  const pool = new Pool();
  assert.throws(
    () => createIdentityService({ pool, publicOrigin: "https://example.com" }),
    /凭证/,
  );
  assert.throws(
    () =>
      createIdentityService({
        pool,
        publicOrigin: "https://example.com",
        testProvider: fixture,
        github: { clientId: "a", clientSecret: "b" },
      }),
    /测试/,
  );
  assert.throws(
    () =>
      createIdentityService({
        pool,
        publicOrigin: "http://example.com",
        github: { clientId: "a", clientSecret: "b" },
      }),
    /HTTPS/,
  );
  void pool.end();
});

test(
  "真实 PostgreSQL 与 HTTP 身份团队安全闭环",
  { skip: !database },
  async (t) => {
    const schema = "identity_" + randomUUID().replaceAll("-", "");
    const bootstrap = new Pool({ connectionString: database });
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({
      connectionString: database,
      options: `-c search_path=${schema}`,
      max: 12,
    });
    let server: ReturnType<typeof createServer> | undefined;
    try {
      await pool.query(await readFile(schemaFile, "utf8"));
      let handler: ReturnType<typeof createIdentityHttpHandler>;
      server = createServer((r, s) => {
        void handler(r, s).then((handled) => {
          if (!handled) {
            s.statusCode = 404;
            s.end();
          }
        });
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const service = createIdentityService({
        pool,
        publicOrigin: origin,
        mode: "test",
        testProvider: fixture,
      });
      handler = createIdentityHttpHandler({ identity: service });
      class Browser {
        jar = new Map<string, string>();
        csrf = "";
        get cookie() {
          return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
        }
        async request(
          path: string,
          data?: unknown,
          extra: Record<string, string> = {},
        ) {
          const response = await fetch(origin + "/api/identity/" + path, {
            redirect: "manual",
            method: data === undefined ? "GET" : "POST",
            headers: {
              cookie: this.cookie,
              ...(data === undefined
                ? {}
                : {
                    origin,
                    "content-type": "application/json",
                    "x-csrf-token": this.csrf,
                  }),
              ...extra,
            },
            body: data === undefined ? undefined : JSON.stringify(data),
          });
          for (const c of response.headers.getSetCookie()) {
            const [k, v] = c.split(";")[0].split("=");
            this.jar.set(k, v);
          }
          return response;
        }
        async login(user: string) {
          const start = await this.request("login");
          assert.equal(start.status, 302);
          const location = new URL(start.headers.get("location")!);
          assert.ok(location.searchParams.get("challenge"));
          assert.equal(
            location.searchParams.get("redirectUri"),
            origin + "/api/identity/callback",
          );
          const result = await this.request(
            "callback?" +
              new URLSearchParams({
                state: location.searchParams.get("state")!,
                code: user,
              }),
          );
          assert.equal(result.status, 302);
          const cookies = result.headers.getSetCookie().join(";");
          assert.match(cookies, /HttpOnly/);
          assert.match(cookies, /SameSite=Lax/);
          assert.match(cookies, /Path=\//);
          const session = (await (await this.request("session")).json()).data;
          this.csrf = session.csrfToken;
          return session;
        }
        context(teamId?: string) {
          return req({
            cookie: this.cookie,
            origin,
            "x-csrf-token": this.csrf,
            ...(teamId ? { "x-team-id": teamId } : {}),
          });
        }
        async call(name: string, data = {}) {
          const r = await this.request(name, data);
          assert.equal(r.status, 200, await r.clone().text());
          return (await r.json()).data;
        }
      }
      const a = new Browser(),
        b = new Browser(),
        outsider = new Browser();
      let aid: string,
        bid: string,
        team: { id: string; name: string; role: string };
      await t.test(
        "OAuth state 绑定浏览器、单次消费，拒绝伪造与跨站登录",
        async () => {
          assert.equal(
            (
              await a.request("login", undefined, {
                "sec-fetch-site": "cross-site",
              })
            ).status,
            403,
          );
          const start = await a.request("login");
          const state = new URL(
            start.headers.get("location")!,
          ).searchParams.get("state")!;
          assert.equal(
            (await b.request(`callback?state=${state}&code=b`)).status,
            403,
          );
          assert.equal(
            (await a.request("callback?state=forged&code=a")).status,
            403,
          );
          assert.equal(
            (await a.request(`callback?state=${state}&code=a`)).status,
            302,
          );
          assert.equal(
            (await a.request(`callback?state=${state}&code=a`)).status,
            403,
          );
        },
      );
      await t.test("OAuth state 过期与取消登录失败关闭", async () => {
        const start = await a.request("login");
        const state = new URL(start.headers.get("location")!).searchParams.get(
          "state",
        )!;
        const originalNow = Date.now;
        try {
          Date.now = () => originalNow() + 600001;
          assert.equal(
            (await a.request(`callback?state=${state}&code=a`)).status,
            403,
          );
        } finally {
          Date.now = originalNow;
        }
        const cancelled = await a.request("login");
        const state2 = new URL(
          cancelled.headers.get("location")!,
        ).searchParams.get("state")!;
        assert.equal(
          (await a.request(`callback?state=${state2}&error=access_denied`))
            .status,
          403,
        );
        assert.equal(
          (await a.request(`callback?state=${state2}&code=a`)).status,
          403,
        );
      });
      await t.test(
        "真实 HTTP session、会话轮换，数据库仅保存摘要",
        async () => {
          const old = a.cookie;
          aid = (await a.login("a")).user.id;
          bid = (await b.login("b")).user.id;
          await outsider.login("outsider");
          assert.equal(await service.session(req({ cookie: old })), null);
          const rows = (
            await pool.query("SELECT token_hash FROM auth_sessions")
          ).rows;
          assert.ok(rows.every((r) => /^[a-f0-9]{64}$/.test(r.token_hash)));
        },
      );
      await t.test("CSRF、Origin、伪造 Actor、路由和正文边界", async () => {
        assert.equal(
          (
            await a.request(
              "createTeam",
              { name: "bad" },
              { "x-csrf-token": "" },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await a.request(
              "createTeam",
              { name: "bad" },
              { origin: "https://evil.test" },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await a.request("createTeam", {
              name: "bad",
              actor: { role: "admin" },
            })
          ).status,
          400,
        );
        assert.equal((await a.request("constructor", {})).status, 404);
        assert.equal(
          (await a.request("createTeam", { name: "x".repeat(17000) })).status,
          400,
        );
        team = await a.call("createTeam", { name: "共同团队" });
        assert.equal(
          (await service.resolveActor(a.context(team.id))).role,
          "admin",
        );
        assert.equal(
          (
            await service.resolveActor(
              req({
                ...(a.context(team.id).headers as Record<string, string>),
                "x-role": "viewer",
                "x-user-id": "forged",
              }),
            )
          ).userId,
          aid,
        );
        await assert.rejects(
          service.resolveActor(outsider.context(team.id)),
          /权限/,
        );
        assert.equal(
          (await outsider.request("listMembers", { teamId: team.id })).status,
          403,
        );
      });
      await t.test("邀请验证邮箱、过期、并发单次接受、重放", async () => {
        const expired = await a.call("invite", {
          teamId: team.id,
          email: "b@example.com",
          role: "viewer",
        });
        await pool.query(
          "UPDATE team_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
          [expired.id],
        );
        assert.equal(
          (await b.request("accept", { token: expired.token })).status,
          403,
        );
        const invitation = await a.call("invite", {
          teamId: team.id,
          email: "b@example.com",
          role: "contributor",
        });
        assert.equal(
          (await outsider.request("accept", { token: invitation.token }))
            .status,
          403,
        );
        const responses = await Promise.all([
          b.request("accept", { token: invitation.token }),
          b.request("accept", { token: invitation.token }),
        ]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 403]);
        assert.equal(
          (await b.request("accept", { token: invitation.token })).status,
          403,
        );
        assert.equal(
          (await service.resolveActor(b.context(team.id))).role,
          "contributor",
        );
        assert.equal(
          (
            await b.request("invite", {
              teamId: team.id,
              email: "x@example.com",
              role: "admin",
            })
          ).status,
          403,
        );
        const stored = (
          await pool.query(
            "SELECT token_hash FROM team_invitations WHERE id=$1",
            [invitation.id],
          )
        ).rows[0];
        assert.equal(stored.token_hash, hash(invitation.token));
      });
      await t.test(
        "最后管理员不可移除/降权，并发操作后仍有管理员",
        async () => {
          assert.equal(
            (await a.request("removeMember", { teamId: team.id, userId: aid }))
              .status,
            409,
          );
          assert.equal(
            (
              await a.request("changeRole", {
                teamId: team.id,
                userId: aid,
                role: "viewer",
              })
            ).status,
            409,
          );
          await a.call("changeRole", {
            teamId: team.id,
            userId: bid,
            role: "admin",
          });
          const responses = await Promise.all([
            a.request("changeRole", {
              teamId: team.id,
              userId: aid,
              role: "viewer",
            }),
            b.request("changeRole", {
              teamId: team.id,
              userId: bid,
              role: "viewer",
            }),
          ]);
          assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
          const remaining = (
            await pool.query(
              "SELECT user_id FROM team_memberships WHERE team_id=$1 AND role='admin' AND status='active'",
              [team.id],
            )
          ).rows;
          assert.equal(remaining.length, 1);
          const admin = remaining[0].user_id === aid ? a : b;
          await admin.call("changeRole", {
            teamId: team.id,
            userId: aid,
            role: "admin",
          });
        },
      );
      await t.test("成员移除立即撤销权限，旧邀请不能恢复移除成员", async () => {
        const oldInvite = await a.call("invite", {
          teamId: team.id,
          email: "b@example.com",
          role: "admin",
        });
        await a.call("removeMember", { teamId: team.id, userId: bid });
        await assert.rejects(service.resolveActor(b.context(team.id)), /权限/);
        assert.equal(
          (await b.request("listMembers", { teamId: team.id })).status,
          403,
        );
        assert.equal(
          (await b.request("accept", { token: oldInvite.token })).status,
          403,
        );
        assert.equal((await b.call("listTeams")).length, 0);
      });
      await t.test(
        "邮箱相同不会合并第三方身份，未验证邮箱不能接受邀请",
        async () => {
          const c = new Browser(),
            d = new Browser(),
            unverified = new Browser();
          assert.notEqual(
            (await c.login("same-c")).user.id,
            (await d.login("same-d")).user.id,
          );
          await unverified.login("unverified");
          const i = await a.call("invite", {
            teamId: team.id,
            email: "unverified@example.com",
            role: "viewer",
          });
          assert.equal(
            (await unverified.request("accept", { token: i.token })).status,
            403,
          );
        },
      );
      await t.test(
        "HTTPS Cookie 标志、session 过期和账号/团队停用",
        async () => {
          const secure = createIdentityService({
            pool,
            publicOrigin: "https://app.example",
            mode: "test",
            testProvider: fixture,
          });
          const start = await secure.login(req());
          assert.match(start.cookies[0], /^__Host-sl_oauth=.*; Secure$/);
          const state = new URL(start.location).searchParams.get("state");
          const result = await secure.callback(
            req(
              { cookie: start.cookies[0].split(";")[0] },
              "/api/identity/callback?state=" + state + "&code=secure",
            ),
          );
          assert.match(result.cookies[0], /^__Host-sl_session=.*; Secure$/);
          await pool.query("UPDATE teams SET status='disabled' WHERE id=$1", [
            team.id,
          ]);
          await assert.rejects(
            service.resolveActor(a.context(team.id)),
            /权限/,
          );
          await pool.query("UPDATE teams SET status='active' WHERE id=$1", [
            team.id,
          ]);
          await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [
            bid,
          ]);
          assert.equal(await service.session(b.context()), null);
          await pool.query(
            "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1",
            [bid],
          );
          await pool.query("UPDATE users SET status='active' WHERE id=$1", [
            bid,
          ]);
          assert.equal(await service.session(b.context()), null);
        },
      );
      await t.test(
        "浏览器 client 真实 HTTP 调用及 logout 持久撤销",
        async () => {
          const client = createIdentityClient({
            baseUrl: origin,
            fetch: async (url, init) => {
              const response = await fetch(url, {
                ...init,
                headers: { ...init?.headers, cookie: a.cookie, origin },
              });
              if (String(url).endsWith("/logout"))
                assert.match(
                  response.headers.getSetCookie().join(";"),
                  /Max-Age=0/,
                );
              return response;
            },
          });
          assert.equal((await client.session())!.user.id, aid);
          assert.equal((await client.listTeams()).length, 1);
          const old = a.cookie;
          await client.logout();
          assert.equal(
            await createIdentityService({
              pool,
              publicOrigin: origin,
              mode: "test",
              testProvider: fixture,
            }).session(req({ cookie: old })),
            null,
          );
          assert.equal(
            (await a.request("createTeam", { name: "不允许" })).status,
            403,
          );
          const revoked = await pool.query(
            "SELECT 1 FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NOT NULL",
            [aid],
          );
          assert.ok(revoked.rowCount);
        },
      );
    } finally {
      await new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      );
      await pool.end();
      await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
      await bootstrap.end();
    }
  },
);
