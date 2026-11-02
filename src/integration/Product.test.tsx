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
import { Product } from "./Product";
import { createDemo } from "../modules/web/demo";
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});
async function setup() {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const demo = await createDemo();
  render(
    <Product
      actor={demo.actor}
      library={demo.library}
      runtime={demo.runtime}
      initialSessionId={demo.sessionId}
      updateSource={demo.updateSource}
      simulatePublication={demo.simulatePublication}
    />,
  );
  await screen.findByRole("button", { name: /深度研究助手.*查看/ });
  return demo;
}
describe("product navigation", () => {
  it("starts with a searchable catalog and opens details without mixing in an editor", async () => {
    await setup();
    expect(
      screen.queryByRole("textbox", { name: "SKILL.md" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "让同事发布新版" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "不存在的关键词" },
    });
    expect(screen.getByText("没有匹配的技能")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    fireEvent.click(screen.getByRole("button", { name: /深度研究助手.*查看/ }));
    await screen.findByRole("button", { name: "编辑技能" });
    fireEvent.click(screen.getByRole("button", { name: /版本历史/ }));
    expect(
      await screen.findAllByRole("button", { name: "恢复为草稿" }),
    ).toHaveLength(2);
  });
  it("creates a skill and retains its initial draft when entering the editor", async () => {
    const demo = await setup();
    fireEvent.click(screen.getByRole("button", { name: "＋ 新建技能" }));
    fireEvent.change(screen.getByLabelText("技能名称"), {
      target: { value: "新建验收技能" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并编辑" }));
    const editor = await screen.findByRole("textbox", { name: "SKILL.md" });
    expect(editor).toHaveValue(
      "# 新建验收技能\n\n在这里描述技能的使用场景与操作步骤。\n",
    );
    expect(
      (await demo.library.listSkills(demo.actor)).some(
        (s) => s.name === "新建验收技能",
      ),
    ).toBe(true);
  });
  it("loads a selected skill and presents its pinned task version", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /深度研究助手.*查看/ }));
    const use = await screen.findByRole("button", { name: "使用技能" });
    await waitFor(() => expect(use).toBeEnabled());
    fireEvent.click(use);
    fireEvent.click(await screen.findByRole("button", { name: "载入技能" }));
    expect(
      await screen.findByText("技能已载入，版本已固定。"),
    ).toBeInTheDocument();
    expect(await screen.findAllByText(/v2 · 已固定/)).not.toHaveLength(0);
  });
  it("refusing navigation retains unsaved editor text", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /深度研究助手.*查看/ }));
    fireEvent.click(await screen.findByRole("button", { name: "编辑技能" }));
    const editor = await screen.findByRole("textbox", { name: "SKILL.md" });
    fireEvent.change(editor, { target: { value: "# 不要丢失这段输入" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "主导航" })).getByRole(
        "button",
        { name: /技能库/ },
      ),
    );
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(screen.getByRole("textbox", { name: "SKILL.md" })).toHaveValue(
      "# 不要丢失这段输入",
    );
  });
});
