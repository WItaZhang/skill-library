import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { JSDOM } from "jsdom";
import {
  TeamMembers,
  TeamPicker,
  AcceptInvitation,
  IdentityPanel,
} from "./components.tsx";
import type {
  IdentityClient,
  IdentityMember,
  IdentitySession,
} from "./types.ts";

test("React 交互：团队切换隔离旧响应、错误保留输入、邀请与注销", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://app.example",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { render, fireEvent, waitFor, cleanup, act } =
    await import("@testing-library/react");
  try {
    let resolveOld!: (m: IdentityMember[]) => void;
    const old = new Promise<IdentityMember[]>((resolve) => {
      resolveOld = resolve;
    });
    const current = {
      id: "new-user",
      displayName: "新团队成员",
      email: "new@example.com",
      role: "viewer" as const,
      joinedAt: "",
    };
    const client = {
      listMembers: async ({ teamId }: { teamId: string }) =>
        teamId === "old" ? old : [current],
      invite: async () => {
        throw new Error("邀请失败，请检查邮箱");
      },
    } as unknown as IdentityClient;
    const view = render(
      <TeamMembers
        client={client}
        team={{ id: "old", name: "旧团队", role: "admin" }}
      />,
    );
    view.rerender(
      <TeamMembers
        client={client}
        team={{ id: "new", name: "新团队", role: "admin" }}
      />,
    );
    await waitFor(() => assert.ok(view.getByText(/新团队成员/)));
    await act(async () =>
      resolveOld([
        { ...current, id: "old-user", displayName: "不应泄露的旧成员" },
      ]),
    );
    assert.equal(view.queryByText(/不应泄露/), null);
    fireEvent.change(view.getByLabelText("邀请邮箱"), {
      target: { value: "kept@example.com" },
    });
    fireEvent.submit(view.getByText("生成邀请链接").closest("form")!);
    await waitFor(() =>
      assert.match(view.getByRole("alert").textContent!, /邀请失败/),
    );
    assert.equal(
      (view.getByLabelText("邀请邮箱") as HTMLInputElement).value,
      "kept@example.com",
    );
    cleanup();
    let created = "";
    const pickerClient = {
      listTeams: async () => [],
      createTeam: async ({ name }: { name: string }) => ({
        id: "created",
        name,
        role: "admin",
      }),
    } as unknown as IdentityClient;
    const picker = render(
      <TeamPicker
        client={pickerClient}
        onSelect={(team) => {
          created = team.name;
        }}
      />,
    );
    await waitFor(() => assert.ok(picker.getByText(/你还没有团队/)));
    fireEvent.change(picker.getByLabelText("新团队名称"), {
      target: { value: "新的空间" },
    });
    fireEvent.submit(picker.getByText("创建团队").closest("form")!);
    await waitFor(() => assert.equal(created, "新的空间"));
    cleanup();
    let accepted = 0;
    const invitation = render(
      <AcceptInvitation
        client={
          {
            accept: async () => {
              accepted++;
              return { id: "x", name: "t", role: "viewer" };
            },
          } as unknown as IdentityClient
        }
        token="secret"
      />,
    );
    fireEvent.click(invitation.getByRole("button"));
    await waitFor(() => assert.ok(invitation.getByText("已加入团队")));
    fireEvent.click(invitation.getByRole("button"));
    assert.equal(accepted, 1);
    cleanup();
    const session = {
      user: { id: "u", displayName: "当前用户", email: null },
      csrfToken: "x",
      expiresAt: "",
    } satisfies IdentitySession;
    let changed: IdentitySession | null | undefined;
    const identity = render(
      <IdentityPanel
        client={
          {
            session: async () => session,
            logout: async () => {},
            loginUrl: "/api/identity/login",
          } as unknown as IdentityClient
        }
        onSessionChange={(s) => {
          changed = s;
        }}
      />,
    );
    await waitFor(() => assert.ok(identity.getByText("退出登录")));
    fireEvent.click(identity.getByText("退出登录"));
    await waitFor(() => assert.equal(changed, null));
    assert.ok(identity.getByText("使用 GitHub 登录"));
  } finally {
    cleanup();
    dom.window.close();
  }
});
