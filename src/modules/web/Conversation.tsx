import { useCallback, useState } from "react";
import type {
  Actor,
  FileDiff,
  LibraryService,
  RuntimeService,
  SessionUpdate,
  Skill,
  TaskSnapshot,
} from "../../contracts";
import { Feedback, LoadState, key, useAction, useLoad } from "./ui";
import { Diff } from "./App";
export function Conversation({
  library,
  runtime,
  actor,
  sessionId,
  onSession,
  requestedSkill,
  onRequestedUsed,
}: {
  library: LibraryService;
  runtime: RuntimeService;
  actor: Actor;
  sessionId?: string;
  onSession: (id: string) => void;
  requestedSkill?: Skill;
  onRequestedUsed: () => void;
}) {
  const action = useAction();
  const [task, setTask] = useState<TaskSnapshot>();
  const [diff, setDiff] = useState<{
    skillId: string;
    target: string;
    files: FileDiff[];
  }>();
  const [taskId, setTaskId] = useState(key());
  const state = useLoad(
    useCallback(async () => {
      if (!sessionId)
        return { invocations: [], updates: [], skills: [], versions: [] };
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
    }, [runtime, library, actor, sessionId]),
  );
  const label = (id: string) => {
    const v = state.data?.versions.find((v) => v.id === id);
    return v ? `v${v.number}` : id;
  };
  const name = (id: string) =>
    state.data?.skills.find((s) => s.id === id)?.name || id;
  async function preference(update: SessionUpdate, mode: "latest" | "pinned") {
    await action.run(async () => {
      try {
        await runtime.setPreference(actor, {
          sessionId: update.sessionId,
          skillId: update.skillId,
          mode,
          targetVersionId:
            mode === "latest" ? update.latestVersionId : update.usedVersionId,
          expectedRevision: update.preference?.revision ?? 0,
        });
        action.setNotice(
          "版本选择已保存，只影响本会话后续新任务；当前任务及其重试、恢复不变。",
        );
        setDiff(undefined);
        state.reload();
      } catch (e) {
        if ((e as { code?: string }).code === "STALE_REVISION") {
          setDiff(undefined);
          state.reload();
        }
        throw e;
      }
    });
  }
  async function start() {
    if (!sessionId || !requestedSkill) return;
    await action.run(async () => {
      const snapshot = await runtime.createTask(actor, sessionId, taskId);
      setTask(snapshot);
      await runtime.resolveSkill(actor, snapshot.taskId, requestedSkill.id);
      await runtime.recordInvocation(actor, snapshot.taskId, requestedSkill.id);
      setTaskId(key());
      onRequestedUsed();
      state.reload();
      action.setNotice(
        "技能内容已载入并记录版本；实际 Agent 执行需由宿主平台接入。",
      );
    });
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">WORK WITH CONFIDENCE</p>
          <h1>会话与任务</h1>
          <p>技能持续更新，进行中的工作保持稳定。</p>
        </div>
        <button
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              const session = await runtime.createSession(actor);
              onSession(session.id);
              setTask(undefined);
              setDiff(undefined);
              setTaskId(key());
              action.setNotice("已开启新会话，后续任务默认使用最新版。");
            })
          }
        >
          开启新会话
        </button>
      </div>
      <Feedback {...action} />
      <div className="callout">
        <strong>当前任务永远不切换版本</strong>
        <p>
          版本选择只影响本会话后续新任务；当前任务、子任务、重试与恢复始终使用接受任务时的版本。
        </p>
      </div>
      <details className="defaults">
        <summary>当前采用的会话默认规则（D1–D3，待产品确认）</summary>
        <p>
          D1：选择只影响后续新任务。D2：按会话、按技能保留旧版，直到选择新版或结束会话；新会话默认最新版。D3：不处理提醒时，后续新任务默认最新版。
        </p>
      </details>
      {!sessionId ? (
        <p className="empty">
          还没有会话。点击“开启新会话”，或从技能库选择“使用此技能”。
        </p>
      ) : (
        <>
          <div className="section-heading">
            <h2>当前会话</h2>
            <button
              onClick={() => {
                setDiff(undefined);
                state.reload();
              }}
            >
              刷新会话状态
            </button>
          </div>
          <p className="muted">会话 {sessionId}</p>
          {requestedSkill && (
            <div className="task-request">
              <h3>准备使用：{requestedSkill.name}</h3>
              <p>接受新任务时固定可用版本，然后载入所选技能内容。</p>
              <button
                className="primary"
                disabled={action.busy}
                onClick={() => void start()}
              >
                接受新任务并载入技能
              </button>
            </div>
          )}
          {task && (
            <section className="task">
              <h3>已接受任务 · 版本固定</h3>
              <small>{task.taskId}</small>
              <ul>
                {Object.entries(task.versions).map(([skillId, versionId]) => (
                  <li key={skillId}>
                    {name(skillId)} · {label(versionId)}
                  </li>
                ))}
              </ul>
              <p>当前任务不变，不会因以下选择切换版本。</p>
            </section>
          )}
          <LoadState {...state} retry={state.reload}>
            <section aria-label="技能更新">
              <h2>技能更新</h2>
              {!state.data?.updates.length && (
                <p className="empty compact">
                  暂无需要处理的更新。只为本会话实际调用过的技能展示提醒。
                </p>
              )}
              {state.data?.updates.map((update) => (
                <article className="update-card" key={update.skillId}>
                  <div className="section-heading">
                    <h3>{name(update.skillId)}</h3>
                    <span className="badge">
                      {label(update.usedVersionId)} →{" "}
                      {label(update.latestVersionId)}
                    </span>
                  </div>
                  <p>
                    此技能已有更新。已接受的任务继续使用各自固定版本，本会话曾使用{" "}
                    {label(update.usedVersionId)}。
                  </p>
                  {update.preference?.mode === "pinned" && (
                    <p className="pin">
                      后续任务已保留 {label(update.preference.pinnedVersionId!)}{" "}
                      · 仅本会话
                    </p>
                  )}
                  <div className="actions">
                    <button
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () =>
                          setDiff({
                            skillId: update.skillId,
                            target: update.latestVersionId,
                            files: await library.compareVersions(
                              actor,
                              update.usedVersionId,
                              update.latestVersionId,
                            ),
                          }),
                        )
                      }
                    >
                      查看变化
                    </button>
                    <button
                      disabled={action.busy}
                      onClick={() => void preference(update, "pinned")}
                    >
                      后续任务保留原版
                    </button>
                    <button
                      className="primary"
                      disabled={action.busy}
                      onClick={() => void preference(update, "latest")}
                    >
                      后续任务使用新版 {label(update.latestVersionId)}
                    </button>
                  </div>
                  {diff?.skillId === update.skillId &&
                    diff.target === update.latestVersionId && (
                      <Diff files={diff.files} />
                    )}
                </article>
              ))}
            </section>
            <section>
              <h2>实际调用记录</h2>
              {!state.data?.invocations.length ? (
                <p className="empty compact">此会话尚未调用技能。</p>
              ) : (
                <div className="invocations">
                  {state.data?.invocations.map((i) => (
                    <article key={i.id}>
                      <strong>{name(i.skillId)}</strong>
                      <span className="badge">{label(i.versionId)}</span>
                      <small>任务 {i.taskId}</small>
                      <details>
                        <summary>内容校验值</summary>
                        <code>{i.checksum}</code>
                      </details>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </LoadState>
        </>
      )}
    </>
  );
}
