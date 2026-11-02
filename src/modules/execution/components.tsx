import React, { useEffect, useRef, useState } from "react";
import type {
  ExecutionClient,
  ExecutionRecord,
  ExecutionStatus,
} from "../../contracts/execution.ts";
const statuses: Record<ExecutionStatus, string> = {
  queued: "等待执行",
  claimed: "准备执行",
  running: "执行中",
  succeeded: "已完成",
  failed: "执行失败",
  uncertain: "结果待核实",
  cancelled: "已取消",
};
const errors: Record<string, string> = {
  ACCESS_REVOKED: "团队权限已撤销",
  PROVIDER_AUTH: "执行服务尚未正确配置",
  PROVIDER_RATE_LIMIT: "提供方繁忙，请稍后重试",
  PROVIDER_REJECTED: "提供方拒绝了请求",
  PROVIDER_UNAVAILABLE: "提供方暂时不可用",
  INPUT_TOO_LARGE: "所选技能内容过大",
  OUTPUT_LIMIT: "结果超过长度限制",
  RESOURCE_MISSING: "固定版本资源校验失败",
  RESULT_TOO_LARGE: "执行结果过大",
  CANCELLED: "任务已取消",
  CALL_ABORTED_UNCERTAIN: "调用已中断，远端结果尚不确定",
  NETWORK_UNCERTAIN: "网络中断，远端结果尚不确定",
  LEASE_EXPIRED_UNCERTAIN: "执行中断，远端结果尚不确定",
  LEASE_EXPIRED_BEFORE_DISPATCH: "准备阶段中断，已回收任务",
};
export interface ExecutionPanelProps {
  client: ExecutionClient;
  scopeKey: string;
  skills: { id: string; name: string }[];
  onDirtyChange?: (dirty: boolean) => void;
  initialSkillId?: string;
}
/** The key guarantees synchronous removal of all old identity content, including late promises. */
export function ExecutionPanel(props: ExecutionPanelProps) {
  return <Panel key={props.scopeKey} {...props} />;
}
function Panel({
  client,
  skills,
  onDirtyChange,
  initialSkillId,
}: ExecutionPanelProps) {
  const initial = skills.some((s) => s.id === initialSkillId)
    ? initialSkillId
    : undefined;
  const [records, setRecords] = useState<ExecutionRecord[]>([]),
    [detail, setDetail] = useState<ExecutionRecord | null>(null),
    [creating, setCreating] = useState(!!initial);
  const [prompt, setPrompt] = useState(""),
    [selected, setSelected] = useState<string[]>(initial ? [initial] : []),
    [parent, setParent] = useState<ExecutionRecord | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false);
  const mounted = useRef(true),
    epoch = useRef(0),
    detailId = useRef<string | null>(null),
    key = useRef(crypto.randomUUID());
  const dirty = busy || (creating && (!!prompt || selected.length > 0));
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(
    () => () => {
      dirtyCallback.current?.(false);
    },
    [],
  );
  const refresh = async () => {
    const token = ++epoch.current;
    try {
      const result = await client.list();
      if (mounted.current && token === epoch.current) {
        setRecords(result);
        const id = detailId.current;
        if (id) {
          const found = result.find((r) => r.id === id);
          if (found) setDetail(found);
          else {
            const row = await client.get(id);
            if (
              mounted.current &&
              token === epoch.current &&
              detailId.current === id
            )
              setDetail(row);
          }
        }
      }
    } catch (e) {
      if (mounted.current && token === epoch.current)
        setError(e instanceof Error ? e.message : "无法读取任务");
    }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      mounted.current = false;
      epoch.current++;
      clearInterval(timer);
    };
  }, [client]);
  const act = async (action: () => Promise<ExecutionRecord>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    epoch.current++;
    try {
      const result = await action();
      if (mounted.current) {
        detailId.current = result.id;
        setDetail(result);
        setCreating(false);
        setAck(false);
        key.current = crypto.randomUUID();
        await refresh();
      }
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "操作失败，请重试");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const create = (p: ExecutionRecord | null) => {
    epoch.current++;
    detailId.current = null;
    setDetail(null);
    setParent(p);
    setPrompt("");
    setSelected(p?.skillIds ?? []);
    setCreating(true);
    setError("");
    key.current = crypto.randomUUID();
  };
  const options = parent
    ? Object.keys(parent.snapshot.versions).map((id) => ({
        id,
        name: skills.find((s) => s.id === id)?.name ?? "原任务技能",
      }))
    : skills;
  const changed = () => {
    key.current = crypto.randomUUID();
  };
  return (
    <section aria-label="任务执行">
      <h2>任务执行</h2>
      {error && <p role="alert">{error}</p>}
      {creating ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(() =>
              client.accept({
                prompt,
                skillIds: selected,
                idempotencyKey: key.current,
                ...(parent ? { parentTaskId: parent.taskId } : {}),
              }),
            );
          }}
        >
          <h3>{parent ? "创建子任务" : "新建任务"}</h3>
          {parent && <p>沿用父任务的技能版本。</p>}
          <label>
            任务内容
            <textarea
              required
              maxLength={8000}
              value={prompt}
              disabled={busy}
              onChange={(e) => {
                setPrompt(e.target.value);
                changed();
              }}
            />
          </label>
          <fieldset disabled={busy}>
            <legend>使用技能</legend>
            {options.map((skill) => (
              <label key={skill.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(skill.id)}
                  onChange={(e) => {
                    setSelected((v) =>
                      e.target.checked
                        ? [...v, skill.id]
                        : v.filter((x) => x !== skill.id),
                    );
                    changed();
                  }}
                />
                {skill.name}
              </label>
            ))}
          </fieldset>
          <button disabled={busy || !prompt.trim() || !selected.length}>
            开始执行
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!dirty || window.confirm("放弃尚未提交的任务内容？"))
                setCreating(false);
            }}
          >
            返回列表
          </button>
        </form>
      ) : detail ? (
        <article>
          <button
            disabled={busy}
            onClick={() => {
              epoch.current++;
              detailId.current = null;
              setDetail(null);
            }}
          >
            返回列表
          </button>
          <h3>任务详情</h3>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {detail.prompt}
          </p>
          <p role="status">{statuses[detail.status]}</p>
          <p>
            任务编号：
            <span style={{ overflowWrap: "anywhere" }}>{detail.taskId}</span>
          </p>
          {detail.snapshot.parentTaskId && (
            <p>父任务：{detail.snapshot.parentTaskId}</p>
          )}
          <h4>固定技能版本</h4>
          <ul>
            {detail.skillIds.map((id) => (
              <li key={id} style={{ overflowWrap: "anywhere" }}>
                {skills.find((s) => s.id === id)?.name ?? "技能"}：
                {detail.snapshot.versions[id]}
              </li>
            ))}
          </ul>
          <h4>执行尝试</h4>
          {detail.attempts.length ? (
            <ol>
              {detail.attempts.map((a) => (
                <li key={a.id}>
                  第 {a.number} 次 · {statuses[a.status]} · {a.provider} /{" "}
                  {a.model}
                  {a.errorCode && (
                    <p>
                      {errors[a.errorCode] ?? "执行未完成，请稍后核实或重试"}（
                      {a.errorCode}）
                    </p>
                  )}
                  {a.providerRequestId && (
                    <p style={{ overflowWrap: "anywhere" }}>
                      服务请求编号：{a.providerRequestId}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p>尚未开始调用。</p>
          )}
          {detail.result && (
            <>
              <h4>执行结果</h4>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {detail.result.text}
              </pre>
            </>
          )}
          {["queued", "claimed", "running"].includes(detail.status) && (
            <button
              disabled={busy}
              onClick={() => void act(() => client.cancel(detail.id))}
            >
              取消任务
            </button>
          )}
          {["failed", "uncertain", "cancelled"].includes(detail.status) && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => {
                    setAck(e.target.checked);
                    changed();
                  }}
                />
                我了解上次调用可能已产生费用，重试可能再次计费
              </label>
              <button
                disabled={
                  busy ||
                  (["uncertain", "cancelled"].includes(detail.status) && !ack)
                }
                onClick={() =>
                  void act(() =>
                    client.retry({
                      executionId: detail.id,
                      idempotencyKey: key.current,
                      acknowledgeUncertain: ack,
                    }),
                  )
                }
              >
                使用原版本重试
              </button>
            </>
          )}
          <button disabled={busy} onClick={() => create(detail)}>
            创建子任务
          </button>
        </article>
      ) : (
        <>
          <button onClick={() => create(null)} disabled={!skills.length}>
            新建任务
          </button>
          {!records.length ? (
            <p>暂无执行任务。</p>
          ) : (
            <ul>
              {records.map((row) => (
                <li key={row.id}>
                  <button
                    onClick={() => {
                      epoch.current++;
                      detailId.current = row.id;
                      setDetail(row);
                      setAck(false);
                      key.current = crypto.randomUUID();
                    }}
                  >
                    {row.prompt.slice(0, 60)}
                  </button>{" "}
                  <span>{statuses[row.status]}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
