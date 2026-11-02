import {
  DomainError,
  type Actor,
  type SkillUpdateSource,
  type RuntimeService,
} from "../../contracts/index.ts";
import type { ProductionLibraryService } from "../../contracts/production.ts";
import type { ExecutionClient } from "../../contracts/execution.ts";
import { createExecutionClient } from "../execution/client.ts";
import {
  createHttpLibraryClient,
  createSseSkillUpdateSource,
  type EventSourceLike,
} from "../broadcast/client.ts";

/** One disposable scope per authenticated user/session/team/role. Never share across identities. */
export function createProductScope(options: {
  actor: Actor;
  csrfToken: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  EventSource?: new (
    url: string,
    options?: { withCredentials?: boolean },
  ) => EventSourceLike;
  onForbidden: () => void;
}) {
  const controller = new AbortController();
  let active = true;
  const subscriptions = new Set<() => void>();
  let execution: ExecutionClient | undefined;
  function dispose() {
    if (!active) return;
    active = false;
    controller.abort();
    execution?.dispose();
    for (const stop of subscriptions) stop();
    if (typeof sessionStorage !== "undefined")
      for (const key of Object.keys(sessionStorage)) {
        if (
          key.startsWith(
            `skill-draft:${options.actor.teamId}:${options.actor.userId}:`,
          ) ||
          key ===
            `skill-library:session:${options.actor.teamId}:${options.actor.userId}`
        )
          sessionStorage.removeItem(key);
      }
  }
  function forbidden() {
    if (!active) return;
    // Invalidate synchronously: React unmount happens later and other responses
    // may already be queued in this event-loop turn.
    dispose();
    options.onForbidden();
  }
  const assertActive = () => {
    if (!active)
      throw new DomainError("FORBIDDEN", "登录身份已变化，请重新打开技能。");
  };
  const scopedFetch: typeof fetch = async (url, init) => {
    assertActive();
    const headers = new Headers(init?.headers);
    headers.set("X-Team-Id", options.actor.teamId);
    headers.set("X-CSRF-Token", options.csrfToken);
    const response = await (options.fetch ?? fetch)(url, {
      ...init,
      headers,
      signal: init?.signal
        ? AbortSignal.any([controller.signal, init.signal])
        : controller.signal,
    });
    assertActive();
    if (response.status === 401 || response.status === 403) forbidden();
    return response;
  };
  const base = (options.baseUrl ?? "").replace(/\/$/, "");
  const original = createHttpLibraryClient({
    baseUrl: base,
    fetch: scopedFetch,
  });
  async function call(method: string, args: unknown[], area = "management") {
    const response = await scopedFetch(`${base}/api/${area}/${method}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Skill-Library": "1" },
      body: JSON.stringify({ args }),
    });
    const body = await response.json();
    assertActive();
    if (!response.ok)
      throw new DomainError(
        body.error?.code ?? "UNAVAILABLE",
        body.error?.message ?? "请求失败。",
      );
    return body.result;
  }
  const library = {
    ...original,
    listManagedSkills: (_a: Actor, ...args: unknown[]) =>
      call("listManagedSkills", args),
    listDrafts: (_a: Actor, ...args: unknown[]) => call("listDrafts", args),
    updateSkill: (_a: Actor, ...args: unknown[]) => call("updateSkill", args),
    archiveSkill: (_a: Actor, ...args: unknown[]) => call("archiveSkill", args),
    restoreSkill: (_a: Actor, ...args: unknown[]) => call("restoreSkill", args),
  } as unknown as ProductionLibraryService;
  const guardedLibrary = Object.fromEntries(
    Object.entries(library).map(([method, operation]) => [
      method,
      async (...args: unknown[]) => {
        assertActive();
        const value = await operation(...args);
        assertActive();
        return value;
      },
    ]),
  ) as unknown as ProductionLibraryService;
  const runtime = Object.fromEntries(
    [
      "createSession",
      "createTask",
      "getTask",
      "createChildTask",
      "resolveSkill",
      "recordInvocation",
      "listInvocations",
      "getSessionUpdates",
      "setPreference",
    ].map((method) => [
      method,
      (_actor: Actor, ...args: unknown[]) => call(method, args, "runtime"),
    ]),
  ) as unknown as RuntimeService;
  const Factory = options.EventSource ?? globalThis.EventSource;
  // Native SSE cannot set headers. teamId is a selector, authenticated by the Cookie server-side.
  class TeamEvents implements EventSourceLike {
    source: EventSourceLike;
    constructor(url: string) {
      this.source = new Factory(
        `${url}&teamId=${encodeURIComponent(options.actor.teamId)}`,
        { withCredentials: true },
      );
    }
    addEventListener(
      type: string,
      listener: (event: { data?: string }) => void,
    ) {
      this.source.addEventListener(type, listener);
    }
    removeEventListener(
      type: string,
      listener: (event: { data?: string }) => void,
    ) {
      this.source.removeEventListener(type, listener);
    }
    close() {
      this.source.close();
    }
  }
  const events = createSseSkillUpdateSource({
    baseUrl: base,
    EventSource: TeamEvents,
  });
  execution = createExecutionClient({
    baseUrl: base,
    teamId: options.actor.teamId,
    csrfToken: options.csrfToken,
    fetch: scopedFetch,
    onForbidden: forbidden,
  });
  let checkingAccess: Promise<void> | undefined;
  function verifyAccess() {
    // Native EventSource does not expose HTTP status on a failed handshake.
    // Recheck authority after errors/reconnects, including revocation while offline.
    if (checkingAccess || !active) return checkingAccess;
    checkingAccess = (async () => {
      try {
        const sessionResponse = await scopedFetch(
          `${base}/api/identity/session`,
          { credentials: "same-origin" },
        );
        if (!sessionResponse.ok) return;
        const body = await sessionResponse.json();
        if (!Object.hasOwn(body, "data")) return;
        const session = body.data;
        if (!active) return;
        if (
          !session ||
          session.user.id !== options.actor.userId ||
          session.csrfToken !== options.csrfToken
        ) {
          forbidden();
          return;
        }
        const response = await scopedFetch(`${base}/api/identity/listTeams`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!response.ok) return;
        const teams = (await response.json()).data;
        if (
          active &&
          !teams.some(
            (team: { id: string; role: string }) =>
              team.id === options.actor.teamId &&
              team.role === options.actor.role,
          )
        )
          forbidden();
      } catch {
        /* Offline input stays in memory; authority is checked again on reconnect. */
      } finally {
        checkingAccess = undefined;
      }
    })();
    return checkingAccess;
  }
  const listeners = new Set<Parameters<SkillUpdateSource["subscribe"]>[1]>();
  let connection: (() => void) | undefined;
  const updateSource: SkillUpdateSource = {
    subscribe(actor, handlers) {
      assertActive();
      listeners.add(handlers);
      if (!connection)
        connection = events.subscribe(actor, {
          onUpdate: (event) => {
            if (active)
              for (const listener of listeners) listener.onUpdate(event);
          },
          onReconnect: () => {
            if (active) {
              void verifyAccess();
              for (const listener of listeners) listener.onReconnect();
            }
          },
          onError: (error) => {
            if (!active) return;
            if (error instanceof DomainError && error.code === "FORBIDDEN") {
              forbidden();
              return;
            }
            void verifyAccess();
            for (const listener of listeners) listener.onError?.(error);
          },
        });
      const stop = () => {
        listeners.delete(handlers);
        if (!listeners.size) {
          connection?.();
          connection = undefined;
        }
        subscriptions.delete(stop);
      };
      subscriptions.add(stop);
      return stop;
    },
  };
  return {
    library: guardedLibrary,
    runtime,
    execution,
    updateSource,
    dispose,
  };
}
