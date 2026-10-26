import { useCallback, useEffect, useRef, useState } from "react";
import { DomainError } from "../../contracts";
import type {
  Actor,
  Draft,
  LibraryService,
  MergePreview,
  Proposal,
  Skill,
} from "../../contracts";
import {
  Content,
  Feedback,
  LoadState,
  date,
  key,
  useAction,
  useLoad,
} from "./ui";
import { DraftEditor } from "./DraftEditor";
const statuses = {
  pending: "待评审",
  changes_requested: "需修改",
  conflicted: "存在冲突",
  rejected: "已拒绝",
  withdrawn: "已撤回",
  merged: "已生效",
};
export function Reviews({
  library,
  actor,
  onDirty,
}: {
  library: LibraryService;
  actor: Actor;
  onDirty: (dirty: boolean) => void;
}) {
  const list = useLoad(
    useCallback(() => library.listProposals(actor), [library, actor]),
  );
  const [selected, setSelected] = useState<Proposal>();
  const [dirty, setDirty] = useState(false);
  const handleDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirty(value);
    },
    [onDirty],
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">REVIEW TOGETHER</p>
          <h1>让每一次改进，都值得信任</h1>
          <p>评审固定的修改内容，确认后立即生效。</p>
        </div>
        <button onClick={list.reload} disabled={dirty}>
          刷新评审
        </button>
      </div>
      <LoadState {...list} retry={list.reload}>
        {!list.data?.length ? (
          <p className="empty">
            暂时没有修改提案。到技能库创建你的第一份草稿。
          </p>
        ) : selected ? (
          <ProposalDetail
            key={selected.id}
            proposalId={selected.id}
            library={library}
            actor={actor}
            onDirty={handleDirty}
            onBack={() => {
              setSelected(undefined);
              list.reload();
            }}
          />
        ) : (
          <div className="proposal-list">
            {list.data?.map((p) => (
              <button
                className="proposal-card"
                key={p.id}
                onClick={() => setSelected(p)}
              >
                <span className="badge">{statuses[p.status]}</span>
                <strong>{p.changeSummary}</strong>
                <small>
                  作者 {p.authorId} · {date(p.createdAt)} · 修订 {p.revision}
                </small>
                <span>查看修改 →</span>
              </button>
            ))}
          </div>
        )}
      </LoadState>
    </>
  );
}
function ProposalDetail({
  proposalId,
  library,
  actor,
  onBack,
  onDirty,
}: {
  proposalId: string;
  library: LibraryService;
  actor: Actor;
  onBack: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const loaded = useLoad(
    useCallback(async () => {
      const proposal = await library.getProposal(actor, proposalId);
      const [skill, base] = await Promise.all([
        library.getSkill(actor, proposal.skillId),
        proposal.baseVersionId
          ? library.getVersion(actor, proposal.baseVersionId)
          : Promise.resolve(null),
      ]);
      return { proposal, skill, base };
    }, [library, actor, proposalId]),
  );
  const [preview, setPreview] = useState<MergePreview>(),
    [confirmed, setConfirmed] = useState(false),
    [comment, setComment] = useState("");
  const [resolved, setResolved] = useState<Record<string, string | null>>({});
  const [editing, setEditing] = useState<{ draft: Draft; skill: Skill }>();
  const action = useAction();
  const mergeKey = useRef(key());
  useEffect(() => {
    if (!editing) onDirty(Object.keys(resolved).length > 0);
  }, [resolved, editing, onDirty]);
  const p = loaded.data?.proposal,
    skill = loaded.data?.skill;
  const own = p?.authorId === actor.userId;
  const canReview =
    !!skill?.maintainerIds.includes(actor.userId) &&
    !own &&
    p?.status === "pending";
  const active =
    !!p && ["pending", "changes_requested", "conflicted"].includes(p.status);
  async function compare() {
    if (!p) return;
    setPreview(undefined);
    setConfirmed(false);
    await action.run(async () => {
      setPreview(await library.previewMerge(actor, p.id));
      mergeKey.current = key();
    });
  }
  async function resolve() {
    if (!p || !skill || !preview) return;
    await action.run(async () => {
      const fresh = await library.createDraft(actor, p.skillId);
      if (fresh.baseVersionId !== preview.currentVersionId)
        throw new DomainError(
          "STALE_REVISION",
          "最新内容再次变化，请重新比较；解决结果仍保留。",
        );
      // Start from the merge candidate: preserve non-conflicting edits and resolve every conflict explicitly.
      const files = preview.content.files.filter(
        (f) => !preview.conflicts.some((c) => c.path === f.path),
      );
      for (const conflict of preview.conflicts) {
        const result = resolved[conflict.path];
        if (result === null) continue;
        files.push({
          path: conflict.path,
          content: result,
          mediaType:
            p.content.files.find((f) => f.path === conflict.path)?.mediaType ||
            "text/plain",
        });
      }
      const draft = await library.saveDraft(actor, {
        draftId: fresh.id,
        expectedRevision: fresh.revision,
        content: { files },
      });
      await library.withdrawProposal(actor, p.id, p.revision);
      onDirty(false);
      setEditing({ draft, skill });
    });
  }
  if (editing)
    return (
      <DraftEditor
        library={library}
        actor={actor}
        skill={editing.skill}
        initialDraft={editing.draft}
        onDirty={onDirty}
        onSubmitted={onBack}
        onClose={onBack}
      />
    );
  return (
    <section className="review-detail">
      <button
        onClick={() => {
          if (
            !Object.keys(resolved).length ||
            window.confirm("还有未提交的冲突解决结果，确定离开吗？")
          ) {
            onDirty(false);
            onBack();
          }
        }}
      >
        ← 返回提案列表
      </button>
      <LoadState {...loaded} retry={loaded.reload}>
        {p && (
          <>
            <div className="detail-heading">
              <span className="badge">{statuses[p.status]}</span>
              <h2>{p.changeSummary}</h2>
              <p>
                {skill?.name} · 作者 {p.authorId} · 修订 {p.revision}
              </p>
              {p.reviewComment && <p>评审意见：{p.reviewComment}</p>}
            </div>
            {own && (
              <p className="callout">
                这是你的修改。作者不能评审自己的提案，请交由其他维护者处理。
              </p>
            )}
            {!skill?.maintainerIds.includes(actor.userId) && !own && (
              <p className="callout">仅此技能的非作者维护者可以评审。</p>
            )}
            {p.status !== "pending" && active && (
              <p className="callout">
                此提案需要作者调整并重新提交后，才能再次评审。
              </p>
            )}
            <details>
              <summary>查看基础内容与提交内容</summary>
              <div className="diff-columns">
                <section>
                  <h3>基础内容</h3>
                  {loaded.data?.base ? (
                    <Content files={loaded.data.base.content.files} />
                  ) : (
                    <p>首次发布，无基础内容。</p>
                  )}
                </section>
                <section>
                  <h3>提交内容</h3>
                  <Content files={p.content.files} />
                </section>
              </div>
            </details>
            <Feedback {...action} />
            {active && (
              <>
                <div className="actions">
                  <button disabled={action.busy} onClick={() => void compare()}>
                    重新比较并预览合并
                  </button>
                  {own && (
                    <button
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await library.withdrawProposal(
                            actor,
                            p.id,
                            p.revision,
                          );
                          onBack();
                        })
                      }
                    >
                      撤回修改
                    </button>
                  )}
                </div>
                {preview && (
                  <section className="merge-preview">
                    <h3>
                      {preview.conflicts.length
                        ? "解决修改冲突"
                        : "确认最终生效内容"}
                    </h3>
                    {preview.conflicts.length ? (
                      <>
                        <p>
                          先对照三份内容，再填写解决结果。原提案会撤回，新草稿必须重新提交评审。
                        </p>
                        {preview.conflicts.map((c) => (
                          <section className="conflict" key={c.path}>
                            <h4>{c.path}</h4>
                            <div className="three-columns">
                              {[
                                ["基础内容", c.base],
                                ["最新内容", c.current],
                                ["我的修改", c.proposed],
                              ].map(([label, value]) => (
                                <div key={label}>
                                  <strong>{label}</strong>
                                  <pre>{value ?? "（不存在）"}</pre>
                                </div>
                              ))}
                            </div>
                            <label>
                              解决结果 · {c.path}
                              <textarea
                                disabled={!own}
                                value={resolved[c.path] ?? ""}
                                onChange={(e) =>
                                  setResolved({
                                    ...resolved,
                                    [c.path]: e.target.value,
                                  })
                                }
                              />
                            </label>
                            {resolved[c.path] === null && (
                              <p className="callout">解决结果：删除此资源</p>
                            )}
                            <div className="actions">
                              <button
                                disabled={!own || c.path === "SKILL.md"}
                                onClick={() =>
                                  setResolved({ ...resolved, [c.path]: null })
                                }
                              >
                                删除此资源
                              </button>
                              <button
                                disabled={!own}
                                onClick={() =>
                                  setResolved({
                                    ...resolved,
                                    [c.path]: c.current ?? null,
                                  })
                                }
                              >
                                采用最新内容
                              </button>
                              <button
                                disabled={!own}
                                onClick={() =>
                                  setResolved({
                                    ...resolved,
                                    [c.path]: c.proposed ?? null,
                                  })
                                }
                              >
                                采用我的修改
                              </button>
                            </div>
                          </section>
                        ))}
                        <button
                          className="primary"
                          disabled={
                            !own ||
                            action.busy ||
                            preview.conflicts.some(
                              (c) => resolved[c.path] === undefined,
                            )
                          }
                          onClick={() => void resolve()}
                        >
                          以解决结果创建新草稿
                        </button>
                        {!own && <p>请由作者解决冲突并重新提交。</p>}
                      </>
                    ) : (
                      <>
                        <Content files={preview.content.files} />
                        {own && (
                          <>
                            <p>
                              继续调整会撤回这份提案，创建基于最新内容的新草稿，再次提交后重新评审。
                            </p>
                            <button
                              disabled={action.busy}
                              onClick={() => void resolve()}
                            >
                              继续修改并重新提交
                            </button>
                          </>
                        )}
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={confirmed}
                            onChange={(e) => setConfirmed(e.target.checked)}
                          />
                          我已检查最终内容，确认本次生效
                        </label>
                      </>
                    )}
                  </section>
                )}
                <div className="review-actions">
                  <label>
                    评审意见
                    <textarea
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                      placeholder="请说明需要调整的内容或拒绝原因"
                    />
                  </label>
                  <div className="actions">
                    <button
                      disabled={!canReview || !comment.trim() || action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await library.reviewProposal(actor, {
                            proposalId: p.id,
                            expectedRevision: p.revision,
                            action: "request_changes",
                            comment,
                          });
                          onBack();
                        })
                      }
                    >
                      请求修改
                    </button>
                    <button
                      disabled={!canReview || !comment.trim() || action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await library.reviewProposal(actor, {
                            proposalId: p.id,
                            expectedRevision: p.revision,
                            action: "reject",
                            comment,
                          });
                          onBack();
                        })
                      }
                    >
                      拒绝修改
                    </button>
                    <button
                      className="primary"
                      disabled={
                        !canReview ||
                        !confirmed ||
                        !preview ||
                        !!preview.conflicts.length ||
                        action.busy
                      }
                      onClick={() =>
                        void action.run(async () => {
                          if (!preview) return;
                          try {
                            await library.mergeProposal(actor, {
                              proposalId: p.id,
                              expectedRevision: preview.proposalRevision,
                              expectedCurrentVersionId:
                                preview.currentVersionId,
                              confirmationToken: preview.confirmationToken,
                              idempotencyKey: mergeKey.current,
                            });
                            onBack();
                          } catch (e) {
                            setConfirmed(false);
                            setPreview(undefined);
                            throw e;
                          }
                        })
                      }
                    >
                      批准并生效
                    </button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </LoadState>
    </section>
  );
}
