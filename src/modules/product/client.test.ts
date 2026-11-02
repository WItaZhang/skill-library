import { describe, it, expect, vi } from "vitest";
import { createProductScope } from "./client";
import type { EventSourceLike } from "../broadcast/client";
const actor = {
  userId: "fixture-author",
  teamId: "fixture-team",
  role: "contributor" as const,
};
describe("身份隔离客户端（显式传输 fixture）", () => {
  it("uses team and CSRF headers without sending a client actor", async () => {
    const request = vi.fn(
      async () => new Response(JSON.stringify({ result: [] })),
    );
    const scope = createProductScope({
      actor,
      csrfToken: "csrf-fixture",
      fetch: request,
      onForbidden: vi.fn(),
    });
    await scope.library.listManagedSkills(actor, { includeArchived: true });
    const [url, init] = request.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/management/listManagedSkills");
    expect(new Headers(init.headers).get("X-Team-Id")).toBe(actor.teamId);
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("csrf-fixture");
    expect(JSON.parse(init.body as string)).toEqual({
      args: [{ includeArchived: true }],
    });
    scope.dispose();
  });
  it("drops late responses and aborts requests when identity is replaced", async () => {
    let resolve!: (response: Response) => void;
    const request = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const scope = createProductScope({
      actor,
      csrfToken: "csrf",
      fetch: request,
      onForbidden: vi.fn(),
    });
    const pending = scope.library.listSkills(actor);
    scope.dispose();
    resolve(new Response(JSON.stringify({ result: [{ name: "旧身份内容" }] })));
    await expect(pending).rejects.toThrow();
    await expect(scope.library.listSkills(actor)).rejects.toThrow(
      "登录身份已变化",
    );
  });
  it("closes SSE, ignores queued callbacks and removes only current identity draft keys", () => {
    const sources: FakeEvents[] = [];
    class FakeEvents implements EventSourceLike {
      listeners = new Map<string, (event: { data?: string }) => void>();
      closed = false;
      constructor(public url: string) {
        sources.push(this);
      }
      addEventListener(t: string, f: (e: { data?: string }) => void) {
        this.listeners.set(t, f);
      }
      removeEventListener(t: string) {
        this.listeners.delete(t);
      }
      close() {
        this.closed = true;
      }
    }
    sessionStorage.setItem(
      "skill-draft:fixture-team:fixture-author:x:current",
      "draft",
    );
    sessionStorage.setItem("skill-draft:other:user:x:current", "other");
    const scope = createProductScope({
      actor,
      csrfToken: "csrf",
      EventSource: FakeEvents,
      onForbidden: vi.fn(),
    });
    const reconnect = vi.fn();
    const firstStop = scope.updateSource.subscribe(actor, {
      onUpdate: vi.fn(),
      onReconnect: reconnect,
    });
    scope.updateSource.subscribe(actor, {
      onUpdate: vi.fn(),
      onReconnect: vi.fn(),
    });
    expect(sources).toHaveLength(1);
    firstStop();
    expect(sources[0].closed).toBe(false);
    expect(sources[0].url).toContain("teamId=fixture-team");
    const late = sources[0].listeners.get("open")!;
    scope.dispose();
    late({});
    expect(reconnect).not.toHaveBeenCalled();
    expect(sources[0].closed).toBe(true);
    expect(
      sessionStorage.getItem(
        "skill-draft:fixture-team:fixture-author:x:current",
      ),
    ).toBeNull();
    expect(sessionStorage.getItem("skill-draft:other:user:x:current")).toBe(
      "other",
    );
    sessionStorage.clear();
  });
  it("signals membership rejection", async () => {
    const denied = vi.fn();
    const scope = createProductScope({
      actor,
      csrfToken: "csrf",
      onForbidden: denied,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { code: "FORBIDDEN", message: "成员已撤销" },
          }),
          { status: 403 },
        ),
    });
    await expect(scope.library.listSkills(actor)).rejects.toThrow();
    expect(denied).toHaveBeenCalledOnce();
    await expect(scope.library.listSkills(actor)).rejects.toThrow();
    expect(denied).toHaveBeenCalledOnce();
    scope.dispose();
  });
  it("revocation immediately disposes scope, SSE and queued responses", async () => {
    let source!: FakeEvents;
    class FakeEvents implements EventSourceLike {
      listeners = new Map<string, (event: { data?: string }) => void>();
      closed = false;
      constructor() {
        source = this;
      }
      addEventListener(t: string, f: (e: { data?: string }) => void) {
        this.listeners.set(t, f);
      }
      removeEventListener(t: string) {
        this.listeners.delete(t);
      }
      close() {
        this.closed = true;
      }
    }
    let resolve!: (r: Response) => void;
    const denied = vi.fn(),
      onUpdate = vi.fn();
    const scope = createProductScope({
      actor,
      csrfToken: "csrf",
      onForbidden: denied,
      EventSource: FakeEvents,
      fetch: () => new Promise<Response>((r) => (resolve = r)),
    });
    scope.updateSource.subscribe(actor, { onReconnect: vi.fn(), onUpdate });
    const pending = scope.library.listSkills(actor);
    const revoke = source.listeners.get("access.revoked")!;
    revoke({ data: '{"code":"FORBIDDEN"}' });
    revoke({});
    expect(denied).toHaveBeenCalledOnce();
    expect(source.closed).toBe(true);
    resolve(
      new Response(JSON.stringify({ result: [{ name: "已撤销团队内容" }] })),
    );
    await expect(pending).rejects.toThrow();
    expect(onUpdate).not.toHaveBeenCalled();
  });
  it("honors caller cancellation as well as identity disposal", async () => {
    let signal!: AbortSignal;
    const scope = createProductScope({
      actor,
      csrfToken: "csrf",
      onForbidden: vi.fn(),
      fetch: async (_url, init) => {
        signal = init!.signal!;
        return new Response(JSON.stringify({ result: [], data: [] }));
      },
    });
    await scope.execution.list();
    const executionSignal = signal;
    expect(executionSignal.aborted).toBe(false);
    scope.execution.dispose();
    expect(executionSignal.aborted).toBe(true);
    // Cancelling only the execution client must not abort the still-live library.
    await scope.library.listSkills(actor);
    expect(signal.aborted).toBe(false);
    scope.dispose();
    expect(signal.aborted).toBe(true);
  });
  it("a transient identity 503 during SSE failure must not revoke the scope", async () => {
    let source!: FakeEvents;
    class FakeEvents implements EventSourceLike {
      listeners = new Map<string, (event: { data?: string }) => void>();
      constructor() {
        source = this;
      }
      addEventListener(t: string, f: (e: { data?: string }) => void) {
        this.listeners.set(t, f);
      }
      removeEventListener(t: string) {
        this.listeners.delete(t);
      }
      close() {}
    }
    const denied = vi.fn();
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "UNAVAILABLE" } }), {
          status: 503,
        }),
    );
    const scope = createProductScope({
      actor,
      csrfToken: "csrf",
      onForbidden: denied,
      EventSource: FakeEvents,
      fetch: request,
    });
    scope.updateSource.subscribe(actor, {
      onUpdate: vi.fn(),
      onReconnect: vi.fn(),
    });
    source.listeners.get("error")!({});
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(denied).not.toHaveBeenCalled();
    request.mockImplementation(
      async () => new Response(JSON.stringify({ result: [] })),
    );
    await expect(scope.library.listSkills(actor)).resolves.toEqual([]);
    scope.dispose();
  });
});
