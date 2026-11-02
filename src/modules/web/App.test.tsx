import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { DomainError, type SkillUpdateSource } from "../../contracts";
import { App } from "./App";
import { createDemo } from "./demo";
import { DraftEditor } from "./DraftEditor";
import { Conversation } from "./Conversation";
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
    const submit = vi.spyOn(library, "publishDraft");
    await user.type(input, "\n新的指南");
    await user.type(screen.getByLabelText("修改说明"), "补充指南");
    expect(screen.getByRole("button", { name: "提交并生效" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "保存草稿" }));
    await screen.findByText("草稿已保存");
    await user.click(screen.getByRole("button", { name: "提交并生效" }));
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

it("没有内容变化时不能提交", async () => {
  const { user } = await editor();
  await user.type(screen.getByLabelText("修改说明"), "仅说明，没有改内容");
  expect(screen.getByRole("button", { name: "提交并生效" })).toBeDisabled();
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

it("广播保留脏输入，无重叠也必须确认，随后独立自动生效", async () => {
  const { library, actor, user, input, draft, simulatePublication } =
    await editor();
  await user.type(input, "\n本地未保存");
  const before = (input as HTMLTextAreaElement).value;
  await simulatePublication("research");
  expect(await screen.findByText(/此技能已有新版本/)).toBeInTheDocument();
  expect(input).toHaveValue(before);
  expect((await library.getDraft(actor, draft.id)).baseVersionId).toBe(
    "research-v2",
  );
  const preview = vi.spyOn(library, "previewDraftUpdate");
  await user.click(screen.getByRole("button", { name: "重新比较并查看更新" }));
  expect(await screen.findByText(/没有重叠修改/)).toBeInTheDocument();
  expect(preview.mock.calls[0][1].content.files[0].content).toBe(before);
  expect(screen.getByRole("button", { name: "确认同步草稿" })).toBeDisabled();
  await user.click(screen.getByLabelText("我已检查最终内容，确认同步草稿基线"));
  await user.click(screen.getByRole("button", { name: "确认同步草稿" }));
  await waitFor(() =>
    expect(screen.queryByText(/此技能已有新版本/)).not.toBeInTheDocument(),
  );
  expect(input).toHaveValue(before);
  await user.type(screen.getByLabelText("修改说明"), "我的改进");
  await user.click(screen.getByRole("button", { name: "提交并生效" }));
  expect(await screen.findByText("v4 已自动生效")).toBeInTheDocument();
  const v = (await library.listVersions(actor, "research"))[0];
  expect(v.reviewerId).toBeNull();
  expect(v.approvalMode).toBe("automatic");
  expect(await library.listUpdateEvents(actor, 0)).toHaveLength(2);
});

it("预览后继续输入使旧预览失效，刷新包含最新输入", async () => {
  const { user, input, simulatePublication } = await editor();
  await simulatePublication("research");
  await user.click(
    await screen.findByRole("button", { name: "重新比较并查看更新" }),
  );
  await screen.findByText(/没有重叠修改/);
  await user.type(input, "\n预览后的输入");
  expect(screen.getByRole("button", { name: "确认同步草稿" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "重新比较并查看更新" }));
  await waitFor(() =>
    expect(
      screen.getByLabelText("我已检查最终内容，确认同步草稿基线"),
    ).toBeEnabled(),
  );
  await user.click(screen.getByLabelText("我已检查最终内容，确认同步草稿基线"));
  await user.click(screen.getByRole("button", { name: "确认同步草稿" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "作者更新处理" }),
    ).not.toBeInTheDocument(),
  );
  expect((input as HTMLTextAreaElement).value).toContain("预览后的输入");
});

it("保存请求期间仍可输入，预览等待保存，旧响应不覆盖输入", async () => {
  const { library, user, input, simulatePublication } = await editor();
  const original = library.saveDraft.bind(library);
  let finish!: () => void;
  vi.spyOn(library, "saveDraft").mockImplementationOnce(async (a, i) => {
    await new Promise<void>((r) => {
      finish = r;
    });
    return original(a, i);
  });
  await user.type(input, "\n保存快照");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await user.type(input, "\n请求期间继续输入");
  await simulatePublication("research");
  expect(
    await screen.findByRole("button", { name: "重新比较并查看更新" }),
  ).toBeDisabled();
  finish();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "重新比较并查看更新" }),
    ).toBeEnabled(),
  );
  expect((input as HTMLTextAreaElement).value).toContain("请求期间继续输入");
  expect(screen.getByText("有未保存的修改")).toBeInTheDocument();
});

