import { useCallback, useState } from "react";
import type {
  Actor,
  LibraryService,
  RuntimeService,
  Skill,
  SkillVersion,
  FileDiff,
} from "../../contracts";
import { Content, Feedback, LoadState, useAction, useLoad, date } from "./ui";
import { DraftEditor } from "./DraftEditor";
import { Reviews } from "./Reviews";
import { Conversation } from "./Conversation";
import "./styles.css";
export interface AppProps {
  library: LibraryService;
  runtime: RuntimeService;
  actor: Actor;
  demo?: boolean;
  initialSessionId?: string;
}
export function App({
  library,
  runtime,
  actor,
  demo = false,
  initialSessionId,
}: AppProps) {
  const [section, setSection] = useState<
    "library" | "reviews" | "conversation"
  >("library");
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState<Skill>();
  const [editing, setEditing] = useState<{ skill: Skill; source?: string }>();
  const [dirty, setDirty] = useState(false);
  const [sessionId, setSessionId] = useState<string | undefined>(
    initialSessionId,
  );
  const [useSkill, setUseSkill] = useState<Skill>();
  const catalog = useLoad(
    useCallback(
      () => library.listSkills(actor, query),
      [library, actor, query],
    ),
  );
  const action = useAction();
  function leave(next: () => void) {
    if (
      !dirty ||
      window.confirm("还有未保存的内容，确定离开并放弃这些修改吗？")
    ) {
      setDirty(false);
      setEditing(undefined);
      next();
    }
  }
  async function use(skill: Skill) {
    await action.run(async () => {
      const id = sessionId || (await runtime.createSession(actor)).id;
      setSessionId(id);
      setUseSkill(skill);
      setSection("conversation");
    });
  }
  return (
    <div className="app">
      <a className="skip" href="#main">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <a className="brand" href="#main">
          <span className="brand-icon">S</span>
          <span>
            Skill Library<small>团队的经验，持续进化</small>
          </span>
        </a>
        <p className="eyebrow">工作空间</p>
        <nav aria-label="主导航">
          {(
            [
              ["library", "技能库", "▦"],
              ["reviews", "修改评审", "◈"],
              ["conversation", "会话与任务", "◷"],
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              aria-current={section === id ? "page" : undefined}
              onClick={() =>
                leave(() => {
                  setSection(id);
                  if (id === "library") {
                    catalog.reload();
                    setSelected(undefined);
                  }
                })
              }
            >
              <span aria-hidden>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="avatar">
            {actor.userId.slice(0, 1).toUpperCase()}
          </span>
          <div>
            {actor.userId}
            <small>
              {actor.role === "admin"
                ? "团队管理员"
                : actor.role === "viewer"
                  ? "团队成员"
                  : "贡献者"}
            </small>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            团队工作空间{" "}
            <span className="muted">
              {" "}
              /{" "}
              {section === "library"
                ? "技能库"
                : section === "reviews"
                  ? "修改评审"
                  : "会话与任务"}
            </span>
          </span>
          <span className="badge">
            {demo ? "本地演示 · 内存数据" : "服务已注入"}
          </span>
        </header>
        <main id="main" tabIndex={-1}>
          <Feedback {...action} />
          {demo && (
            <p className="demo-note">
              演示环境：刷新即重置，不连接真实身份或
              Agent。可以编辑、评审并体验版本选择。
            </p>
          )}
          {section === "library" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">TEAM KNOWLEDGE</p>
                  <h1>把好方法，变成团队能力</h1>
                  <p>发现、使用和改进 Skill，让每一次任务都有经验可循。</p>
                </div>
                <span className="count">
                  {catalog.data?.length ?? "—"} 个技能
                </span>
              </div>
              <label className="search">
                搜索技能
                <input
                  type="search"
                  disabled={!!editing}
                  placeholder="按名称搜索，例如：研究、周报…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <LoadState {...catalog} retry={catalog.reload}>
                <div className="catalog-layout">
                  <div className="skill-list">
                    {!catalog.data?.length && (
                      <p className="empty">
                        没有找到技能。试试其他名称，或请维护者添加。
                      </p>
                    )}
                    {catalog.data?.map((skill) => (
                      <button
                        className={`skill-card ${selected?.id === skill.id ? "selected" : ""}`}
                        key={skill.id}
                        onClick={() => leave(() => setSelected(skill))}
                      >
                        <span className="card-icon" aria-hidden>
                          ✦
                        </span>
                        <span>
                          <strong>{skill.name}</strong>
                          <span className="description">
                            {skill.description}
                          </span>
                          <span className="card-meta">
                            {skill.currentVersionId ? "已生效" : "待首次评审"} ·{" "}
                            {skill.maintainerIds.length} 位维护者
                          </span>
                        </span>
                        <span aria-hidden>↗</span>
                      </button>
                    ))}
                  </div>
                  <div className="detail">
                    {editing ? (
                      <DraftEditor
                        library={library}
                        actor={actor}
                        skill={editing.skill}
                        source={editing.source}
                        onDirty={setDirty}
                        onSubmitted={() => {
                          setDirty(false);
                          setEditing(undefined);
                          setSection("reviews");
                        }}
                        onClose={() => setEditing(undefined)}
                      />
                    ) : selected ? (
                      <SkillDetail
                        key={selected.id}
                        library={library}
                        actor={actor}
                        skill={selected}
                        onEdit={(source) =>
                          setEditing({ skill: selected, source })
                        }
                        onUse={() => void use(selected)}
                        busy={action.busy}
                      />
                    ) : (
                      <div className="welcome">
                        <span aria-hidden>✧</span>
                        <h2>找到适合下一步的技能</h2>
                        <p>
                          选择左侧技能，查看使用说明、版本历史与团队的改进记录。
                        </p>
                        <div className="rule">
                          独立修改 · 维护者评审 · 任务版本固定
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </LoadState>
            </>
          )}
          {section === "reviews" && (
            <Reviews library={library} actor={actor} onDirty={setDirty} />
          )}
          {section === "conversation" && (
            <Conversation
              library={library}
              runtime={runtime}
              actor={actor}
              sessionId={sessionId}
              onSession={setSessionId}
              requestedSkill={useSkill}
              onRequestedUsed={() => setUseSkill(undefined)}
            />
          )}
        </main>
        <footer>
          让知识可靠地流动{" "}
          <span>新任务默认最新版 · 运行中的任务始终固定原版本</span>
        </footer>
      </div>
    </div>
  );
}
function SkillDetail({
  library,
  actor,
  skill,
  onEdit,
  onUse,
  busy,
}: {
  library: LibraryService;
  actor: Actor;
  skill: Skill;
  onEdit: (source?: string) => void;
  onUse: () => void;
  busy: boolean;
}) {
  const versions = useLoad(
    useCallback(
      () => library.listVersions(actor, skill.id),
      [library, actor, skill.id],
    ),
  );
  const [tab, setTab] = useState<"content" | "history">("content");
  const [viewed, setViewed] = useState<SkillVersion>();
  const [before, setBefore] = useState(""),
    [after, setAfter] = useState(""),
    [diff, setDiff] = useState<FileDiff[]>();
  const action = useAction();
  const current =
    versions.data?.find((v) => v.id === skill.currentVersionId) ??
    versions.data?.[0];
  return (
    <>
      <div className="detail-heading">
        <p className="eyebrow">
          SKILL / {current ? `v${current.number}` : "待生效"}
        </p>
        <h2>{skill.name}</h2>
        <p>{skill.description}</p>
        <div className="actions">
          <button
            className="primary"
            onClick={onUse}
            disabled={busy || !current}
          >
            使用此技能 <span aria-hidden>↗</span>
          </button>
          <button onClick={() => onEdit()} disabled={actor.role === "viewer"}>
            修改
          </button>
        </div>
        <small>
          维护者：{skill.maintainerIds.join("、") || "暂无，请联系管理员配置"}
        </small>
      </div>
      <div className="tabs" role="group" aria-label="技能详情">
        <button
          aria-pressed={tab === "content"}
          onClick={() => setTab("content")}
        >
          使用说明
        </button>
        <button
          aria-pressed={tab === "history"}
          onClick={() => setTab("history")}
        >
          历史版本
        </button>
      </div>
      <LoadState {...versions} retry={versions.reload}>
        {tab === "content" ? (
          current ? (
            <Content files={current.content.files} />
          ) : (
            <p className="empty">
              尚无正式版本，请先提交修改并交由另一位维护者评审。
            </p>
          )
        ) : (
          <>
            <p className="muted">
              历史不可改写。恢复内容会创建新的独立草稿，并再次评审。
            </p>
            <div className="timeline">
              {versions.data?.map((v) => (
                <article key={v.id}>
                  <div>
                    <strong>v{v.number}</strong>
                    <span className="badge">
                      {v.id === current?.id ? "当前版本" : "历史版本"}
                    </span>
                  </div>
                  <p>{v.changeSummary}</p>
                  <small>
                    {date(v.createdAt)} · 作者 {v.authorId} · 评审{" "}
                    {v.reviewerId}
                  </small>
                  <div className="actions">
                    <button onClick={() => setViewed(v)}>
                      查看 v{v.number}
                    </button>
                    <button
                      disabled={actor.role === "viewer"}
                      onClick={() => onEdit(v.id)}
                    >
                      恢复 v{v.number} 为草稿
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <div className="compare-controls">
              <label>
                原版本
                <select
                  value={before}
                  onChange={(e) => {
                    setBefore(e.target.value);
                    setDiff(undefined);
                  }}
                >
                  <option value="">选择版本</option>
                  {versions.data?.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.number}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                目标版本
                <select
                  value={after}
                  onChange={(e) => {
                    setAfter(e.target.value);
                    setDiff(undefined);
                  }}
                >
                  <option value="">选择版本</option>
                  {versions.data?.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.number}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={!before || !after || action.busy}
                onClick={() =>
                  void action.run(async () =>
                    setDiff(
                      await library.compareVersions(actor, before, after),
                    ),
                  )
                }
              >
                查看变化
              </button>
            </div>
            <Feedback {...action} />
            {diff && <Diff files={diff} />}
            {viewed && (
              <section>
                <h3>v{viewed.number} 内容快照</h3>
                <Content files={viewed.content.files} />
              </section>
            )}
          </>
        )}
      </LoadState>
    </>
  );
}
export function Diff({ files }: { files: FileDiff[] }) {
  return (
    <div className="diff">
      {files.length === 0 ? (
        <p>两个版本内容相同。</p>
      ) : (
        files.map((f) => (
          <section key={f.path}>
            <h4>
              {f.path} ·{" "}
              {{ added: "新增", removed: "删除", modified: "修改" }[f.kind]}
            </h4>
            <div className="diff-columns">
              <div>
                <small>原内容</small>
                <pre>{f.before ?? "（不存在）"}</pre>
              </div>
              <div>
                <small>新内容</small>
                <pre>{f.after ?? "（不存在）"}</pre>
              </div>
            </div>
          </section>
        ))
      )}
    </div>
  );
}
