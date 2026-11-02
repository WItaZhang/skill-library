import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Actor,
  Draft,
  LibraryService,
  RuntimeService,
  Skill,
  SkillUpdateSource,
} from "../contracts";
import { DraftEditor } from "../modules/web/DraftEditor";
import { TaskPage } from "./TaskPage";
import {
  Content,
  Feedback,
  LoadState,
  useAction,
  useLoad,
} from "../modules/web/ui";
import "../modules/web/styles.css";
import "./portfolio.css";

type Screen =
  | { kind: "list" }
  | { kind: "detail"; skill: Skill }
  | { kind: "edit"; skill: Skill; source?: string; draft?: Draft }
  | { kind: "create" }
  | { kind: "tasks"; skill?: Skill };
export function Product({
  actor,
  library,
  runtime,
  updateSource,
  initialSessionId,
  simulatePublication,
}: {
  actor: Actor;
  library: LibraryService;
  runtime: RuntimeService;
  updateSource: SkillUpdateSource;
  initialSessionId: string;
  simulatePublication: (id: string) => Promise<void>;
}) {
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [query, setQuery] = useState("");
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [help, setHelp] = useState(false);
  const dirty = useRef(false);
  const title = useRef<HTMLHeadingElement>(null);
  const action = useAction();
  const catalog = useLoad(
    useCallback(() => library.listSkills(actor), [library, actor]),
  );
  function navigate(next: Screen) {
    if (dirty.current && !window.confirm("还有未保存的修改，确定离开吗？"))
      return;
    dirty.current = false;
    setScreen(next);
    action.setNotice("");
    if (next.kind === "list") catalog.reload();
  }
  useEffect(() => {
    title.current?.focus();
    window.scrollTo(0, 0);
  }, [screen.kind]);
  const skills =
    catalog.data?.filter((s) =>
      `${s.name} ${s.description}`.toLowerCase().includes(query.toLowerCase()),
    ) || [];
  const name =
    screen.kind === "tasks"
      ? "任务记录"
      : screen.kind === "create"
        ? "新建技能"
        : screen.kind === "edit"
          ? "编辑技能"
          : screen.kind === "detail"
            ? screen.skill.name
            : "技能库";
  return (
    <div className="product">
      <a className="skip" href="#product-main">
        跳到主要内容
      </a>
      <aside className="product-sidebar">
        <button
          className="product-brand"
          onClick={() => navigate({ kind: "list" })}
        >
          <span className="product-logo" aria-hidden>
            sl
          </span>
          Skill Library
        </button>
        <div className="workspace-label">
          <span className="workspace-dot" />
          个人工作空间
        </div>
        <nav aria-label="主导航">
          <button
            aria-current={screen.kind !== "tasks" ? "page" : undefined}
            onClick={() => navigate({ kind: "list" })}
          >
            <span aria-hidden>▤</span> 技能库{" "}
            <small>{catalog.data?.length ?? "—"}</small>
          </button>
          <button
            aria-current={screen.kind === "tasks" ? "page" : undefined}
            onClick={() => navigate({ kind: "tasks" })}
          >
            <span aria-hidden>◷</span> 任务记录
          </button>
        </nav>
        <div className="product-sidebar-bottom">
          <button
            aria-expanded={help}
            aria-controls="product-help"
            onClick={() => setHelp(!help)}
          >
            使用帮助 <span aria-hidden>?</span>
          </button>
          <div className="product-identity">
            <span className="product-avatar">访</span>
            <div>
              访客工作区<small>独立数据 · 24 小时访问</small>
            </div>
          </div>
        </div>
      </aside>
      <div className="product-body">
        <header className="product-topbar">
          <div>
            工作空间 <span>/</span> {name}
          </div>
          <span className="demo-tag">演示环境</span>
        </header>
        <main id="product-main" className="product-main">
          {help && (
            <section className="help-panel" id="product-help">
              <div>
                <h2>从一个技能开始</h2>
                <p>
                  选择技能查看内容，点击编辑后保存草稿，再提交生效。历史版本可以恢复为新草稿。
                </p>
                <p>
                  要体验多人协作，请在编辑页展开“协作演示”。任务记录展示版本固定机制，尚未接入真实
                  Agent。
                </p>
              </div>
              <button aria-label="关闭使用帮助" onClick={() => setHelp(false)}>
                关闭
              </button>
            </section>
          )}
          {screen.kind !== "list" && screen.kind !== "tasks" && (
            <button
              className="back-link"
              onClick={() =>
                navigate(
                  screen.kind === "edit"
                    ? { kind: "detail", skill: screen.skill }
                    : { kind: "list" },
                )
              }
            >
              ← {screen.kind === "edit" ? "返回技能详情" : "全部技能"}
            </button>
          )}
          {screen.kind === "list" && (
            <>
              <div className="product-heading">
                <div>
                  <h1 ref={title} tabIndex={-1}>
                    技能库
                  </h1>
                  <p>集中管理技能，随时查看和更新版本。</p>
                </div>
                <button
                  className="primary"
                  onClick={() => navigate({ kind: "create" })}
                >
                  ＋ 新建技能
                </button>
              </div>
              <div className="catalog-toolbar">
                <label>
                  <span className="sr-only">搜索技能</span>
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索技能名称或描述…"
                  />
                </label>
                <span>{skills.length} 个技能</span>
              </div>
              <LoadState {...catalog} retry={catalog.reload}>
                {skills.length ? (
                  <div className="product-catalog">
                    <div className="catalog-columns" aria-hidden>
                      <span>技能名称</span>
                      <span>状态</span>
                      <span>操作</span>
                    </div>
                    {skills.map((skill) => (
                      <button
                        className="catalog-row"
                        key={skill.id}
                        onClick={() => navigate({ kind: "detail", skill })}
                      >
                        <span className="catalog-name">
                          <span className="file-icon" aria-hidden>
                            ▤
                          </span>
                          <span>
                            <strong>{skill.name}</strong>
                            <span>{skill.description || "暂无描述"}</span>
                          </span>
                        </span>
                        <span
                          className={
                            skill.currentVersionId
                              ? "status-live"
                              : "status-draft"
                          }
                        >
                          {skill.currentVersionId ? "已发布" : "草稿"}
                        </span>
                        <span className="row-open">
                          查看 <span aria-hidden>→</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="product-empty">
                    <h2>{query ? "没有匹配的技能" : "创建你的第一个技能"}</h2>
                    <p>
                      {query
                        ? "试试其他关键词，或清空搜索。"
                        : "把一套工作方法整理为技能，保存并发布给团队使用。"}
                    </p>
                    <button
                      onClick={() =>
                        query ? setQuery("") : navigate({ kind: "create" })
                      }
                    >
                      {query ? "清空搜索" : "新建技能"}
                    </button>
                  </div>
                )}
              </LoadState>
              <p className="list-note">
                草稿仅自己可见；发布后，其他成员才能使用新版本。
              </p>
            </>
          )}
          {screen.kind === "create" && (
            <CreateSkill
              actor={actor}
              library={library}
              onCreated={(skill, draft) => {
                catalog.reload();
                navigate({ kind: "edit", skill, draft });
              }}
              onCancel={() => navigate({ kind: "list" })}
              onDirty={(v) => {
                dirty.current = v;
              }}
            />
          )}
          {screen.kind === "detail" && (
            <Detail
              key={screen.skill.id}
              actor={actor}
              library={library}
              skill={screen.skill}
              onEdit={(source) =>
                navigate({ kind: "edit", skill: screen.skill, source })
              }
              onUse={() => navigate({ kind: "tasks", skill: screen.skill })}
            />
          )}
          {screen.kind === "edit" && (
            <>
              <div className="editing-context">
                <span>{screen.skill.name}</span>
                <details>
                  <summary>协作演示</summary>
                  <p>模拟另一位作者发布新版，检查你的草稿如何处理更新。</p>
                  <button
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await simulatePublication(screen.skill.id);
                        action.setNotice(
                          "同事已发布新版，请查看编辑器中的更新提示。",
                        );
                      })
                    }
                  >
                    让同事发布新版
                  </button>
                </details>
              </div>
              <Feedback {...action} />
              <div className="editor-surface">
                <DraftEditor
                  key={`${screen.skill.id}:${screen.source || "current"}`}
                  library={library}
                  actor={actor}
                  skill={screen.skill}
                  source={screen.source}
                  initialDraft={screen.draft}
                  updateSource={updateSource}
                  onDirty={(v) => {
                    dirty.current = v;
                  }}
                  onSubmitted={() => catalog.reload()}
                  onClose={() =>
                    navigate({ kind: "detail", skill: screen.skill })
                  }
                />
              </div>
            </>
          )}
          {screen.kind === "tasks" && (
            <div className="task-surface">
              <TaskPage
                library={library}
                runtime={runtime}
                actor={actor}
                sessionId={sessionId}
                onSession={(id) => {
                  setSessionId(id);
                  sessionStorage.setItem(
                    `skill-library:session:${actor.teamId}`,
                    id,
                  );
                }}
                requestedSkill={screen.skill}
                onRequestedUsed={() => setScreen({ kind: "tasks" })}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
function CreateSkill({
  actor,
  library,
  onCreated,
  onCancel,
  onDirty,
}: {
  actor: Actor;
  library: LibraryService;
  onCreated: (skill: Skill, draft: Draft) => void;
  onCancel: () => void;
  onDirty: (v: boolean) => void;
}) {
  const [name, setName] = useState(""),
    [description, setDescription] = useState("");
  const action = useAction();
  return (
    <section className="create-surface">
      <h1>新建技能</h1>
      <p>先给技能起个名字，接下来编写具体内容。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const result = await library.createSkill(actor, {
              name: name.trim(),
              description: description.trim(),
              maintainerIds: [],
              content: {
                files: [
                  {
                    path: "SKILL.md",
                    mediaType: "text/markdown",
                    content: `# ${name.trim()}\n\n在这里描述技能的使用场景与操作步骤。\n`,
                  },
                ],
              },
            });
            onDirty(false);
            sessionStorage.setItem(
              `skill-draft:${actor.teamId}:${actor.userId}:${result.skill.id}:current`,
              result.draft.id,
            );
            onCreated(result.skill, result.draft);
          });
        }}
      >
        <label>
          技能名称
          <input
            autoFocus
            required
            maxLength={100}
            value={name}
            placeholder="例如：客户反馈分析"
            onChange={(e) => {
              setName(e.target.value);
              onDirty(true);
            }}
          />
        </label>
        <label>
          简介 <span className="optional">选填</span>
          <textarea
            rows={3}
            maxLength={500}
            value={description}
            placeholder="这个技能帮助团队完成什么工作？"
            onChange={(e) => {
              setDescription(e.target.value);
              onDirty(true);
            }}
          />
        </label>
        <Feedback {...action} />
        <div className="actions">
          <button
            className="primary"
            disabled={action.busy || !name.trim()}
            type="submit"
          >
            创建并编辑
          </button>
          <button disabled={action.busy} type="button" onClick={onCancel}>
            取消
          </button>
        </div>
      </form>
    </section>
  );
}
function Detail({
  actor,
  library,
  skill,
  onEdit,
  onUse,
}: {
  actor: Actor;
  library: LibraryService;
  skill: Skill;
  onEdit: (source?: string) => void;
  onUse: () => void;
}) {
  const versions = useLoad(
    useCallback(
      () => library.listVersions(actor, skill.id),
      [library, actor, skill.id],
    ),
  );
  const [tab, setTab] = useState<"content" | "history">("content");
  const [viewed, setViewed] = useState<string>();
  const sorted = [...(versions.data || [])].sort((a, b) => b.number - a.number);
  const latest = sorted[0],
    shown = sorted.find((v) => v.id === viewed) || latest;
  const canEdit =
    actor.role !== "viewer" || skill.maintainerIds.includes(actor.userId);
  return (
    <>
      <div className="product-heading">
        <div>
          <div className="detail-status">
            <span className={latest ? "status-live" : "status-draft"}>
              {latest ? `已发布 · v${latest.number}` : "尚未发布"}
            </span>
          </div>
          <h1>{skill.name}</h1>
          <p>{skill.description || "尚未填写简介"}</p>
        </div>
        <div className="detail-actions">
          <button disabled={!latest} onClick={onUse}>
            使用技能
          </button>
          <button
            className="primary"
            disabled={!canEdit}
            onClick={() => onEdit()}
          >
            编辑技能
          </button>
        </div>
      </div>
      <div className="product-tabs" role="group" aria-label="技能详情">
        <button
          aria-pressed={tab === "content"}
          onClick={() => {
            setTab("content");
            setViewed(undefined);
          }}
        >
          技能内容
        </button>
        <button
          aria-pressed={tab === "history"}
          onClick={() => setTab("history")}
        >
          版本历史 <span>{sorted.length}</span>
        </button>
      </div>
      <LoadState {...versions} retry={versions.reload}>
        {tab === "content" ? (
          <section className="content-surface">
            {shown ? (
              <>
                {viewed && (
                  <p className="history-view">
                    正在查看历史版本 v{shown.number}{" "}
                    <button onClick={() => setViewed(undefined)}>
                      返回最新版
                    </button>
                  </p>
                )}
                <Content files={shown.content.files} />
              </>
            ) : (
              <div className="product-empty">
                <h2>技能尚未发布</h2>
                <p>编辑内容后提交生效，团队即可使用。</p>
                <button disabled={!canEdit} onClick={() => onEdit()}>
                  开始编辑
                </button>
              </div>
            )}
          </section>
        ) : (
          <section className="history-surface">
            <p>每次发布都保留独立快照。恢复历史内容会创建新草稿。</p>
            {sorted.map((version) => (
              <article className="version-row" key={version.id}>
                <div>
                  <strong>v{version.number}</strong>
                  {version.id === latest?.id && (
                    <span className="status-live">当前版本</span>
                  )}
                  <p>{version.changeSummary}</p>
                  <small>
                    {version.authorId} ·{" "}
                    {new Date(version.createdAt).toLocaleString("zh-CN")}
                  </small>
                </div>
                <div className="version-actions">
                  <button
                    onClick={() => {
                      setViewed(version.id);
                      setTab("content");
                    }}
                  >
                    查看内容
                  </button>
                  <button
                    disabled={!canEdit}
                    onClick={() => onEdit(version.id)}
                  >
                    恢复为草稿
                  </button>
                </div>
              </article>
            ))}
            {!sorted.length && (
              <p className="product-empty">发布后将在这里显示版本记录。</p>
            )}
          </section>
        )}
      </LoadState>
    </>
  );
}
