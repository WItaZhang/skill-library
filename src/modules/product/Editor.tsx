import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Actor,
  Draft,
  LibraryService,
  Skill,
  SkillContent,
  SkillUpdateSource,
  DraftUpdatePreview,
  PublishDraftInput,
} from "../../contracts";
import {
  Content,
  Feedback,
  LoadState,
  key,
  message,
  useAction,
  useLoad,
} from "../web/ui";
import { UpdatePanel } from "../web/UpdatePanel";
const same = (a: SkillContent, b: SkillContent) =>
  JSON.stringify(a) === JSON.stringify(b);
export function ProductEditor({
  library,
  actor,
  skill,
  source,
  updateSource,
  initialDraft,
  onDirty,
  onSubmitted,
  onClose,
}: {
  library: LibraryService;
  actor: Actor;
  skill: Skill;
  source?: string;
  updateSource?: SkillUpdateSource;
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
  const publishRequest = useRef<PublishDraftInput | undefined>(undefined);
  const [syncRecovery, setSyncRecovery] = useState<Draft>();
  const [retryPublish, setRetryPublish] = useState(false);
  const lock = useRef(false);
  const generation = useRef(0);
  const [current, setCurrent] = useState<string | null | undefined>();
  const [checking, setChecking] = useState(true);
  const [update, setUpdate] = useState<DraftUpdatePreview>();
  const [previewGeneration, setPreviewGeneration] = useState(-1);
  const [invalid, setInvalid] = useState(false);
  const [published, setPublished] = useState("");
  const [checkError, setCheckError] = useState("");
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true,
      running = false,
      again = false,
      sequence = -1;
    const reconcile = async () => {
      again = true;
      if (running) return;
      running = true;
      setChecking(true);
      try {
        while (again && alive) {
          again = false;
          const next = await library.getSkill(actor, skill.id);
          if (alive && !again) {
            setCurrent(next.currentVersionId);
            setCheckError("");
          }
        }
      } catch (e) {
        if (alive) setCheckError(message(e));
      } finally {
        running = false;
        if (alive) setChecking(false);
      }
    };
    refresh.current = () => void reconcile();
    void reconcile();
    const unsubscribe = updateSource?.subscribe(actor, {
      onUpdate(event) {
        if (
          event.teamId !== actor.teamId ||
          event.skillId !== skill.id ||
          event.sequence <= sequence
        )
          return;
        sequence = event.sequence;
        void reconcile();
      },
      onReconnect: () => void reconcile(),
      onError: (e) => {
        if (alive) setCheckError(message(e));
      },
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [library, actor, skill.id, updateSource]);
  const outdated =
    !!draft && current !== undefined && draft.baseVersionId !== current;
  const canEdit =
    (actor.role !== "viewer" || skill.maintainerIds.includes(actor.userId)) &&
    draft?.authorId === actor.userId &&
    draft?.teamId === actor.teamId;
  const updateValid =
    !!update &&
    !invalid &&
    !checking &&
    !checkError &&
    update.targetVersionId === current &&
    update.draftRevision === draft?.revision &&
    previewGeneration === editCount;
  useEffect(() => {
    if (
      update &&
      ((!checking && update.targetVersionId !== current) ||
        update.draftRevision !== draft?.revision ||
        previewGeneration !== editCount)
    )
      setInvalid(true);
  }, [
    update,
    current,
    checking,
    draft?.revision,
    previewGeneration,
    editCount,
  ]);
  const unsavedExtras = !!summary.trim() || !!path.trim();
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
    onDirty(
      dirty ||
        unsavedExtras ||
        saving ||
        action.busy ||
        !!update ||
        !!syncRecovery,
    );
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty || unsavedExtras || update || syncRecovery) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [
    dirty,
    unsavedExtras,
    saving,
    action.busy,
    update,
    syncRecovery,
    onDirty,
  ]);
  async function save() {
    if (!draft || lock.current || !canEdit || update || syncRecovery) return;
    lock.current = true;
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
      lock.current = false;
      setSaving(false);
    }
  }
  // A failed save never loops or replaces input. Editing again or explicit retry resumes saving.
  useEffect(() => {
    if (
      !dirty ||
      !editCount ||
      saving ||
      saveError ||
      action.busy ||
      update ||
      syncRecovery ||
      !canEdit
    )
      return;
    const timer = setTimeout(() => void save(), 1800);
    return () => clearTimeout(timer);
  }, [
    editCount,
    dirty,
    saving,
    saveError,
    action.busy,
    update,
    canEdit,
    syncRecovery,
  ]);
  function change(next: SkillContent) {
    if (!canEdit) return;
    generation.current++;
    setContent(next);
    setEditCount((n) => n + 1);
    setSaved(false);
    setInvalid(true);
  }
  async function submit(retry = false) {
    if (
      !draft ||
      lock.current ||
      !canEdit ||
      !!syncRecovery ||
      (!retry && (dirty || outdated || checking || checkError || update))
    )
      return;
    lock.current = true;
    const started = generation.current;
    const input = {
      draftId: draft.id,
      expectedRevision: draft.revision,
      expectedBaseVersionId: draft.baseVersionId,
      changeSummary: summary,
      idempotencyKey: requestKey.current,
    };
    // Keep an exact failed request for retry; never reuse its key with different payload.
    if (
      !retry &&
      (!publishRequest.current ||
        JSON.stringify({ ...publishRequest.current, idempotencyKey: "" }) !==
          JSON.stringify({ ...input, idempotencyKey: "" }))
    )
      publishRequest.current = input;
    const submitted = publishRequest.current!;
    await action.run(async () => {
      try {
        const v = await library.publishDraft(actor, submitted);
        const next = await library.getDraft(actor, draft.id);
        setDraft(next);
        setCurrent(v.id);
        setPublished(`v${v.number} 已自动生效`);
        onSubmitted();
        // An exact retry may complete an earlier publication while the author has
        // already written the next change summary. Only clear the submitted one.
        setSummary((value) => (value === submitted.changeSummary ? "" : value));
        requestKey.current = key();
        publishRequest.current = undefined;
        setRetryPublish(false);
        if (generation.current === started && !retry) setContent(next.content);
      } catch (e) {
        setRetryPublish(true);
        throw e;
      } finally {
        refresh.current();
      }
    });
    lock.current = false;
  }
  async function previewUpdate() {
    if (!draft || lock.current || !canEdit || syncRecovery) return;
    lock.current = true;
    const started = generation.current;
    await action.run(async () => {
      const next = await library.previewDraftUpdate(actor, {
        draftId: draft.id,
        expectedRevision: draft.revision,
        content: structuredClone(content),
      });
      setUpdate(next);
      setPreviewGeneration(started);
      setInvalid(generation.current !== started);
      refresh.current();
    });
    lock.current = false;
  }
  async function applyUpdate(
    resolvedContent: SkillContent,
    idempotencyKey: string,
  ) {
    if (!draft || !update || !updateValid || lock.current || !canEdit) return;
    lock.current = true;
    const started = generation.current;
    await action.run(async () => {
      try {
        const next = await library.applyDraftUpdate(actor, {
          draftId: draft.id,
          expectedRevision: update.draftRevision,
          targetVersionId: update.targetVersionId,
          confirmationToken: update.confirmationToken,
          resolvedContent,
          idempotencyKey,
        });
        setDraft(next);
        if (generation.current === started) setContent(next.content);
        else {
          setSyncRecovery(next);
          action.setNotice(
            "已同步基线；请求期间的新输入仍保留，自动保存和发布已暂停，请对照整合。",
          );
        }
        setUpdate(undefined);
        setSaved(true);
        requestKey.current = key();
      } catch (e) {
        setInvalid(true);
        throw e;
      } finally {
        refresh.current();
      }
    });
    lock.current = false;
  }
  return (
    <section aria-label="独立草稿">
      <div className="detail-heading">
        <p className="eyebrow">你的独立草稿</p>
        <h2>修改 · {skill.name}</h2>
        <p>保存只影响你的草稿。提交通过校验后立即自动生效。</p>
        <button
          onClick={() => {
            if (
              (!dirty && !unsavedExtras && !update && !syncRecovery) ||
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
            {retryPublish && (
              <button
                disabled={saving || action.busy || !canEdit || !!syncRecovery}
                onClick={() => void submit(true)}
              >
                重试原发布请求
              </button>
            )}
            {syncRecovery && (
              <section className="recovery" aria-label="同步期间输入恢复">
                <h3>对照已同步内容与请求期间的新输入</h3>
                <p>
                  下方编辑区保留了你的输入。请把需要保留的新版内容整合进去，确认前不会自动保存或发布。
                </p>
                <Content files={syncRecovery.content.files} />
                <button
                  onClick={() => {
                    setSyncRecovery(undefined);
                    setSaveError("");
                  }}
                >
                  我已对照整合，恢复保存
                </button>
              </section>
            )}
            {published && (
              <p role="status" className="success">
                {published}
              </p>
            )}
            {checkError && (
              <p role="alert">
                {checkError}
                <button onClick={() => refresh.current()}>重新核对版本</button>
              </p>
            )}
            {outdated && (
              <div role="status" className="recovery">
                此技能已有新版本，你的修改已保留。可以继续编辑和保存，确认同步前不能发布。
              </div>
            )}
            {(outdated || update) && (
              <button
                disabled={saving || action.busy || !canEdit || !!syncRecovery}
                onClick={() => void previewUpdate()}
              >
                重新比较并查看更新
              </button>
            )}
            {update && (
              <UpdatePanel
                preview={update}
                valid={updateValid}
                busy={saving || action.busy}
                onApply={applyUpdate}
                onDismiss={() => setUpdate(undefined)}
              />
            )}
            <div className="save-status" role="status">
              {saving
                ? "正在保存…"
                : dirty
                  ? "有未保存的修改"
                  : saved
                    ? "草稿已保存"
                    : `已载入草稿 · 修订 ${draft.revision}`}
              <button
                disabled={
                  saving ||
                  (!dirty && !unsavedExtras && !update && !syncRecovery) ||
                  action.busy ||
                  !!update ||
                  !!syncRecovery ||
                  !canEdit
                }
                onClick={() => void save()}
              >
                {saveError ? "重试保存" : "保存草稿"}
              </button>
            </div>
            {(saveError || action.error) && (
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
                  <div key={file.path}>
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
                      disabled={!canEdit}
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
                placeholder="改了什么，为什么修改？"
                rows={3}
              />
            </label>
            <Feedback {...action} />
            <p className="muted">
              请先保存，并填写修改说明。过期草稿须由你确认同步后才能提交。
            </p>
            <button
              className="primary"
              disabled={
                dirty ||
                saving ||
                action.busy ||
                !summary.trim() ||
                (!!baseline && same(content, baseline)) ||
                !canEdit ||
                outdated ||
                checking ||
                !!checkError ||
                !!update ||
                !!syncRecovery
              }
              onClick={() => void submit()}
            >
              {action.busy ? "正在提交…" : "提交并生效"}
            </button>
          </>
        )}
      </LoadState>
    </section>
  );
}
