import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ExecutionPanel } from "../components.tsx";
import type {
  ExecutionClient,
  ExecutionRecord,
} from "../../../contracts/execution.ts";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const row: ExecutionRecord = {
  id: "execution1",
  taskId: "task1",
  teamId: "team1",
  ownerId: "owner1",
  prompt: "待办任务",
  skillIds: ["skill1"],
  status: "succeeded",
  snapshot: {
    taskId: "task1",
    sessionId: "session1",
    teamId: "team1",
    actorId: "owner1",
    versions: { skill1: "version1" },
    preferenceRevisions: {},
    createdAt: "2026-11-01",
  },
  attempts: [
    {
      id: "attempt1",
      number: 1,
      status: "succeeded",
      provider: "fixture",
      model: "fixture",
      providerRequestId: "fixture-request-id",
      errorCode: null,
      createdAt: "2026-11-01",
      startedAt: null,
      finishedAt: null,
    },
  ],
  result: {
    text: "执行结果正文 <script>unsafe</script>",
    attemptId: "attempt1",
    providerRequestId: "fixture-request-id",
  },
  createdAt: "2026-11-01",
  updatedAt: "2026-11-01",
};
const client = (): ExecutionClient => ({
  list: vi.fn(async () => [row]),
  get: vi.fn(async () => row),
  accept: vi.fn(async () => row),
  retry: vi.fn(async () => row),
  cancel: vi.fn(async () => row),
  dispose: vi.fn(),
});
const skills = [{ id: "skill1", name: "测试技能" }];
test("separate list/detail, pinned version and safe plain result display, child inherits parent", async () => {
  const c = client();
  render(<ExecutionPanel client={c} scopeKey="one" skills={skills} />);
  fireEvent.click(await screen.findByText("待办任务"));
  expect(screen.getByText(/version1/)).toBeTruthy();
  expect(screen.getByText(/fixture-request-id/)).toBeTruthy();
  expect(screen.getByText(row.result!.text)).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByText("创建子任务"));
  fireEvent.change(screen.getByLabelText("任务内容"), {
    target: { value: "child prompt" },
  });
  fireEvent.click(screen.getByText("开始执行"));
  await waitFor(() =>
    expect(c.accept).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: "task1",
        skillIds: ["skill1"],
        prompt: "child prompt",
      }),
    ),
  );
});
test("initial skill opens form, dirty callback protects input; failure keeps same idempotency key", async () => {
  const c = client();
  vi.mocked(c.accept).mockRejectedValue(new Error("暂时断线"));
  const dirty = vi.fn();
  render(
    <ExecutionPanel
      client={c}
      scopeKey="one"
      skills={skills}
      initialSkillId="skill1"
      onDirtyChange={dirty}
    />,
  );
  fireEvent.change(screen.getByLabelText("任务内容"), {
    target: { value: "未保存输入" },
  });
  expect(dirty).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByText("开始执行"));
  await screen.findByText("暂时断线");
  expect((screen.getByLabelText("任务内容") as HTMLTextAreaElement).value).toBe(
    "未保存输入",
  );
  fireEvent.click(screen.getByText("开始执行"));
  await waitFor(() => expect(c.accept).toHaveBeenCalledTimes(2));
  expect(vi.mocked(c.accept).mock.calls[0][0].idempotencyKey).toBe(
    vi.mocked(c.accept).mock.calls[1][0].idempotencyKey,
  );
  cleanup();
  expect(dirty).toHaveBeenLastCalledWith(false);
});
test("identity scope change synchronously clears prompt and result and ignores old list response", async () => {
  const c = client();
  let resolve!: (rows: ExecutionRecord[]) => void;
  vi.mocked(c.list).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(
    <ExecutionPanel
      client={c}
      scopeKey="old"
      skills={skills}
      initialSkillId="skill1"
    />,
  );
  fireEvent.change(screen.getByLabelText("任务内容"), {
    target: { value: "private input" },
  });
  const newer = client();
  vi.mocked(newer.list).mockResolvedValue([]);
  view.rerender(
    <ExecutionPanel client={newer} scopeKey="new" skills={skills} />,
  );
  expect(screen.queryByDisplayValue("private input")).toBeNull();
  resolve([row]);
  await waitFor(() => expect(screen.getByText("暂无执行任务。")).toBeTruthy());
  expect(screen.queryByText("待办任务")).toBeNull();
});
test("uncertain attempt requires cost acknowledgement before retry", async () => {
  const c = client();
  vi.mocked(c.list).mockResolvedValue([
    { ...row, status: "uncertain", result: null },
  ]);
  render(<ExecutionPanel client={c} scopeKey="one" skills={skills} />);
  fireEvent.click(await screen.findByText("待办任务"));
  expect(
    (screen.getByText("使用原版本重试") as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByText("使用原版本重试"));
  await waitFor(() =>
    expect(c.retry).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: row.id,
        acknowledgeUncertain: true,
      }),
    ),
  );
});

test("returning from an unfinished task requires confirmation and preserves input on cancel", async () => {
  const c = client();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(
    <ExecutionPanel
      client={c}
      scopeKey="one"
      skills={skills}
      initialSkillId="skill1"
    />,
  );
  fireEvent.change(screen.getByLabelText("任务内容"), {
    target: { value: "important input" },
  });
  fireEvent.click(screen.getByText("返回列表"));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText("任务内容") as HTMLTextAreaElement).value).toBe(
    "important input",
  );
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByText("返回列表"));
  expect(screen.queryByLabelText("任务内容")).toBeNull();
});
