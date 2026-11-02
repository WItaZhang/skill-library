import { useCallback, useState } from "react";
import type { Actor, Draft, FileDiff, SkillVersion } from "../../contracts";
import type {
  ProductionLibraryService,
  ProductionSkill,
} from "../../contracts/production";
import { Feedback, LoadState, useAction, useLoad } from "../web/ui";

export function SkillManagement({
  actor,
  library,
  skill,
  onDirty,
  onChanged,
}: {
  actor: Actor;
  library: ProductionLibraryService;
  skill: ProductionSkill;
  onDirty: (v: boolean) => void;
  onChanged: (v: ProductionSkill) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(skill.name),
    [description, setDescription] = useState(skill.description);
  const [revision, setRevision] = useState(skill.revision);
  const [remote, setRemote] = useState<ProductionSkill>();
  const action = useAction();
  const canEdit =
    actor.role !== "viewer" || skill.maintainerIds.includes(actor.userId);
  return (
    <section aria-label="技能管理" className="management">
      {skill.archivedAt && (
        <p role="status">技能已归档；历史保留，恢复后可继续编辑。</p>
      )}
      <div className="actions">
        <button
          disabled={!canEdit || !!skill.archivedAt}
          onClick={() => {
            setEditing(!editing);
          }}
        >
          编辑名称与简介
        </button>
        <button
          disabled={!canEdit || action.busy || editing}
          onClick={() =>
            void action.run(async () => {
              const fresh = await library.getSkill(actor, skill.id);
              if (
                !window.confirm(
                  skill.archivedAt
                    ? "恢复此技能到技能库？"
                    : "归档后新任务不能使用此技能，历史版本仍保留。确定归档？",
                )
              )
                return;
              onChanged(
                await (
                  skill.archivedAt ? library.restoreSkill : library.archiveSkill
                ).call(library, actor, {
                  skillId: skill.id,
                  expectedRevision: fresh.revision,
                }),
              );
            })
          }
        >
          {skill.archivedAt ? "恢复归档技能" : "归档技能"}
        </button>
      </div>
      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const next = await library.updateSkill(actor, {
                skillId: skill.id,
                expectedRevision: revision,
                name: name.trim(),
                description: description.trim(),
              });
              onDirty(false);
              setEditing(false);
              setRemote(undefined);
              setRevision(next.revision);
              onChanged(next);
            });
          }}
        >
          <label>
            技能名称
            <input
              required
              disabled={action.busy}
              maxLength={100}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                onDirty(true);
              }}
            />
          </label>
          <label>
            简介
            <textarea
              disabled={action.busy}
              maxLength={500}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                onDirty(true);
              }}
            />
          </label>
          <button type="submit" disabled={action.busy || !name.trim()}>
            保存名称与简介
          </button>
          <button
            type="button"
            disabled={action.busy}
            onClick={() => {
              if (
                (name !== skill.name || description !== skill.description) &&
                !window.confirm("放弃未保存的名称与简介？")
              )
                return;
              setName(skill.name);
              setDescription(skill.description);
              onDirty(false);
              setEditing(false);
            }}
          >
            取消编辑
          </button>
          {action.error && (
            <button
              type="button"
              onClick={() =>
                void action.run(async () =>
                  setRemote(await library.getSkill(actor, skill.id)),
                )
              }
            >
              读取最新元信息
            </button>
          )}
          {remote && (
            <aside className="recovery">
              <h3>服务器最新信息</h3>
              <p>{remote.name}</p>
              <p>{remote.description}</p>
              <p>上方输入已保留；请对照后再保存。</p>
              <button
                type="button"
                onClick={() => {
                  setRevision(remote.revision);
                  setRemote(undefined);
                }}
              >
                已核对，采用最新修订号
              </button>
            </aside>
          )}
        </form>
      )}
      <Feedback {...action} />
    </section>
  );
}

export function DraftRecovery({
  actor,
  library,
  skill,
  onOpen,
}: {
  actor: Actor;
  library: ProductionLibraryService;
  skill: ProductionSkill;
  onOpen: (source?: string, draft?: Draft) => void;
}) {
  const drafts = useLoad(
    useCallback(
      () => library.listDrafts(actor, skill.id),
      [library, actor, skill.id],
    ),
  );
  return (
    <details className="draft-recovery">
      <summary>我的已保存草稿</summary>
      <LoadState {...drafts} retry={drafts.reload}>
        {!drafts.data?.length && <p>还没有保存的个人草稿。</p>}
        {drafts.data?.map((draft) => (
          <div key={draft.id} className="version-row">
            <span>
              修订 {draft.revision} ·{" "}
              {new Date(draft.updatedAt).toLocaleString("zh-CN")}
              {draft.baseVersionId !== skill.currentVersionId
                ? " · 需要同步新版"
                : ""}
            </span>
            <button
              disabled={!!skill.archivedAt}
              onClick={() => onOpen(undefined, draft)}
            >
              继续此草稿
            </button>
          </div>
        ))}
      </LoadState>
    </details>
  );
}

export function VersionComparison({
  actor,
  library,
  versions,
}: {
  actor: Actor;
  library: ProductionLibraryService;
  versions: SkillVersion[];
}) {
  const [before, setBefore] = useState(""),
    [after, setAfter] = useState("");
  const [diff, setDiff] = useState<FileDiff[]>();
  const action = useAction();
  return (
    <details>
      <summary>比较两个版本</summary>
      <div className="actions">
        <label>
          基础版本
          <select
            disabled={action.busy}
            value={before}
            onChange={(e) => {
              setBefore(e.target.value);
              setDiff(undefined);
            }}
          >
            <option value="">选择版本</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.number}
              </option>
            ))}
          </select>
        </label>
        <label>
          目标版本
          <select
            disabled={action.busy}
            value={after}
            onChange={(e) => {
              setAfter(e.target.value);
              setDiff(undefined);
            }}
          >
            <option value="">选择版本</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.number}
              </option>
            ))}
          </select>
        </label>
        <button
          disabled={!before || !after || before === after || action.busy}
          onClick={() =>
            void action.run(async () =>
              setDiff(await library.compareVersions(actor, before, after)),
            )
          }
        >
          比较版本
        </button>
      </div>
      <Feedback {...action} />
      {diff && (
        <div aria-label="版本差异">
          {!diff.length && <p>两个版本内容相同。</p>}
          {diff.map((d) => (
            <section key={d.path}>
              <h3>
                {d.path} ·{" "}
                {{ added: "新增", removed: "删除", modified: "修改" }[d.kind]}
              </h3>
              <div className="comparison">
                <div>
                  <h4>基础版本</h4>
                  <pre>{d.before ?? "此文件不存在"}</pre>
                </div>
                <div>
                  <h4>目标版本</h4>
                  <pre>{d.after ?? "此文件已删除"}</pre>
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
    </details>
  );
}
