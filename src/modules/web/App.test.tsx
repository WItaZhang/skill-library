import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { DomainError } from "../../contracts";
import { App } from "./App";
import { createDemo } from "./demo";
import { DraftEditor } from "./DraftEditor";
import { Conversation } from "./Conversation";
import { Reviews } from "./Reviews";
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
});
async function editor() {
  const demo = await createDemo();
  const skill = await demo.library.getSkill(demo.actor, "research");
  const draft = await demo.library.createDraft(demo.actor, skill.id);
  const user = userEvent.setup();
  render(
    <DraftEditor
      {...demo}
      skill={skill}
      initialDraft={draft}
      onDirty={() => {}}
      onSubmitted={() => {}}
      onClose={() => {}}
    />,
  );
  const input = await screen.findByLabelText("SKILL.md");
  return { ...demo, user, input, draft };
}
describe("草稿保护", () => {
  it("保存失败保留输入，显式重试后才显示已保存", async () => {
    const { library, user, input } = await editor();
    vi.spyOn(library, "saveDraft").mockRejectedValueOnce(
      new DomainError("UNAVAILABLE", "模拟保存故障"),
    );
    await user.clear(input);
    await user.type(input, "# 我的未丢失修改");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("模拟保存故障");
    expect(input).toHaveValue("# 我的未丢失修改");
    expect(screen.queryByText("草稿已保存")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试保存" }));
    expect(await screen.findByText("草稿已保存")).toBeInTheDocument();
    expect(input).toHaveValue("# 我的未丢失修改");
  });
  it("旧修订拒绝后读取服务器草稿，保留本地内容并明确采用新修订", async () => {
    const { library, actor, user, input, draft } = await editor();
    await library.saveDraft(actor, {
      draftId: draft.id,
      expectedRevision: draft.revision,
      content: {
        files: [
          {
            path: "SKILL.md",
            content: "# 另一标签页",
            mediaType: "text/markdown",
          },
        ],
      },
    });
    const save = vi.spyOn(library, "saveDraft");
    await user.clear(input);
    await user.type(input, "# 本地修改");
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("修订已更新");
    expect(input).toHaveValue("# 本地修改");
    await user.click(screen.getByRole("button", { name: "读取服务器草稿" }));
    expect(await screen.findByText("# 另一标签页")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "保留我的输入，采用最新修订号" }),
    );
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿已保存");
    expect(save).toHaveBeenLastCalledWith(
      actor,
      expect.objectContaining({
        expectedRevision: 2,
        content: {
          files: [
            {
              path: "SKILL.md",
              content: "# 本地修改",
              mediaType: "text/markdown",
            },
          ],
        },
      }),
    );
  });
  it("未保存时禁止提交，保存后提交固定修订和修改说明", async () => {
    const { library, user, input, actor } = await editor();
    const submit = vi.spyOn(library, "submitProposal");
    await user.type(input, "\n新的指南");
    await user.type(screen.getByLabelText("修改说明"), "补充指南");
    expect(screen.getByRole("button", { name: "提交修改" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿已保存");
    await user.click(screen.getByRole("button", { name: "提交修改" }));
    expect(submit).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        expectedRevision: 2,
        changeSummary: "补充指南",
        idempotencyKey: expect.any(String),
      }),
    );
  });
});
describe("评审与冲突", () => {
  it("作者即使是管理员也不能自审", async () => {
    const demo = await createDemo(),
      user = userEvent.setup();
    const review = vi.spyOn(demo.library, "mergeProposal");
    render(<Reviews {...demo} onDirty={() => {}} />);
    await user.click(
      await screen.findByRole("button", { name: /调整研究步骤/ }),
    );
    expect(
      await screen.findByText(/作者不能评审自己的提案/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准并生效" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "请求修改" })).toBeDisabled();
    expect(review).not.toHaveBeenCalled();
  });
  it("作者看到三方冲突并以解决结果创建新草稿", async () => {
    const demo = await createDemo(),
      user = userEvent.setup();
    const withdraw = vi.spyOn(demo.library, "withdrawProposal"),
      create = vi.spyOn(demo.library, "createDraft");
    render(<Reviews {...demo} onDirty={() => {}} />);
    await user.click(
      await screen.findByRole("button", { name: /调整研究步骤/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "重新比较并预览合并" }),
    );
    expect(
      await screen.findByRole("heading", { name: "解决修改冲突" }),
    ).toBeInTheDocument();
    expect(screen.getByText("最新内容")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "采用我的修改" }));
    await user.click(
      screen.getByRole("button", { name: "以解决结果创建新草稿" }),
    );
    expect(
      await screen.findByRole("heading", { name: "修改 · 深度研究助手" }),
    ).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith(demo.actor, "research");
    expect(withdraw).toHaveBeenCalledWith(demo.actor, "proposal-conflict", 1);
    expect(await screen.findByLabelText("SKILL.md")).toHaveValue(
      "# 深度研究助手\n\n先列出三个关键问题，再逐条研究。\n",
    );
    expect(screen.getByRole("button", { name: "提交修改" })).toBeDisabled();
  });
  it("非作者维护者必须确认合并预览，批准使用服务令牌", async () => {
    const demo = await createDemo(),
      user = userEvent.setup();
    const merge = vi.spyOn(demo.library, "mergeProposal");
    render(<Reviews {...demo} onDirty={() => {}} />);
    await user.click(
      await screen.findByRole("button", { name: /让周报输出更容易扫描/ }),
    );
    await screen.findByRole("heading", { name: "让周报输出更容易扫描" });
    expect(screen.getByRole("button", { name: "批准并生效" })).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "重新比较并预览合并" }),
    );
    await user.click(
      await screen.findByLabelText("我已检查最终内容，确认本次生效"),
    );
    await user.click(screen.getByRole("button", { name: "批准并生效" }));
    await waitFor(() =>
      expect(merge).toHaveBeenCalledWith(
        demo.actor,
        expect.objectContaining({
          proposalId: "proposal-review",
          expectedRevision: 1,
          expectedCurrentVersionId: "weekly-v2",
          confirmationToken: expect.stringMatching(/^preview-/),
        }),
      ),
    );
    expect(
      (await demo.library.listVersions(demo.actor, "weekly"))[0].number,
    ).toBe(3);
  });
});
describe("会话更新", () => {
  it("保留原版与使用新版传递准确目标及偏好修订，当前任务不变", async () => {
    const demo = await createDemo(),
      user = userEvent.setup();
    const original = await demo.runtime.getTask(
      demo.actor,
      "demo-running-task",
    );
    const set = vi.spyOn(demo.runtime, "setPreference");
    render(
      <Conversation
        {...demo}
        onSession={() => {}}
        onRequestedUsed={() => {}}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "后续任务保留原版" }),
    );
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith(demo.actor, {
        sessionId: "demo-session",
        skillId: "research",
        mode: "pinned",
        targetVersionId: "research-v1",
        expectedRevision: 0,
      }),
    );
    expect(await screen.findByText(/后续任务已保留 v1/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "当前任务及其重试、恢复不变",
    );
    await user.click(
      screen.getByRole("button", { name: "后续任务使用新版 v2" }),
    );
    await waitFor(() =>
      expect(set).toHaveBeenLastCalledWith(demo.actor, {
        sessionId: "demo-session",
        skillId: "research",
        mode: "latest",
        targetVersionId: "research-v2",
        expectedRevision: 1,
      }),
    );
    expect(await demo.runtime.getTask(demo.actor, "demo-running-task")).toEqual(
      original,
    );
  });
  it("目标过期时刷新状态并要求重新确认，不自动改成最新目标重试", async () => {
    const demo = await createDemo(),
      user = userEvent.setup();
    const set = vi
      .spyOn(demo.runtime, "setPreference")
      .mockRejectedValueOnce(
        new DomainError("STALE_REVISION", "目标版本已有更新"),
      );
    const refresh = vi.spyOn(demo.runtime, "getSessionUpdates");
    render(
      <Conversation
        {...demo}
        onSession={() => {}}
        onRequestedUsed={() => {}}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "后续任务使用新版 v2" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("重新确认");
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(set).toHaveBeenCalledTimes(1);
  });
  it("接受新任务时记录固定版本，偏好操作不重建任务", async () => {
    const demo = await createDemo(),
      user = userEvent.setup();
    const skill = await demo.library.getSkill(demo.actor, "research");
    const create = vi.spyOn(demo.runtime, "createTask");
    render(
      <Conversation
        {...demo}
        requestedSkill={skill}
        onSession={() => {}}
        onRequestedUsed={() => {}}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "接受新任务并载入技能" }),
    );
    expect(
      await screen.findByText("已接受任务 · 版本固定"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("当前任务不变，不会因以下选择切换版本。"),
    ).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
it("技能列表支持搜索、详情、历史和差异", async () => {
  const demo = await createDemo(),
    user = userEvent.setup();
  render(<App {...demo} demo />);
  await user.type(screen.getByRole("searchbox"), "周报");
  const card = await screen.findByRole("button", { name: /团队周报/ });
  expect(
    screen.queryByRole("button", { name: /清晰写作/ }),
  ).not.toBeInTheDocument();
  await user.click(card);
  await user.click(await screen.findByRole("button", { name: "历史版本" }));
  await user.selectOptions(screen.getByLabelText("原版本"), "weekly-v1");
  await user.selectOptions(screen.getByLabelText("目标版本"), "weekly-v2");
  await user.click(screen.getByRole("button", { name: "查看变化" }));
  expect(await screen.findByText("SKILL.md · 修改")).toBeInTheDocument();
});
it("加载失败有重试入口，重试后的空态清楚可见", async () => {
  const demo = await createDemo(),
    user = userEvent.setup();
  vi.spyOn(demo.library, "listSkills")
    .mockRejectedValueOnce(new DomainError("UNAVAILABLE", "暂时不可用"))
    .mockResolvedValue([]);
  render(<App {...demo} />);
  expect(screen.getByRole("status")).toHaveTextContent("正在加载");
  await user.click(await screen.findByRole("button", { name: "重试" }));
  expect(await screen.findByText(/没有找到技能/)).toBeInTheDocument();
});

it("冲突解决期间最新基线变化时拒绝保存，保留解决输入", async () => {
  const demo = await createDemo(),
    user = userEvent.setup();
  const create = demo.library.createDraft.bind(demo.library);
  vi.spyOn(demo.library, "createDraft").mockImplementation(async (a, s) => ({
    ...(await create(a, s)),
    baseVersionId: "newer-version",
  }));
  const save = vi.spyOn(demo.library, "saveDraft"),
    withdraw = vi.spyOn(demo.library, "withdrawProposal");
  render(<Reviews {...demo} onDirty={() => {}} />);
  await user.click(await screen.findByRole("button", { name: /调整研究步骤/ }));
  await user.click(
    await screen.findByRole("button", { name: "重新比较并预览合并" }),
  );
  const input = await screen.findByLabelText("解决结果 · SKILL.md");
  await user.type(input, "# 手动解决的内容");
  await user.click(
    screen.getByRole("button", { name: "以解决结果创建新草稿" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "最新内容再次变化",
  );
  expect(input).toHaveValue("# 手动解决的内容");
  expect(save).not.toHaveBeenCalled();
  expect(withdraw).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "重新比较并预览合并" }));
  expect(await screen.findByLabelText("解决结果 · SKILL.md")).toHaveValue(
    "# 手动解决的内容",
  );
});
it("冲突中采用不存在的最新版资源表示删除，不创建空文件", async () => {
  const demo = await createDemo(),
    user = userEvent.setup();
  const version = await demo.library.getVersion(demo.actor, "research-v2");
  vi.spyOn(demo.library, "previewMerge").mockResolvedValue({
    proposalId: "proposal-conflict",
    proposalRevision: 1,
    currentVersionId: "research-v2",
    confirmationToken: "preview-delete",
    content: version.content,
    conflicts: [
      {
        path: "references/guide.md",
        base: "old",
        current: undefined,
        proposed: "my change",
      },
    ],
  });
  const save = vi.spyOn(demo.library, "saveDraft");
  render(<Reviews {...demo} onDirty={() => {}} />);
  await user.click(await screen.findByRole("button", { name: /调整研究步骤/ }));
  await user.click(
    await screen.findByRole("button", { name: "重新比较并预览合并" }),
  );
  await user.click(await screen.findByRole("button", { name: "采用最新内容" }));
  expect(screen.getByText("解决结果：删除此资源")).toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "以解决结果创建新草稿" }),
  );
  await screen.findByRole("heading", { name: "修改 · 深度研究助手" });
  expect(save.mock.calls[0][1].content.files.map((f) => f.path)).toEqual([
    "SKILL.md",
  ]);
});
it("请求修改后作者可调整并重新提交无冲突的提案", async () => {
  const demo = await createDemo(),
    user = userEvent.setup();
  await demo.library.reviewProposal(demo.actor, {
    proposalId: "proposal-review",
    expectedRevision: 1,
    action: "request_changes",
    comment: "补充风险负责人",
  });
  const author = { ...demo.actor, userId: "lin" };
  const submit = vi.spyOn(demo.library, "submitProposal");
  render(<Reviews library={demo.library} actor={author} onDirty={() => {}} />);
  await user.click(
    await screen.findByRole("button", { name: /让周报输出更容易扫描/ }),
  );
  await user.click(
    await screen.findByRole("button", { name: "重新比较并预览合并" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "继续修改并重新提交" }),
  );
  const input = await screen.findByLabelText("SKILL.md");
  await user.type(input, "\n每项风险标注负责人。");
  await user.type(screen.getByLabelText("修改说明"), "补充风险负责人");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("草稿已保存");
  await user.click(screen.getByRole("button", { name: "提交修改" }));
  expect(submit).toHaveBeenCalledWith(
    author,
    expect.objectContaining({
      changeSummary: "补充风险负责人",
      expectedRevision: 3,
    }),
  );
  expect(
    (await demo.library.getProposal(author, "proposal-review")).status,
  ).toBe("withdrawn");
  expect((await demo.library.listProposals(author))[0].status).toBe("pending");
});
it("没有内容变化时不能提交", async () => {
  const { user } = await editor();
  await user.type(screen.getByLabelText("修改说明"), "仅说明，没有改内容");
  expect(screen.getByRole("button", { name: "提交修改" })).toBeDisabled();
});

it("请求修改状态可以比较但维护者不能直接批准", async () => {
  const demo = await createDemo(),
    user = userEvent.setup();
  await demo.library.reviewProposal(demo.actor, {
    proposalId: "proposal-review",
    expectedRevision: 1,
    action: "request_changes",
    comment: "请调整",
  });
  render(<Reviews {...demo} onDirty={() => {}} />);
  await user.click(
    await screen.findByRole("button", { name: /让周报输出更容易扫描/ }),
  );
  await user.click(
    await screen.findByRole("button", { name: "重新比较并预览合并" }),
  );
  await user.click(
    await screen.findByLabelText("我已检查最终内容，确认本次生效"),
  );
  expect(screen.getByRole("button", { name: "批准并生效" })).toBeDisabled();
});

it("停止编辑后自动保存并保留最后成功保存内容", async () => {
  const { library, actor, user, input, draft } = await editor();
  const save = vi.spyOn(library, "saveDraft");
  await user.type(input, "\n自动保存的段落");
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 3000 });
  expect(
    (await library.getDraft(actor, draft.id)).content.files[0].content,
  ).toContain("自动保存的段落");
  expect(await screen.findByText("草稿已保存")).toBeInTheDocument();
});
