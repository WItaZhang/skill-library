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
    scope.updateSource.subscribe(actor, {
      onUpdate: vi.fn(),
      onReconnect: reconnect,
    });
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
    scope.dispose();
  });
});