it("应用请求期间的新输入保留为脏内容，自动保存不抢先写入", async () => {
  const { library, user, input, simulatePublication } = await editor();
  await simulatePublication("research");
  await user.click(
    await screen.findByRole("button", { name: "重新比较并查看更新" }),
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText("我已检查最终内容，确认同步草稿基线"),
    ).toBeEnabled(),
  );
  const original = library.applyDraftUpdate.bind(library);
  let finish!: () => void;
  vi.spyOn(library, "applyDraftUpdate").mockImplementationOnce(async (a, i) => {
    await new Promise<void>((r) => {
      finish = r;
    });
    return original(a, i);
  });
  const save = vi.spyOn(library, "saveDraft");
  await user.click(screen.getByLabelText("我已检查最终内容，确认同步草稿基线"));
  await user.click(screen.getByRole("button", { name: "确认同步草稿" }));
  await user.type(input, "\n应用期间输入");
  await new Promise((r) => setTimeout(r, 1900));
  expect(save).not.toHaveBeenCalled();
  finish();
  await screen.findByText(/请求期间的新输入仍保留/);
  await new Promise((r) => setTimeout(r, 1900));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled();
  expect(
    screen.getByRole("region", { name: "同步期间输入恢复" }),
  ).toHaveTextContent("另一作者新增的演示说明");
  expect((input as HTMLTextAreaElement).value).toContain("应用期间输入");
  expect(screen.getByText("有未保存的修改")).toBeInTheDocument();
});

it("发布响应丢失后以原请求重试，不产生重复版本且保留后续输入", async () => {
  const { library, actor, user, input } = await editor();
  await user.type(input, "\n发布内容");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("草稿已保存");
  await user.type(screen.getByLabelText("修改说明"), "直接发布");
  const original = library.publishDraft.bind(library);
  const publish = vi
    .spyOn(library, "publishDraft")
    .mockImplementationOnce(async (a, i) => {
      await original(a, i);
      throw new DomainError("UNAVAILABLE", "响应丢失");
    });
  await user.click(screen.getByRole("button", { name: "提交并生效" }));
  await screen.findByText(/响应丢失/);
  await user.type(input, "\n保留的新输入");
  await user.click(screen.getByRole("button", { name: "重试原发布请求" }));
  await screen.findByText("v3 已自动生效");
  expect(publish.mock.calls[1][1]).toEqual(publish.mock.calls[0][1]);
  expect(await library.listUpdateEvents(actor, 0)).toHaveLength(1);
  expect((input as HTMLTextAreaElement).value).toContain("保留的新输入");
});

it("重叠修改必须选择，目标再变后保留手动结果并要求复核", async () => {
  const { library, actor, user, input, simulatePublication } = await editor();
  await user.clear(input);
  await user.type(input, "# 本地内容");
  const other = { ...actor, userId: "other" };
  const d = await library.createDraft(other, "research");
  const saved = await library.saveDraft(other, {
    draftId: d.id,
    expectedRevision: 1,
    content: {
      files: [
        { path: "SKILL.md", content: "# 新版", mediaType: "text/markdown" },
      ],
    },
  });
  await library.publishDraft(other, {
    draftId: d.id,
    expectedRevision: saved.revision,
    expectedBaseVersionId: saved.baseVersionId,
    changeSummary: "新版",
    idempotencyKey: "other-publish",
  });
  await user.click(
    await screen.findByRole("button", { name: "重新比较并查看更新" }),
  );
  const result = await screen.findByLabelText("手动结果 · SKILL.md");
  await user.type(result, "# 手动选择");
  await simulatePublication("research");
  await waitFor(() =>
    expect(
      screen.getByLabelText("我已检查最终内容，确认同步草稿基线"),
    ).toBeDisabled(),
  );
  expect(result).toHaveValue("# 手动选择");
  const previewOriginal = library.previewDraftUpdate.bind(library);
  vi.spyOn(library, "previewDraftUpdate").mockImplementation(async (a, i) => ({
    ...(await previewOriginal(a, i)),
    conflicts: [],
  }));
  await user.click(screen.getByRole("button", { name: "重新比较并查看更新" }));
  await waitFor(() =>
    expect(
      screen.getByLabelText("我已检查最终内容，确认同步草稿基线"),
    ).toBeEnabled(),
  );
  expect(screen.getByLabelText("手动结果 · SKILL.md")).toHaveValue(
    "# 手动选择",
  );
  expect(
    screen.getByLabelText("已重新检查此选择 · SKILL.md"),
  ).not.toBeChecked();
  await user.click(screen.getByLabelText("已重新检查此选择 · SKILL.md"));
  await user.click(screen.getByLabelText("我已检查最终内容，确认同步草稿基线"));
  await user.click(screen.getByRole("button", { name: "确认同步草稿" }));
  await waitFor(() => expect(input).toHaveValue("# 手动选择"));
});

