import "@testing-library/jest-dom/vitest";
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { App } from "./App";
import { createProductFixture } from "./fixture";
import type { IdentityClient, IdentityTeam } from "../identity/types";
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./client", () => ({ createProductScope: mocks.create }));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});
async function setup() {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const f = await createProductFixture();
  const dispose = vi.fn();
  mocks.create.mockReturnValue({
    library: f.library,
    runtime: f.runtime,
    updateSource: f.updateSource,
    dispose,
  });
  const teams: IdentityTeam[] = [
    { id: f.actor.teamId, name: "团队一", role: f.actor.role },
    { id: "another-team", name: "团队二", role: "contributor" },
  ];
  const client: IdentityClient = {
    loginUrl: "/login",
    session: vi.fn(async () => ({
      user: { id: f.actor.userId, displayName: "测试用户", email: null },
      csrfToken: "fixture-session",
      expiresAt: "2099-01-01",
    })),
    listTeams: vi.fn(async () => teams),
    logout: vi.fn(async () => {}),
    createTeam: vi.fn(),
    invite: vi.fn(),
    accept: vi.fn(),
    listMembers: vi.fn(async () => []),
    changeRole: vi.fn(),
    removeMember: vi.fn(),
  };
  render(<App identityClient={client} />);
  await screen.findByRole("option", { name: /团队一/ });
  fireEvent.change(screen.getByLabelText("当前团队"), {
    target: { value: teams[0].id },
  });
  await screen.findByRole("button", { name: /深度研究助手.*查看/ });
  return { client, teams, dispose };
}
async function dirtyEditor() {
  fireEvent.click(screen.getByRole("button", { name: /深度研究助手.*查看/ }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑技能" }));
  fireEvent.change(await screen.findByRole("textbox", { name: "SKILL.md" }), {
    target: { value: "# 未保存，不能丢失" },
  });
}
it("team switching requires input confirmation, disposes old scope and removes editor", async () => {
  const { teams, dispose } = await setup();
  await dirtyEditor();
  await screen.findByRole("option", { name: /团队二/ });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.change(screen.getByLabelText("当前团队"), {
    target: { value: teams[1].id },
  });
  expect(screen.getByRole("textbox", { name: "SKILL.md" })).toHaveValue(
    "# 未保存，不能丢失",
  );
  expect(dispose).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.change(screen.getByLabelText("当前团队"), {
    target: { value: teams[1].id },
  });
  await waitFor(() => expect(dispose).toHaveBeenCalled());
  expect(
    screen.queryByRole("textbox", { name: "SKILL.md" }),
  ).not.toBeInTheDocument();
});
it("cancelled logout never calls identity logout and retains input", async () => {
  const { client } = await setup();
  await dirtyEditor();
  vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
  await screen.findByText("已取消退出，输入仍保留。");
  expect(client.logout).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "SKILL.md" })).toHaveValue(
    "# 未保存，不能丢失",
  );
});
it("revoked membership clears the editor on authoritative focus revalidation", async () => {
  const { client, dispose } = await setup();
  await dirtyEditor();
  vi.mocked(client.listTeams).mockResolvedValue([]);
  fireEvent.focus(window);
  await screen.findByText("团队权限已变化，旧编辑会话已关闭，请重新选择团队。");
  expect(dispose).toHaveBeenCalled();
  expect(
    screen.queryByRole("textbox", { name: "SKILL.md" }),
  ).not.toBeInTheDocument();
});
