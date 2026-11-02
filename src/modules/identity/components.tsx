import React, { useEffect, useRef, useState } from "react";
import type {
  IdentityClient,
  IdentityMember,
  IdentitySession,
  IdentityTeam,
  Role,
} from "./types.ts";
const message = (e: unknown) =>
  e instanceof Error ? e.message : "操作失败，请稍后重试";
const labels: Record<Role, string> = {
  admin: "管理员",
  contributor: "编辑者",
  viewer: "查看者",
};
function RoleSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: Role;
  onChange: (r: Role) => void;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label="成员角色"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Role)}
    >
      {Object.entries(labels).map(([r, label]) => (
        <option key={r} value={r}>
          {label}
        </option>
      ))}
    </select>
  );
}
export function IdentityPanel({
  client,
  onSessionChange,
}: {
  client: IdentityClient;
  onSessionChange?: (session: IdentitySession | null) => void;
}) {
  const [session, setSession] = useState<IdentitySession | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const generation = useRef(0);
  const notify = useRef(onSessionChange);
  notify.current = onSessionChange;
  useEffect(() => {
    const g = ++generation.current;
    let active = true;
    setLoading(true);
    setSession(null);
    setError("");
    client
      .session()
      .then((s) => {
        if (active) {
          setSession(s);
          notify.current?.(s);
        }
      })
      .catch((e) => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      if (generation.current === g) generation.current++;
    };
  }, [client]);
  async function logout() {
    const g = generation.current;
    setLoading(true);
    setError("");
    try {
      await client.logout();
      if (g === generation.current) {
        setSession(null);
        notify.current?.(null);
      }
    } catch (e) {
      if (g === generation.current) setError(message(e));
    } finally {
      if (g === generation.current) setLoading(false);
    }
  }
  return (
    <section aria-label="登录账号">
      {loading ? (
        <p role="status">正在加载账号…</p>
      ) : session ? (
        <>
          <span>{session.user.displayName}</span>{" "}
          <button onClick={logout}>退出登录</button>
        </>
      ) : (
        <a href={client.loginUrl}>使用 GitHub 登录</a>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function TeamPicker({
  client,
  selectedTeamId,
  onSelect,
}: {
  client: IdentityClient;
  selectedTeamId?: string;
  onSelect: (team: IdentityTeam) => void;
}) {
  const [teams, setTeams] = useState<IdentityTeam[]>([]),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const g = ++generation.current;
    let active = true;
    setTeams([]);
    setBusy(true);
    setError("");
    client
      .listTeams()
      .then((t) => {
        if (active) setTeams(t);
      })
      .catch((e) => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      if (generation.current === g) generation.current++;
    };
  }, [client]);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    const g = generation.current;
    setBusy(true);
    setError("");
    try {
      const team = await client.createTeam({ name });
      if (g === generation.current) {
        setTeams((t) => [...t, team]);
        setName("");
        onSelect(team);
      }
    } catch (e) {
      if (g === generation.current) setError(message(e));
    } finally {
      if (g === generation.current) setBusy(false);
    }
  }
  return (
    <section aria-label="团队选择">
      <label>
        当前团队{" "}
        <select
          value={selectedTeamId ?? ""}
          disabled={busy}
          onChange={(e) => {
            const team = teams.find((t) => t.id === e.target.value);
            if (team) onSelect(team);
          }}
        >
          <option value="">请选择团队</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {labels[t.role]}
            </option>
          ))}
        </select>
      </label>
      {!busy && !teams.length && <p>你还没有团队，可以新建团队或接受邀请。</p>}
      <form onSubmit={create}>
        <label>
          新团队名称{" "}
          <input
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button disabled={busy || !name.trim()}>创建团队</button>
      </form>
      {busy && <p role="status">正在加载…</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function TeamMembers({
  client,
  team,
  onMembershipChange,
}: {
  client: IdentityClient;
  team: IdentityTeam;
  onMembershipChange?: () => void;
}) {
  const [members, setMembers] = useState<IdentityMember[]>([]),
    [email, setEmail] = useState(""),
    [role, setRole] = useState<Role>("contributor"),
    [link, setLink] = useState(""),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const g = ++generation.current;
    setMembers([]);
    setLink("");
    setError("");
    setBusy(true);
    client
      .listMembers({ teamId: team.id })
      .then((m) => {
        if (g === generation.current) setMembers(m);
      })
      .catch((e) => {
        if (g === generation.current) setError(message(e));
      })
      .finally(() => {
        if (g === generation.current) setBusy(false);
      });
    return () => {
      generation.current++;
    };
  }, [client, team.id]);
  async function run(action: () => Promise<void>) {
    const g = generation.current;
    setBusy(true);
    setError("");
    try {
      await action();
      const m = await client.listMembers({ teamId: team.id });
      if (g === generation.current) {
        setMembers(m);
        onMembershipChange?.();
      }
    } catch (e) {
      if (g === generation.current) setError(message(e));
    } finally {
      if (g === generation.current) setBusy(false);
    }
  }
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    const g = generation.current;
    await run(async () => {
      const i = await client.invite({ teamId: team.id, email, role });
      if (g === generation.current) {
        setLink(
          new URL(
            "/?invitation=" + encodeURIComponent(i.token),
            window.location.origin,
          ).href,
        );
        setEmail("");
      }
    });
  }
  return (
    <section aria-label="团队成员">
      <h2>{team.name}的成员</h2>
      {busy && <p role="status">正在处理…</p>}
      {error && <p role="alert">{error}</p>}
      <ul>
        {members.map((m) => (
          <li key={m.id}>
            <span>
              {m.displayName} · {m.email ?? "未公开邮箱"} · {labels[m.role]}
            </span>
            {team.role === "admin" && (
              <>
                <RoleSelect
                  value={m.role}
                  disabled={busy}
                  onChange={(role) =>
                    void run(() =>
                      client.changeRole({
                        teamId: team.id,
                        userId: m.id,
                        role,
                      }),
                    )
                  }
                />
                <button
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`确定移除成员 ${m.displayName}？`))
                      void run(() =>
                        client.removeMember({ teamId: team.id, userId: m.id }),
                      );
                  }}
                >
                  移除成员
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      {team.role === "admin" && (
        <form onSubmit={invite}>
          <label>
            邀请邮箱{" "}
            <input
              type="email"
              required
              maxLength={320}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <RoleSelect value={role} onChange={setRole} disabled={busy} />
          <button disabled={busy}>生成邀请链接</button>
        </form>
      )}
      {link && (
        <label>
          复制邀请链接（仅可使用一次）
          <input
            aria-label="邀请链接"
            readOnly
            value={link}
            onFocus={(e) => e.target.select()}
            style={{ maxWidth: "100%", width: "100%", boxSizing: "border-box" }}
          />
        </label>
      )}
    </section>
  );
}
export function AcceptInvitation({
  client,
  token,
  onAccepted,
}: {
  client: IdentityClient;
  token: string;
  onAccepted?: (team: IdentityTeam) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setBusy(false);
    setError("");
    setDone(false);
    return () => {
      generation.current++;
    };
  }, [client, token]);
  return (
    <section aria-label="接受团队邀请">
      <p>请使用受邀邮箱对应的 GitHub 账号登录，再接受邀请。</p>
      <button
        disabled={busy || done}
        onClick={async () => {
          const g = generation.current;
          setBusy(true);
          setError("");
          try {
            const team = await client.accept({ token });
            if (g === generation.current) {
              setDone(true);
              onAccepted?.(team);
            }
          } catch (e) {
            if (g === generation.current) setError(message(e));
          } finally {
            if (g === generation.current) setBusy(false);
          }
        }}
      >
        {done ? "已加入团队" : busy ? "正在加入…" : "接受邀请"}
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
