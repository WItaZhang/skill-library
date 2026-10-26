import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Actor,
  Draft,
  LibraryService,
  Skill,
  SkillContent,
} from "../../contracts";
import {
  Content,
  Feedback,
  LoadState,
  key,
  message,
  useAction,
  useLoad,
} from "./ui";
const same = (a: SkillContent, b: SkillContent) =>
  JSON.stringify(a) === JSON.stringify(b);
export function DraftEditor({
  library,
  actor,
  skill,
  source,
  initialDraft,
  onDirty,
  onSubmitted,
  onClose,
}: {
  library: LibraryService;
  actor: Actor;
  skill: Skill;
  source?: string;
  initialDraft?: Draft;
  onDirty: (dirty: boolean) => void;
  onSubmitted: () => void;
  onClose: () => void;
}) {
  const storageKey = `skill-draft:${actor.teamId}:${actor.userId}:${skill.id}:${source || "current"}`;
  const loaded = useLoad(
    useCallback(async () => {
      if (initialDraft) return initialDraft;
      const savedId = sessionStorage.getItem(storageKey);
      if (savedId) {
        try {
          return await library.getDraft(actor, savedId);
        } catch (e) {
          if ((e as { code?: string }).code !== "NOT_FOUND") throw e;
        }
      }
      const created = await library.createDraft(actor, skill.id, source);
      sessionStorage.setItem(storageKey, created.id);
      return created;
    }, [library, actor, skill.id, source, initialDraft, storageKey]),
  );
  const [draft, setDraft] = useState<Draft>(),
    [content, setContent] = useState<SkillContent>({ files: [] });
  const [summary, setSummary] = useState(""),
    [path, setPath] = useState(""),
    [preview, setPreview] = useState(false);
  const [saveError, setSaveError] = useState(""),
    [remote, setRemote] = useState<Draft>(),
    [saved, setSaved] = useState(false);
  const [baseline, setBaseline] = useState<SkillContent>();
  const [saving, setSaving] = useState(false),
    [editCount, setEditCount] = useState(0);
  const action = useAction();
  const requestKey = useRef(key());
  const dirty = !!draft && !same(content, draft.content);
  useEffect(() => {
    if (loaded.data) {
      setDraft(loaded.data);
      setContent(loaded.data.content);
      sessionStorage.setItem(storageKey, loaded.data.id);
    }
  }, [loaded.data]);
  useEffect(() => {
    let alive = true;
    setBaseline(undefined);
    if (draft?.baseVersionId)
      library
        .getVersion(actor, draft.baseVersionId)
        .then((v) => {
          if (alive) setBaseline(v.content);
        })
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [library, actor, draft?.baseVersionId]);
  useEffect(() => {
    onDirty(dirty);
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, onDirty]);
  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      const next = await library.saveDraft(actor, {
        draftId: draft.id,
        expectedRevision: draft.revision,
        content,
      });
      setDraft(next);
      setSaved(true);
      setRemote(undefined);
      requestKey.current = key();
    } catch (e) {
      setSaveError(message(e));
    } finally {
      setSaving(false);
    }
  }
  // A failed save never loops or replaces input. Editing again or explicit retry resumes saving.
  useEffect(() => {
    if (!dirty || !editCount || saving || saveError) return;
    const timer = setTimeout(() => void save(), 1800);
    return () => clearTimeout(timer);
  }, [editCount, dirty, saving, saveError]);
  function change(next: SkillContent) {
    setContent(next);
    setEditCount((n) => n + 1);
    setSaved(false);
  }
  async function submit() {
    if (!draft) return;
    await action.run(async () => {
      await library.submitProposal(actor, {
        draftId: draft.id,
        expectedRevision: draft.revision,
        changeSummary: summary,
        idempotencyKey: requestKey.current,
      });
      sessionStorage.removeItem(storageKey);
      onSubmitted();
    });
  }
  return (
    <section aria-label="独立草稿">
      <div className="detail-heading">
        <p className="eyebrow">你的独立草稿</p>
        <h2>修改 · {skill.name}</h2>
        <p>保存只影响你的草稿。提交后，由另一位维护者评审并生效。</p>
        <button
          onClick={() => {
            if (
              !dirty ||
              window.confirm("还有未保存的内容，确定离开并放弃这些修改吗？")
            ) {
              onDirty(false);
              onClose();
            }
          }}
          disabled={saving || action.busy}
        >
          返回详情
        </button>
      </div>
      <LoadState {...loaded} retry={loaded.reload}>
        {draft && (
          <>
            <div className="save-status" role="status">
              {saving
                ? "正在保存…"
                : dirty
                  ? "有未保存的修改"
                  : saved
                    ? "草稿已保存"
                    : `已载入草稿 · 修订 ${draft.revision}`}
              <button
                disabled={saving || !dirty || action.busy}
                onClick={() => void save()}
              >
                {saveError ? "重试保存" : "保存草稿"}
              </button>
            </div>
            {saveError && (
              <div role="alert" className="error">
                {saveError}
                <p>
                  本地输入未被替换。可读取服务器草稿并对照，再明确选择以最新修订保存。
                </p>
                <button
                  disabled={saving || action.busy}
                  onClick={() =>
                    void action.run(async () =>
                      setRemote(await library.getDraft(actor, draft.id)),
                    )
                  }
                >
                  读取服务器草稿
                </button>
              </div>
            )}
            {remote && (
              <section className="recovery">
                <h3>服务器草稿 · 修订 {remote.revision}</h3>
                <Content files={remote.content.files} />
                <p>确认已合并需要保留的修改后，可继续保存当前编辑区的内容。</p>
                <button
                  onClick={() => {
                    setDraft(remote);
                    setRemote(undefined);
                    setSaveError("");
                    setSaved(false);
                  }}
                >
                  保留我的输入，采用最新修订号
                </button>
              </section>
            )}
            <div className="tabs">
              <button aria-pressed={!preview} onClick={() => setPreview(false)}>
                编辑内容
              </button>
              <button aria-pressed={preview} onClick={() => setPreview(true)}>
                预览内容
              </button>
            </div>
            {preview ? (
              <Content files={content.files} />
            ) : (
              <div className="editor-files">
                {content.files.map((file, i) => (
                  <div key={i}>
                    <div className="file-heading">
                      <label htmlFor={`file-${i}`}>{file.path}</label>
                      {file.path !== "SKILL.md" && (
                        <button
                          onClick={() =>
                            change({
                              files: content.files.filter((_, n) => n !== i),
                            })
                          }
                        >
                          移除 {file.path}
                        </button>
                      )}
                    </div>
                    <textarea
                      id={`file-${i}`}
                      spellCheck={false}
                      value={file.content}
                      disabled={saving || action.busy}
                      onChange={(e) =>
                        change({
                          files: content.files.map((f, n) =>
                            n === i ? { ...f, content: e.target.value } : f,
                          ),
                        })
                      }
                    />
                  </div>
                ))}
                <div className="actions">
                  <label>
                    文本资源路径
                    <input
                      value={path}
                      placeholder="references/guide.md"
                      onChange={(e) => setPath(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={
                      saving ||
                      action.busy ||
                      !path.trim() ||
                      path.includes("..") ||
                      path.startsWith("/") ||
                      path.includes("\\") ||
                      content.files.some((f) => f.path === path.trim())
                    }
                    onClick={() => {
                      change({
                        files: [
                          ...content.files,
                          {
                            path: path.trim(),
                            content: "",
                            mediaType: "text/plain",
                          },
                        ],
                      });
                      setPath("");
                    }}
                  >
                    添加文本资源
                  </button>
                </div>
              </div>
            )}
            <label className="summary">
              修改说明
              <textarea
                value={summary}
                onChange={(e) => {
                  setSummary(e.target.value);
                  requestKey.current = key();
                }}
                placeholder="告诉评审者：改了什么，为什么修改？"
                rows={3}
              />
            </label>
            <Feedback {...action} />
            <p className="muted">
              请先保存，并填写修改说明。内容无变化时不能提交。
            </p>
            {!skill.maintainerIds.some((id) => id !== actor.userId) && (
              <p className="error">
                没有可评审的其他维护者，请联系管理员配置。
              </p>
            )}
            <button
              className="primary"
              disabled={
                dirty ||
                saving ||
                action.busy ||
                !summary.trim() ||
                (!!baseline && same(content, baseline)) ||
                !skill.maintainerIds.some((id) => id !== actor.userId)
              }
              onClick={() => void submit()}
            >
              {action.busy ? "正在提交…" : "提交修改"}
            </button>
          </>
        )}
      </LoadState>
    </section>
  );
}
