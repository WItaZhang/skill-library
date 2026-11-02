import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createIdentityClient } from "../identity/client";
import {
  IdentityPanel,
  TeamPicker,
  TeamMembers,
  AcceptInvitation,
} from "../identity/components";
import type {
  IdentityClient,
  IdentitySession,
  IdentityTeam,
} from "../identity/types";
import { ProductionProduct } from "./Product";
import { createProductScope } from "./client";
import "./product.css";

export function App({ identityClient }: { identityClient?: IdentityClient }) {
  const rawClient = useMemo(
    () => identityClient ?? createIdentityClient(),
    [identityClient],
  );
  const [local, setLocal] = useState(false);
  useEffect(() => {
    void rawClient
      .authentication?.()
      .then((method) => setLocal(method === "local"))
      .catch(() => {});
  }, [rawClient]);
  const dirty = useRef(false);
  const epoch = useRef(0);
  const sessionRef = useRef<IdentitySession | null>(null);
  const [session, setSession] = useState<IdentitySession | null>(null);
  const [team, setTeam] = useState<IdentityTeam>();
  useEffect(() => {
    if (!local || !session || team) return;
    let active = true;
    void rawClient
      .listTeams()
      .then((teams) => {
        if (active && teams.length === 1) setTeam(teams[0]);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [local, session, team, rawClient]);
  const [notice, setNotice] = useState("");
  const scopeRef = useRef<ReturnType<typeof createProductScope> | null>(null);
  const permit = () =>
    !dirty.current ||
    window.confirm(
      "还有未保存的修改，切换团队或退出会放弃这些输入。确定继续？",
    );
  const reset = useCallback(() => {
    epoch.current++;
    scopeRef.current?.dispose();
    scopeRef.current = null;
    dirty.current = false;
    setTeam(undefined);
  }, []);
  const client = useMemo<IdentityClient>(
    () => ({
      ...rawClient,
      logout: async () => {
        if (!permit()) throw new Error("已取消退出，输入仍保留。");
        await rawClient.logout();
        reset();
        sessionRef.current = null;
        setSession(null);
      },
    }),
    [rawClient, reset],
  );
  const sessionChanged = useCallback(
    (next: IdentitySession | null) => {
      const current = sessionRef.current;
      if (
        current?.user.id !== next?.user.id ||
        current?.csrfToken !== next?.csrfToken
      )
        reset();
      sessionRef.current = next;
      setSession(next);
    },
    [reset],
  );
  const select = (next: IdentityTeam) => {
    if (!permit()) return;
    reset();
    setTeam(next);
    setNotice("");
  };
  const validate = useCallback(async () => {
    const started = epoch.current;
    try {
      const next = await rawClient.session();
      if (started !== epoch.current) return;
      if (
        !next ||
        next.user.id !== session?.user.id ||
        next.csrfToken !== session.csrfToken
      ) {
        reset();
        sessionRef.current = next;
        setSession(next);
        setNotice("登录状态已变化，请重新选择团队。");
        return;
      }
      if (team) {
        const teams = await rawClient.listTeams();
        if (started !== epoch.current) return;
        const fresh = teams.find((t) => t.id === team.id);
        if (!fresh || fresh.role !== team.role) {
          reset();
          setNotice("团队权限已变化，旧编辑会话已关闭，请重新选择团队。");
        }
      }
    } catch {
      if (started === epoch.current)
        setNotice("暂时无法核对登录状态，请检查连接。");
    }
  }, [rawClient, session, team, reset]);
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => void validate(), 15000);
    const focus = () => void validate();
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [session, validate]);
  const forbidden = useCallback(() => {
    reset();
    const started = epoch.current;
    setNotice("访问权限已失效，请重新登录或选择有权限的团队。");
    void rawClient
      .session()
      .then((next) => {
        if (started !== epoch.current) return;
        sessionRef.current = next;
        setSession(next);
      })
      .catch(() => {
        if (started !== epoch.current) return;
        sessionRef.current = null;
        setSession(null);
      });
  }, [rawClient, reset]);
  const identity = (
    <IdentityPanel client={client} onSessionChange={sessionChanged} />
  );
  const incomingToken = new URLSearchParams(window.location.search).get(
    "invitation",
  );
  if (incomingToken)
    sessionStorage.setItem("skill-library:invitation", incomingToken);
  const token =
    incomingToken ?? sessionStorage.getItem("skill-library:invitation");
  const account = (
    <div className="production-account">
      {identity}
      {session && !local && (
        <details>
          <summary>团队与成员</summary>
          <TeamPicker
            client={client}
            selectedTeamId={team?.id}
            onSelect={select}
          />
          {team && (
            <TeamMembers
              client={client}
              team={team}
              onMembershipChange={() => void validate()}
            />
          )}
        </details>
      )}
    </div>
  );
  return (
    <>
      {notice && <p role="alert">{notice}</p>}
      {session && team ? (
        <Workspace
          key={`${session.user.id}:${session.csrfToken}:${team.id}:${team.role}`}
          session={session}
          local={local}
          team={team}
          onForbidden={forbidden}
          scopeRef={scopeRef}
          onDirty={(v) => {
            dirty.current = v;
          }}
          identityPanel={account}
        />
      ) : (
        <main className="production-auth">
          <h1>{local ? "我的技能库" : "团队技能库"}</h1>
          {identity}
          {session && (
            <>
              <TeamPicker client={client} onSelect={select} />
              {token && (
                <AcceptInvitation
                  client={client}
                  token={token}
                  onAccepted={(selected) => {
                    sessionStorage.removeItem("skill-library:invitation");
                    history.replaceState(null, "", "/");
                    select(selected);
                  }}
                />
              )}
            </>
          )}
          <p>登录后选择团队，即可管理技能与个人草稿。</p>
        </main>
      )}
    </>
  );
}
function Workspace({
  session,
  local,
  team,
  onForbidden,
  scopeRef,
  onDirty,
  identityPanel,
}: {
  session: IdentitySession;
  local: boolean;
  team: IdentityTeam;
  onForbidden: () => void;
  scopeRef: React.RefObject<ReturnType<typeof createProductScope> | null>;
  onDirty: (v: boolean) => void;
  identityPanel: React.ReactNode;
}) {
  const actor = useMemo(
    () => ({ userId: session.user.id, teamId: team.id, role: team.role }),
    [session.user.id, team.id, team.role],
  );
  const scope = useMemo(
    () =>
      createProductScope({ actor, csrfToken: session.csrfToken, onForbidden }),
    [actor, session.csrfToken, onForbidden],
  );
  useEffect(() => {
    scopeRef.current = scope;
    // Keep the identity authority stream alive on lists and task pages too.
    const stop = scope.updateSource.subscribe(actor, {
      onUpdate() {},
      onReconnect() {},
    });
    return () => {
      stop();
      scope.dispose();
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [scope, scopeRef, actor]);
  return (
    <ProductionProduct
      actor={actor}
      execution={local ? undefined : scope.execution}
      localAccess={local ? { csrfToken: session.csrfToken } : undefined}
      library={scope.library}
      updateSource={scope.updateSource}
      identityPanel={identityPanel}
      onDirtyChange={onDirty}
    />
  );
}
