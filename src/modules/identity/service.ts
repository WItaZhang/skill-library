import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { PoolClient } from "pg";
import { DomainError } from "../../contracts/index.ts";
import { createGitHubProvider } from "./oauth.ts";
import type {
  IdentityOptions,
  IdentityService,
  IdentitySession,
  Role,
} from "./types.ts";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const deny = (message = "请重新登录，或确认你拥有该团队的访问权限"): never => {
  throw new DomainError("FORBIDDEN", message);
};
const validText = (s: unknown, max = 200): string => {
  if (typeof s !== "string" || !s.trim() || s.length > max)
    throw new DomainError("VALIDATION", "输入为空或过长");
  return s.trim();
};
const uuid = (s: unknown): string => {
  if (
    typeof s !== "string" ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(s)
  )
    throw new DomainError("VALIDATION", "标识格式无效");
  return s;
};
const role = (r: unknown): Role => {
  if (r !== "admin" && r !== "contributor" && r !== "viewer")
    throw new DomainError("VALIDATION", "成员角色无效");
  return r;
};
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
function cookie(req: IncomingMessage, name: string) {
  const parts = (req.headers.cookie ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.startsWith(name + "="));
  return parts.length === 1 ? parts[0].slice(name.length + 1) : "";
}
export function createIdentityService(
  options: IdentityOptions,
): IdentityService {
  const { pool } = options;
  const local = options.mode === "local";
  const production = options.mode !== "test" && !local;
  const origin = new URL(options.publicOrigin);
  if (
    origin.origin !== options.publicOrigin ||
    (production && origin.protocol !== "https:") ||
    !["https:", "http:"].includes(origin.protocol)
  )
    throw new Error("publicOrigin 必须为可信来源，生产环境必须使用 HTTPS");
  if (
    production &&
    (options.testProvider ||
      options.localAccess ||
      !options.github?.clientId?.trim() ||
      !options.github?.clientSecret?.trim())
  )
    throw new Error("生产 GitHub OAuth 凭证缺失或配置了测试提供方");
  if (
    local &&
    (origin.hostname !== "127.0.0.1" ||
      origin.protocol !== "http:" ||
      !options.localAccess ||
      !/^[a-f0-9]{64}$/.test(options.localAccess.keyHash) ||
      options.testProvider ||
      options.github)
  )
    throw new Error("本机访问仅支持 127.0.0.1 和独立的本地访问密钥");
  if (local) uuid(options.localAccess!.userId);
  const provider =
    !production && options.testProvider
      ? options.testProvider
      : options.github
        ? createGitHubProvider(options.github)
        : null;
  if (!provider && !local) throw new Error("未配置登录提供方");
  const secure = origin.protocol === "https:";
  const sessionName = secure ? "__Host-sl_session" : "sl_session";
  const stateName = secure ? "__Host-sl_oauth" : "sl_oauth";
  const ttl = options.sessionTtlMs ?? 7 * 86400000;
  const inviteTtl = options.invitationTtlMs ?? 7 * 86400000;
  if (
    !Number.isFinite(ttl) ||
    ttl <= 0 ||
    !Number.isFinite(inviteTtl) ||
    inviteTtl <= 0
  )
    throw new Error("有效期必须为正数");
  const setCookie = (name: string, token: string, ms: number) =>
    `${name}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(ms / 1000))}${secure ? "; Secure" : ""}`;
  const pending = new Map<
    string,
    { browserHash: string; verifier: string; expires: number }
  >();
  async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async function authenticated(
    req: IncomingMessage,
    db: Pick<PoolClient, "query"> = pool,
  ) {
    const token = cookie(req, sessionName);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const { rows } = await db.query(
      `SELECT u.id, u.display_name, u.email, s.expires_at FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active'`,
      [hash(token)],
    );
    const u = rows[0];
    return u
      ? ({
          user: { id: u.id, displayName: u.display_name, email: u.email },
          expiresAt: u.expires_at.toISOString(),
          csrfToken: hash("csrf:" + token),
        } satisfies IdentitySession)
      : null;
  }
  async function requireSession(
    req: IncomingMessage,
    db: Pick<PoolClient, "query"> = pool,
  ) {
    return (await authenticated(req, db)) ?? deny();
  }
  async function membership(
    req: IncomingMessage,
    teamId: string,
    c: Pick<PoolClient, "query"> = pool,
    admin = false,
  ) {
    const s = await requireSession(req, c);
    const { rows } = await c.query(
      `SELECT m.role FROM team_memberships m JOIN teams t ON t.id=m.team_id WHERE m.team_id=$1 AND m.user_id=$2 AND m.status='active' AND t.status='active'`,
      [uuid(teamId), s.user.id],
    );
    if (!rows[0] || (admin && rows[0].role !== "admin")) deny();
    return { userId: s.user.id, teamId, role: rows[0].role as Role };
  }
  async function lockTeam(c: PoolClient, teamId: string) {
    await c.query("SELECT id FROM teams WHERE id=$1 FOR UPDATE", [
      uuid(teamId),
    ]);
  }
  async function mutateMember(
    req: IncomingMessage,
    input: { teamId: string; userId: string },
    nextRole?: Role,
  ) {
    await service.assertCsrf(req);
    await tx(async (c) => {
      await lockTeam(c, input.teamId);
      await membership(req, input.teamId, c, true);
      const target = (
        await c.query(
          `SELECT role,status FROM team_memberships WHERE team_id=$1 AND user_id=$2`,
          [input.teamId, uuid(input.userId)],
        )
      ).rows[0];
      if (!target || target.status !== "active")
        throw new DomainError("NOT_FOUND", "该成员已不在团队中");
      if (target.role === "admin" && nextRole !== "admin") {
        const admins = await c.query(
          `SELECT 1 FROM team_memberships WHERE team_id=$1 AND role='admin' AND status='active' AND user_id<>$2`,
          [input.teamId, input.userId],
        );
        if (!admins.rowCount)
          throw new DomainError(
            "CONFLICT",
            "请先指定另一位管理员，不能移除或降级最后一位管理员",
          );
      }
      if (nextRole)
        await c.query(
          "UPDATE team_memberships SET role=$3 WHERE team_id=$1 AND user_id=$2",
          [input.teamId, input.userId, nextRole],
        );
      else {
        await c.query(
          `UPDATE team_memberships SET status='removed' WHERE team_id=$1 AND user_id=$2`,
          [input.teamId, input.userId],
        );
        // Revoke still-pending invitations for the removed member and those issued by them.
        await c.query(
          `UPDATE team_invitations SET expires_at=now() WHERE team_id=$1 AND accepted_at IS NULL AND (invited_by=$2 OR lower(email)=(SELECT lower(email) FROM users WHERE id=$2))`,
          [input.teamId, input.userId],
        );
      }
    });
  }
  const service: IdentityService = {
    authentication: local ? "local" : "github",
    ...(local
      ? {
          async localLogin(req: IncomingMessage, key: string) {
            if (
              req.headers.origin !== origin.origin ||
              req.headers.host !== origin.host ||
              req.socket.remoteAddress !== "127.0.0.1" ||
              typeof key !== "string" ||
              !equal(hash(key), options.localAccess!.keyHash)
            )
              return deny("本机访问密钥无效，请通过启动器重新打开");
            const token = secret();
            await tx(async (c) => {
              const user = await c.query(
                "SELECT id FROM users WHERE id=$1 AND status='active' FOR SHARE",
                [options.localAccess!.userId],
              );
              if (!user.rowCount) deny("账号已停用");
              await c.query(
                "UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL",
                [hash(cookie(req, sessionName))],
              );
              await c.query(
                "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)",
                [
                  randomUUID(),
                  options.localAccess!.userId,
                  hash(token),
                  new Date(Date.now() + ttl),
                ],
              );
            });
            return { cookies: [setCookie(sessionName, token, ttl)] };
          },
        }
      : {}),
    async login(req) {
      if (local) return { location: "/", cookies: [] };
      const fetchSite = req.headers["sec-fetch-site"];
      if (fetchSite === "cross-site") deny("请从本站发起登录");
      for (const [k, v] of pending)
        if (v.expires < Date.now()) pending.delete(k);
      if (pending.size >= 10000)
        throw new DomainError("UNAVAILABLE", "登录请求过多，请稍后重试");
      const state = secret(),
        browser = secret(),
        verifier = secret();
      pending.set(hash(state), {
        browserHash: hash(browser),
        verifier,
        expires: Date.now() + 600000,
      });
      return {
        location: provider!.authorizationUrl({
          state,
          challenge: createHash("sha256").update(verifier).digest("base64url"),
          redirectUri: origin.origin + "/api/identity/callback",
        }),
        cookies: [setCookie(stateName, browser, 600000)],
      };
    },
    async callback(req) {
      if (local) return deny("本机模式不使用 OAuth 回调");
      const url = new URL(req.url!, origin);
      const state = url.searchParams.get("state") ?? "";
      const entry = pending.get(hash(state));
      if (
        !entry ||
        entry.expires <= Date.now() ||
        !equal(entry.browserHash, hash(cookie(req, stateName)))
      )
        return deny("登录校验已失效，请重新登录");
      pending.delete(hash(state)); // Consume before network IO: concurrent callbacks cannot reuse state.
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.has("error"))
        return deny("登录授权已取消或无效");
      const profile = await provider!.exchange({
        code,
        verifier: entry.verifier,
        redirectUri: origin.origin + "/api/identity/callback",
      });
      const subject = validText(profile.subject, 300),
        displayName = validText(profile.displayName);
      const email = profile.verifiedEmail?.trim().toLowerCase() ?? null;
      const token = secret();
      await tx(async (c) => {
        // Serialize the same external identity without ever merging by email.
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          provider!.name + ":" + subject,
        ]);
        const existing = (
          await c.query(
            "SELECT user_id FROM auth_identities WHERE provider=$1 AND provider_subject=$2",
            [provider!.name, subject],
          )
        ).rows[0];
        const userId = existing?.user_id ?? randomUUID();
        if (!existing) {
          await c.query(
            "INSERT INTO users(id,display_name,email) VALUES($1,$2,$3)",
            [userId, displayName, email],
          );
          await c.query(
            "INSERT INTO auth_identities(id,user_id,provider,provider_subject) VALUES($1,$2,$3,$4)",
            [randomUUID(), userId, provider!.name, subject],
          );
        } else {
          const updated = await c.query(
            `UPDATE users SET display_name=$2,email=$3 WHERE id=$1 AND status='active' RETURNING id`,
            [userId, displayName, email],
          );
          if (!updated.rowCount) deny("账号已停用");
        }
        await c.query(
          "UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL",
          [hash(cookie(req, sessionName))],
        );
        await c.query(
          "INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,$4)",
          [randomUUID(), userId, hash(token), new Date(Date.now() + ttl)],
        );
      });
      return {
        location: "/",
        cookies: [
          setCookie(sessionName, token, ttl),
          setCookie(stateName, "", 0),
        ],
      };
    },
    session: authenticated,
    async assertCsrf(req) {
      if (req.headers.origin !== origin.origin)
        deny("请求来源校验失败，请刷新页面");
      const s = await requireSession(req);
      const csrf = req.headers["x-csrf-token"];
      if (typeof csrf !== "string" || !equal(s.csrfToken, csrf))
        deny("请求校验已失效，请刷新页面");
    },
    async logout(req) {
      await service.assertCsrf(req);
      await pool.query(
        "UPDATE auth_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL",
        [hash(cookie(req, sessionName))],
      );
      return {
        cookies: [setCookie(sessionName, "", 0), setCookie(stateName, "", 0)],
      };
    },
    async resolveActor(req) {
      const teamId =
        req.headers["x-team-id"] ??
        new URL(req.url ?? "/", origin).searchParams.get("teamId");
      return membership(req, uuid(teamId));
    },
    async createTeam(req, input) {
      await service.assertCsrf(req);
      const name = validText(input.name),
        id = randomUUID();
      return tx(async (c) => {
        const s = await requireSession(req, c);
        await c.query("INSERT INTO teams(id,name) VALUES($1,$2)", [id, name]);
        await c.query(
          `INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'admin')`,
          [id, s.user.id],
        );
        return { id, name, role: "admin" };
      });
    },
    async listTeams(req) {
      const s = await requireSession(req);
      return (
        await pool.query(
          `SELECT t.id,t.name,m.role FROM teams t JOIN team_memberships m ON m.team_id=t.id WHERE m.user_id=$1 AND m.status='active' AND t.status='active' ORDER BY t.created_at,t.id`,
          [s.user.id],
        )
      ).rows;
    },
    async invite(req, input) {
      await service.assertCsrf(req);
      const email = validText(input.email, 320).toLowerCase(),
        r = role(input.role);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new DomainError("VALIDATION", "请输入有效邮箱");
      const token = secret(),
        id = randomUUID(),
        expiresAt = new Date(Date.now() + inviteTtl).toISOString();
      return tx(async (c) => {
        await lockTeam(c, input.teamId);
        const a = await membership(req, input.teamId, c, true);
        await c.query(
          "INSERT INTO team_invitations(id,team_id,email,role,token_hash,expires_at,invited_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [id, input.teamId, email, r, hash(token), expiresAt, a.userId],
        );
        return { id, teamId: input.teamId, email, role: r, expiresAt, token };
      });
    },
    async accept(req, input) {
      await service.assertCsrf(req);
      const token = validText(input.token, 100);
      return tx(async (c) => {
        const invitation = (
          await c.query(
            "SELECT team_id FROM team_invitations WHERE token_hash=$1",
            [hash(token)],
          )
        ).rows[0];
        if (!invitation) deny("邀请不存在、已使用或已过期");
        await lockTeam(c, invitation.team_id);
        const i = (
          await c.query(
            "SELECT * FROM team_invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>now() FOR UPDATE",
            [hash(token)],
          )
        ).rows[0];
        const s = await requireSession(req, c);
        if (
          !i ||
          !s.user.email ||
          s.user.email.toLowerCase() !== i.email.toLowerCase()
        )
          deny("邀请已失效，或当前账号的已验证邮箱与邀请不一致");
        const team = (
          await c.query(
            `SELECT name FROM teams WHERE id=$1 AND status='active'`,
            [i.team_id],
          )
        ).rows[0];
        const inviter = (
          await c.query(
            `SELECT 1 FROM team_memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.user_id=$2 AND m.status='active' AND m.role='admin' AND u.status='active'`,
            [i.team_id, i.invited_by],
          )
        ).rows[0];
        if (!team || !inviter) deny("团队或邀请者权限已失效");
        const existing = (
          await c.query(
            "SELECT role,status FROM team_memberships WHERE team_id=$1 AND user_id=$2",
            [i.team_id, s.user.id],
          )
        ).rows[0];
        // Existing active memberships retain their current role: old invitations cannot escalate/downgrade them.
        if (!existing || existing.status !== "active")
          await c.query(
            `INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(team_id,user_id) DO UPDATE SET role=excluded.role,status='active',joined_at=now()`,
            [i.team_id, s.user.id, i.role],
          );
        await c.query(
          "UPDATE team_invitations SET accepted_at=now() WHERE id=$1",
          [i.id],
        );
        return {
          id: i.team_id,
          name: team.name,
          role: existing?.status === "active" ? existing.role : i.role,
        };
      });
    },
    async listMembers(req, input) {
      await membership(req, input.teamId);
      return (
        await pool.query(
          `SELECT u.id,u.display_name AS "displayName",u.email,m.role,m.joined_at AS "joinedAt" FROM team_memberships m JOIN users u ON u.id=m.user_id WHERE m.team_id=$1 AND m.status='active' ORDER BY m.joined_at,u.id`,
          [input.teamId],
        )
      ).rows.map((row) => ({ ...row, joinedAt: row.joinedAt.toISOString() }));
    },
    changeRole: (req, input) => mutateMember(req, input, role(input.role)),
    removeMember: (req, input) => mutateMember(req, input),
  };
  return service;
}
