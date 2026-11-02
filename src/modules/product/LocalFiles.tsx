import { useEffect, useState } from "react";
import type { Actor } from "../../contracts";
import type { ProductionLibraryService } from "../../contracts/production";

type Source = {
  directory: string;
  name: string;
  files?: number;
  skillId?: string;
  checksum?: string;
  status: string;
  error?: string;
};
export function LocalFiles({
  actor,
  csrfToken,
  library,
  onChanged,
}: {
  actor: Actor;
  csrfToken: string;
  library: ProductionLibraryService;
  onChanged: () => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function call(method: string, input = {}) {
    const response = await fetch(`/api/local/${method}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
        "X-Team-Id": actor.teamId,
      },
      body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? "连接失败");
    return result.data;
  }
  const reload = async () => {
    setSources(await call("scan"));
  };
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void call("scan")
      .then((rows) => {
        if (active) setSources(rows);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [actor.teamId, actor.userId, csrfToken]);
  const labels: Record<string, string> = {
    new: "尚未导入",
    synced: "与本机一致",
    external: "本机有外部修改",
    published: "有新版可写回",
    error: "需要检查",
  };
  return (
    <section className="local-files">
      <div className="product-heading">
        <div>
          <h1>本机目录</h1>
          <p>导入已有技能，在技能库中编辑和发布，再将新版写回原目录。</p>
        </div>
        <button disabled={busy} onClick={() => void run(async () => {})}>
          刷新状态
        </button>
      </div>
      <p>写回前检查外部修改，并保留完整备份。草稿不会改变本机文件。</p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {sources.map((source) => (
        <article className="local-source" key={source.directory}>
          <div>
            <strong>{source.name}</strong>
            <p>{source.directory}</p>
            <small>
              {labels[source.status]}
              {source.files ? ` · ${source.files} 个文件` : ""}
            </small>
            {source.error && <p role="alert">{source.error}</p>}
          </div>
          {source.status === "new" && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call("import", { directory: source.directory });
                  setNotice(`已导入 ${source.name}，可在技能库查看 v1。`);
                })
              }
            >
              导入技能
            </button>
          )}
          {source.status === "published" && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const skill = await library.getSkill(actor, source.skillId!);
                  const version = await library.getVersion(
                    actor,
                    skill.currentVersionId!,
                  );
                  if (
                    !window.confirm(
                      `将 ${source.name} 的 v${version.number} 写回本机目录？写回前会保存备份。`,
                    )
                  )
                    return;
                  const result = await call("sync", {
                    skillId: skill.id,
                    versionId: version.id,
                  });
                  setNotice(
                    `已写回 v${result.version}。${result.backup ? `备份：${result.backup}` : ""}`,
                  );
                })
              }
            >
              写回已发布版本
            </button>
          )}
          {source.status === "external" && (
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call("pull", {
                    skillId: source.skillId,
                    checksum: source.checksum,
                  });
                  setNotice(
                    "已保存为独立草稿。请在技能详情的草稿列表打开；若两边都有修改，编辑器会要求处理差异。",
                  );
                })
              }
            >
              读取为新草稿
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
