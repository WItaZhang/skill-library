import { useEffect, useState } from "react";
import type { DraftUpdatePreview, SkillContent } from "../../contracts";
import { Content, key } from "./ui";
import { Diff } from "./App";

type Choice = { text: string; deleted: boolean; checked: boolean };
export function UpdatePanel({
  preview,
  valid,
  busy,
  onApply,
  onDismiss,
}: {
  preview: DraftUpdatePreview;
  valid: boolean;
  busy: boolean;
  onApply: (content: SkillContent, requestKey: string) => Promise<void>;
  onDismiss: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [requestKey, setRequestKey] = useState(key);
  useEffect(() => {
    setConfirmed(false);
    setRequestKey(key());
    // Preserve manual text/deletion choices, but require rechecking against the new target.
    setChoices((old) =>
      Object.fromEntries(
        Object.entries(old).map(([path, value]) => [
          path,
          { ...value, checked: false },
        ]),
      ),
    );
  }, [preview]);
  useEffect(() => {
    if (!valid) setConfirmed(false);
  }, [valid]);
  const conflicts = [...preview.conflicts];
  for (const path of Object.keys(choices))
    if (!conflicts.some((c) => c.path === path))
      conflicts.push({
        path,
        base: preview.baseContent.files.find((f) => f.path === path)?.content,
        current: preview.latestContent.files.find((f) => f.path === path)
          ?.content,
        proposed: preview.localContent.files.find((f) => f.path === path)
          ?.content,
      });
  const resolved: SkillContent = {
    files: preview.candidateContent.files.filter(
      (f) => !conflicts.some((c) => c.path === f.path),
    ),
  };
  for (const conflict of conflicts) {
    const choice = choices[conflict.path];
    if (choice && !choice.deleted)
      resolved.files.push({
        path: conflict.path,
        content: choice.text,
        mediaType:
          [
            ...preview.localContent.files,
            ...preview.latestContent.files,
            ...preview.baseContent.files,
          ].find((f) => f.path === conflict.path)?.mediaType || "text/plain",
      });
  }
  function choose(path: string, text: string | undefined) {
    setChoices((old) => ({
      ...old,
      [path]: { text: text ?? "", deleted: text === undefined, checked: true },
    }));
    setConfirmed(false);
    setRequestKey(key());
  }
  return (
    <section className="recovery" aria-label="作者更新处理">
      <h3>检查新版与我的修改</h3>
      {!valid && (
        <p role="alert">
          预览已失效或正在核对；输入与处理选择已保留，请重新比较并检查。
        </p>
      )}
      <div className="diff-columns">
        <section>
          <h4>基础内容</h4>
          <Content files={preview.baseContent.files} />
        </section>
        <section>
          <h4>我的修改（含未保存输入）</h4>
          <Content files={preview.localContent.files} />
        </section>
        <section>
          <h4>团队最新版</h4>
          <Content files={preview.latestContent.files} />
        </section>
      </div>
      <h4>我的差异</h4>
      <Diff files={preview.localDiff} />
      <h4>团队差异</h4>
      <Diff files={preview.remoteDiff} />
      {!preview.conflicts.length && (
        <p>没有重叠修改，仍须检查候选内容并明确确认。</p>
      )}
      {conflicts.map((c) => (
        <fieldset key={c.path} disabled={busy}>
          <legend>处理重叠修改 · {c.path}</legend>
          <button onClick={() => choose(c.path, c.current)}>
            采用新版 · {c.path}
          </button>
          <button onClick={() => choose(c.path, c.proposed)}>
            保留我的版本 · {c.path}
          </button>
          <button onClick={() => choose(c.path, undefined)}>
            明确删除 · {c.path}
          </button>
          <label>
            手动结果 · {c.path}
            <textarea
              value={choices[c.path]?.text ?? ""}
              onChange={(e) => choose(c.path, e.target.value)}
            />
          </label>
          {choices[c.path]?.deleted && (
            <p>解决结果：删除此资源（不是空文件）</p>
          )}
          {choices[c.path] && (
            <label>
              <input
                type="checkbox"
                checked={choices[c.path].checked}
                onChange={(e) => {
                  setChoices((old) => ({
                    ...old,
                    [c.path]: { ...old[c.path], checked: e.target.checked },
                  }));
                  setConfirmed(false);
                }}
              />
              已重新检查此选择 · {c.path}
            </label>
          )}
        </fieldset>
      ))}
      <h4>合并候选</h4>
      <Content files={resolved.files} />
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={!valid || busy}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        我已检查最终内容，确认同步草稿基线
      </label>
      <div className="actions">
        <button
          disabled={
            !valid ||
            busy ||
            !confirmed ||
            conflicts.some((c) => !choices[c.path]?.checked)
          }
          onClick={() => void onApply(resolved, requestKey)}
        >
          确认同步草稿
        </button>
        <button disabled={busy} onClick={onDismiss}>
          返回继续编辑
        </button>
      </div>
      <p>同步只保存草稿，不发布。处理期间自动保存暂停。</p>
    </section>
  );
}
