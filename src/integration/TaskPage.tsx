import { useCallback, useState } from "react";
import type {
  Actor,
  LibraryService,
  RuntimeService,
  SessionUpdate,
  Skill,
} from "../contracts";
import { Feedback, LoadState, useAction, useLoad } from "../modules/web/ui";
export function TaskPage({
  actor,
  library,
  runtime,
  sessionId,
  onSession,
  requestedSkill,
  onRequestedUsed,
}: {
  actor: Actor;
  library: LibraryService;
  runtime: RuntimeService;
  sessionId: string;
  onSession: (id: string) => void;
  requestedSkill?: Skill;
  onRequestedUsed: () => void;
}) {
  const action = useAction();
  const [taskId, setTaskId] = useState(() => crypto.randomUUID());
  const data = useLoad(
    useCallback(async () => {
      const [invocations, updates, skills] = await Promise.all([
        runtime.listInvocations(actor, sessionId),
        runtime.getSessionUpdates(actor, sessionId),
        library.listSkills(actor),
      ]);
      const ids = [
        ...new Set([
          ...invocations.map((i) => i.versionId),
          ...updates.flatMap((u) => [u.usedVersionId, u.latestVersionId]),
        ]),
      ];
      const versions = await Promise.all(
        ids.map((id) => library.getVersion(actor, id)),
      );
      return { invocations, updates, skills, versions };
    }, [actor, library, runtime, sessionId]),
  );
  const name = (id: string) =>
    data.data?.skills.find((s) => s.id === id)?.name || "技能";
  const version = (id: string) => {
    const item = data.data?.versions.find((v) => v.id === id);
    return item ? `v${item.number}` : "固定版本";
  };
  async function choose(update: SessionUpdate, mode: "latest" | "pinned") {
    await action.run(async () => {
      await runtime.setPreference(actor, {
        sessionId,
        skillId: update.skillId,
        mode,
        targetVersionId:
          mode === "latest" ? update.latestVersionId : update.usedVersionId,
        expectedRevision: update.preference?.revision ?? 0,
      });
      action.setNotice("已保存。版本选择只影响后续任务。");
      data.reload();
    });
  }
  return (
    <>
      <div className="product-heading">
        <div>
          <h1>任务记录</h1>
          <p>查看本次会话载入的技能及其固定版本。</p>
        </div>
        <button
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              onSession((await runtime.createSession(actor)).id);
              setTaskId(crypto.randomUUID());
              action.setNotice("已开启新会话。");
            })
          }
        >
          新会话
        </button>
      </div>
      <Feedback {...action} />
      {requestedSkill && (
        <section className="load-skill">
          <div>
            <h2>{requestedSkill.name}</h2>
            <p>载入时固定版本，后续更新不会改变这个任务。</p>
          </div>
          <button
            className="primary"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                const task = await runtime.createTask(actor, sessionId, taskId);
                await runtime.resolveSkill(
                  actor,
                  task.taskId,
                  requestedSkill.id,
                );
                await runtime.recordInvocation(
                  actor,
                  task.taskId,
                  requestedSkill.id,
                );
                setTaskId(crypto.randomUUID());
                onRequestedUsed();
                data.reload();
                action.setNotice("技能已载入，版本已固定。");
              })
            }
          >
            载入技能
          </button>
        </section>
      )}
      <LoadState {...data} retry={data.reload}>
        {!!data.data?.updates.length && (
          <section className="task-updates">
            <h2>可用更新</h2>
            {data.data.updates.map((update) => (
              <article key={update.skillId}>
                <div>
                  <strong>{name(update.skillId)}</strong>
                  <p>
                    {version(update.usedVersionId)} →{" "}
                    {version(update.latestVersionId)}
                    {update.preference?.mode === "pinned"
                      ? " · 后续任务保留原版"
                      : ""}
                  </p>
                </div>
                <div className="version-actions">
                  <button
                    disabled={action.busy}
                    onClick={() => void choose(update, "pinned")}
                  >
                    保留原版
                  </button>
                  <button
                    disabled={action.busy}
                    onClick={() => void choose(update, "latest")}
                  >
                    后续使用新版
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
        <div className="task-record-heading">
          <h2>本次会话</h2>
          <button onClick={data.reload}>刷新</button>
        </div>
        {data.data?.invocations.length ? (
          <div className="task-records">
            {[...data.data.invocations].reverse().map((invocation) => (
              <article key={invocation.id}>
                <div>
                  <strong>{name(invocation.skillId)}</strong>
                  <small>
                    {new Date(invocation.createdAt).toLocaleString("zh-CN")}
                  </small>
                </div>
                <span className="status-live">
                  {version(invocation.versionId)} · 已固定
                </span>
                <details>
                  <summary>任务详情</summary>
                  <p>任务 ID：{invocation.taskId}</p>
                  <p>内容校验值：{invocation.checksum}</p>
                </details>
              </article>
            ))}
          </div>
        ) : (
          <div className="product-empty">
            <h2>还没有任务记录</h2>
            <p>从技能详情点击“使用技能”，再载入技能开始体验。</p>
          </div>
        )}
      </LoadState>
      <p className="list-note">
        此处演示技能载入与版本固定，尚未接入真实 Agent 执行。
      </p>
    </>
  );
}