it("重连核对权威版本，过滤无关事件，重复乱序不倒退并在卸载时清理", async () => {
  const demo = await createDemo(),
    user = userEvent.setup();
  const skill = await demo.library.getSkill(demo.actor, "research"),
    draft = await demo.library.createDraft(demo.actor, "research");
  let handlers!: Parameters<SkillUpdateSource["subscribe"]>[1];
  const unsubscribe = vi.fn();
  const updateSource: SkillUpdateSource = {
    subscribe: (_a, h) => {
      handlers = h;
      return unsubscribe;
    },
  };
  const get = vi.spyOn(demo.library, "getSkill");
  const view = render(
    <DraftEditor
      {...demo}
      updateSource={updateSource}
      skill={skill}
      initialDraft={draft}
      onDirty={() => {}}
      onSubmitted={() => {}}
      onClose={() => {}}
    />,
  );
  const input = await screen.findByLabelText("SKILL.md");
  await user.type(input, "\n连接期间输入");
  await demo.simulatePublication("research");
  await demo.simulatePublication("research");
  const events = await demo.library.listUpdateEvents(demo.actor, 0);
  const count = get.mock.calls.length;
  act(() => {
    handlers.onUpdate({ ...events[1], skillId: "weekly" });
    handlers.onUpdate({ ...events[1], teamId: "other" });
  });
  expect(get).toHaveBeenCalledTimes(count);
  act(() => {
    handlers.onReconnect();
    handlers.onUpdate(events[1]);
    handlers.onUpdate(events[1]);
    handlers.onUpdate(events[0]);
  });
  await screen.findByText(/此技能已有新版本/);
  await user.click(screen.getByRole("button", { name: "重新比较并查看更新" }));
  await waitFor(() =>
    expect(
      screen.getByLabelText("我已检查最终内容，确认同步草稿基线"),
    ).toBeEnabled(),
  );
  await user.click(screen.getByLabelText("我已检查最终内容，确认同步草稿基线"));
  await user.click(screen.getByRole("button", { name: "确认同步草稿" }));
  await waitFor(async () =>
    expect(
      (await demo.library.getDraft(demo.actor, draft.id)).baseVersionId,
    ).toBe(events[1].versionId),
  );
  expect((input as HTMLTextAreaElement).value).toContain("连接期间输入");
  view.unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it("另一标签页保存使应用失效且保留本地输入与选择", async () => {
  const { library, actor, user, input, draft, simulatePublication } =
    await editor();
  await user.type(input, "\n仍须保留");
  await simulatePublication("research");
  await user.click(
    await screen.findByRole("button", { name: "重新比较并查看更新" }),
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText("我已检查最终内容，确认同步草稿基线"),
    ).toBeEnabled(),
  );
  await library.saveDraft(actor, {
    draftId: draft.id,
    expectedRevision: 1,
    content: draft.content,
  });
  await user.click(screen.getByLabelText("我已检查最终内容，确认同步草稿基线"));
  await user.click(screen.getByRole("button", { name: "确认同步草稿" }));
  await screen.findByText(/修订已更新/);
  expect((input as HTMLTextAreaElement).value).toContain("仍须保留");
  expect(screen.getByRole("button", { name: "确认同步草稿" })).toBeDisabled();
});

it("删除冲突显式删除资源而非创建空文件", async () => {
  const { library, actor, user, draft, simulatePublication } = await editor();
  await simulatePublication("research");
  const original = library.previewDraftUpdate.bind(library);
  vi.spyOn(library, "previewDraftUpdate").mockImplementation(async (a, i) => ({
    ...(await original(a, i)),
    conflicts: [
      {
        path: "notes.md",
        base: "旧",
        current: undefined,
        proposed: "我的修改",
      },
    ],
  }));
  const apply = vi.spyOn(library, "applyDraftUpdate");
  await user.click(
    await screen.findByRole("button", { name: "重新比较并查看更新" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "采用新版 · notes.md" }),
  );
  expect(screen.getByText(/删除此资源（不是空文件）/)).toBeInTheDocument();
  await user.click(screen.getByLabelText("我已检查最终内容，确认同步草稿基线"));
  await user.click(screen.getByRole("button", { name: "确认同步草稿" }));
  await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
  expect(
    apply.mock.calls[0][1].resolvedContent.files.some(
      (f) => f.path === "notes.md",
    ),
  ).toBe(false);
  expect(
    (await library.getDraft(actor, draft.id)).content.files.some(
      (f) => f.path === "notes.md",
    ),
  ).toBe(false);
});

it("没有评审导航，查看者不能编辑，跨团队和非作者草稿被拒绝", async () => {
  const demo = await createDemo(),
    user = userEvent.setup();
  render(
    <App
      {...demo}
      actor={{ ...demo.actor, userId: "viewer", role: "viewer" }}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "修改评审" }),
  ).not.toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: /深度研究助手/ }));
  expect(await screen.findByRole("button", { name: "修改" })).toBeDisabled();
  const d = await demo.library.createDraft(demo.actor, "research");
  await expect(
    demo.library.getDraft({ ...demo.actor, userId: "other" }, d.id),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    demo.library.listSkills({ ...demo.actor, teamId: "other" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    demo.library.publishDraft(
      { ...demo.actor, userId: "viewer", role: "viewer" },
      {
        draftId: d.id,
        expectedRevision: 1,
        expectedBaseVersionId: d.baseVersionId,
        changeSummary: "禁止",
        idempotencyKey: "no",
      },
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("既有维护者即使角色为viewer仍可编辑并独立发布", async () => {
  const demo = await createDemo(),
    user = userEvent.setup();
  const actor = { ...demo.actor, role: "viewer" as const };
  const skill = await demo.library.getSkill(actor, "research");
  skill.maintainerIds = [actor.userId];
  const draft = await demo.library.createDraft(actor, skill.id);
  render(
    <DraftEditor
      {...demo}
      actor={actor}
      skill={skill}
      initialDraft={draft}
      onDirty={() => {}}
      onSubmitted={() => {}}
      onClose={() => {}}
    />,
  );
  const input = await screen.findByLabelText("SKILL.md");
  expect(input).toBeEnabled();
  await user.type(input, "\n独立发布");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("草稿已保存");
  await user.type(screen.getByLabelText("修改说明"), "无需其他维护者");
  await user.click(screen.getByRole("button", { name: "提交并生效" }));
  expect(await screen.findByText("v3 已自动生效")).toBeInTheDocument();
});

it("打开时无广播源也能发现过期草稿，仍允许保存不完整文本", async () => {
  const demo = await createDemo(),
    user = userEvent.setup();
  const skill = await demo.library.getSkill(demo.actor, "research"),
    draft = await demo.library.createDraft(demo.actor, "research");
  await demo.simulatePublication("research");
  render(
    <DraftEditor
      library={demo.library}
      actor={demo.actor}
      skill={skill}
      initialDraft={draft}
      onDirty={() => {}}
      onSubmitted={() => {}}
      onClose={() => {}}
    />,
  );
  await screen.findByText(/此技能已有新版本/);
  await user.clear(await screen.findByLabelText("SKILL.md"));
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText("草稿已保存");
  const saved = await demo.library.getDraft(demo.actor, draft.id);
  expect(saved.baseVersionId).toBe("research-v2");
  expect(saved.content.files[0].content).toBe("");
  await user.type(screen.getByLabelText("修改说明"), "过期不能发布");
  expect(screen.getByRole("button", { name: "提交并生效" })).toBeDisabled();
  expect(await demo.library.listUpdateEvents(demo.actor, 0)).toHaveLength(1);
});
