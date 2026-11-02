import "@testing-library/jest-dom/vitest";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ProductionProduct } from "./Product";
import { createProductFixture } from "./fixture";
import { DomainError } from "../../contracts";
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});
async function setup(
  role?: "viewer",
  prepare?: (fixture: Awaited<ReturnType<typeof createProductFixture>>) => void,
) {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const fixture = await createProductFixture();
  prepare?.(fixture);
  if (role) fixture.actor = { ...fixture.actor, role };
  const dirty = vi.fn();
  render(
    <ProductionProduct
      actor={fixture.actor}
      library={fixture.library}
      updateSource={fixture.updateSource}
      onDirtyChange={dirty}
      identityPanel={<span>测试账号</span>}
    />,
  );
  await screen.findByRole("button", { name: /深度研究助手.*查看/ });
  return { ...fixture, dirty };
}
async function detail() {
  fireEvent.click(screen.getByRole("button", { name: /深度研究助手.*查看/ }));
  await screen.findByRole("button", { name: "编辑技能" });
}
describe("正式产品界面（显式内存 fixture；真实 PostgreSQL 另测）", () => {
  it("keeps list/detail/editor separate and hides demo controls", async () => {
    await setup();
    expect(screen.queryByText("协作演示")).not.toBeInTheDocument();
    await detail();
    expect(
      screen.queryByRole("textbox", { name: "SKILL.md" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑技能" }));
    await screen.findByRole("textbox", { name: "SKILL.md" });
    expect(screen.queryByText("让同事发布新版")).not.toBeInTheDocument();
  });
  it("creates, edits, saves and publishes an author draft", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "＋ 新建技能" }));
    fireEvent.change(screen.getByLabelText("技能名称"), {
      target: { value: "正式流程测试" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并编辑" }));
    const text = await screen.findByRole("textbox", { name: "SKILL.md" });
    fireEvent.change(text, { target: { value: "# 正式内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿已保存");
    fireEvent.change(screen.getByLabelText("修改说明"), {
      target: { value: "首次发布" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交并生效" }));
    await screen.findByText("v1 已自动生效");
  });
  it("preserves metadata inputs on revision conflict and requires explicit reconciliation", async () => {
    const f = await setup();
    await detail();
    vi.spyOn(f.library, "updateSkill").mockRejectedValueOnce(
      new DomainError("STALE_REVISION", "名称已被其他成员更新"),
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑名称与简介" }));
    fireEvent.change(screen.getByLabelText("技能名称"), {
      target: { value: "保留我的名称" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存名称与简介" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("技能名称")).toHaveValue("保留我的名称");
    fireEvent.click(screen.getByRole("button", { name: "读取最新元信息" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "已核对，采用最新修订号" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存名称与简介" }));
    await screen.findByRole("heading", { name: "保留我的名称" });
  });
  it("compares historical content and restores as a separate draft", async () => {
    await setup();
    await detail();
    fireEvent.click(screen.getByRole("button", { name: /版本历史/ }));
    const base = screen.getByLabelText("基础版本"),
      target = screen.getByLabelText("目标版本");
    fireEvent.change(base, {
      target: { value: (base as HTMLSelectElement).options[2].value },
    });
    fireEvent.change(target, {
      target: { value: (target as HTMLSelectElement).options[1].value },
    });
    fireEvent.click(screen.getByRole("button", { name: "比较版本" }));
    await screen.findByLabelText("版本差异");
    fireEvent.click(screen.getAllByRole("button", { name: "恢复为草稿" })[1]);
    await screen.findByRole("textbox", { name: "SKILL.md" });
    expect(
      (screen.getByRole("textbox", { name: "SKILL.md" }) as HTMLTextAreaElement)
        .value,
    ).toContain("# 深度研究助手");
  });
  it("archives, hides from default list, and restores", async () => {
    await setup();
    await detail();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "归档技能" }));
    await screen.findByText("技能已归档；历史保留，恢复后可继续编辑。");
    expect(screen.getByRole("button", { name: "编辑技能" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "← 全部技能" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /深度研究助手.*查看/ }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByLabelText("包含归档"));
    await screen.findByRole("button", { name: /深度研究助手.*查看/ });
    await detail();
    fireEvent.click(screen.getByRole("button", { name: "恢复归档技能" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "编辑技能" })).toBeEnabled(),
    );
  });
  it("prevents navigation and unload with unsaved metadata", async () => {
    const f = await setup();
    await detail();
    fireEvent.click(screen.getByRole("button", { name: "编辑名称与简介" }));
    fireEvent.change(screen.getByLabelText("技能名称"), {
      target: { value: "未保存" },
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "← 全部技能" }));
    expect(screen.getByLabelText("技能名称")).toHaveValue("未保存");
    expect(f.dirty).toHaveBeenLastCalledWith(true);
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  it("recovers saved author drafts from the service with no browser cache", async () => {
    const f = await setup();
    const skill = (await f.library.listSkills(f.actor))[0];
    const d = await f.library.createDraft(f.actor, skill.id);
    vi.spyOn(f.library, "listDrafts").mockResolvedValue([d]);
    await detail();
    fireEvent.click(await screen.findByRole("button", { name: "继续此草稿" }));
    await screen.findByText(`已载入草稿 · 修订 ${d.revision}`);
    expect(
      sessionStorage.getItem(
        `skill-draft:${f.actor.teamId}:${f.actor.userId}:${skill.id}:current`,
      ),
    ).toBe(d.id);
  });
  it("publication events preserve unsaved text and require author synchronization", async () => {
    const f = await setup();
    await detail();
    fireEvent.click(screen.getByRole("button", { name: "编辑技能" }));
    const editor = await screen.findByRole("textbox", { name: "SKILL.md" });
    fireEvent.change(editor, { target: { value: "# 我的未保存输入" } });
    const skill = (await f.library.listSkills(f.actor)).find(
      (s) => s.name === "深度研究助手",
    )!;
    await f.simulatePublication(skill.id);
    await screen.findByText(/此技能已有新版本/);
    expect(editor).toHaveValue("# 我的未保存输入");
    expect(screen.getByRole("button", { name: "提交并生效" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新比较并查看更新" }));
    await screen.findByRole("region", { name: "作者更新处理" });
    expect(editor).toHaveValue("# 我的未保存输入");
  });
  it("viewer does not request private draft recovery", async () => {
    let list: any;
    await setup("viewer", (f) => {
      f.actor.userId = "unprivileged-viewer";
      list = vi.spyOn(f.library, "listDrafts");
    });
    await detail();
    expect(screen.queryByText("我的已保存草稿")).not.toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "编辑技能" })).toBeDisabled();
  });
  it("viewer cannot create skills", async () => {
    await setup("viewer");
    expect(screen.getByRole("button", { name: "＋ 新建技能" })).toBeDisabled();
  });
});
