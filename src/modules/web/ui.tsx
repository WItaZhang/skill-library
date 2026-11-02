import { useCallback, useEffect, useState, type ReactNode } from "react";
export function message(error: unknown) {
  const e = error as { code?: string; message?: string };
  const hints: Record<string, string> = {
    FORBIDDEN: "权限不足，请联系维护者。",
    STALE_REVISION: "内容或版本已更新，请刷新后重新确认；你的输入仍保留。",
    CONFLICT: "存在修改冲突，请解决后重新提交。",
    VALIDATION: "请检查内容与必填项。",
    RESOURCE_MISSING: "所需资源缺失，请联系维护者后重试。",
    UNAVAILABLE: "服务暂时不可用，请重试。",
  };
  return e?.code
    ? `${e.message || "操作失败"} ${hints[e.code] || ""}`
    : "操作失败，请检查连接后重试。";
}
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    load()
      .then((v) => {
        if (alive) setData(v);
      })
      .catch((e) => {
        if (alive) setError(message(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [load, tick]);
  return { data, error, loading, reload };
}
export function LoadState({
  loading,
  error,
  retry,
  children,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
  children: ReactNode;
}) {
  if (loading)
    return (
      <p role="status" className="empty">
        正在加载…
      </p>
    );
  if (error)
    return (
      <div role="alert" className="error">
        {error} <button onClick={retry}>重试</button>
      </div>
    );
  return <>{children}</>;
}
export function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, notice, setNotice, run };
}
export function Feedback({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="success">
          {notice}
        </p>
      )}
    </>
  );
}
export function Content({
  files,
}: {
  files: { path: string; content: string }[];
}) {
  return (
    <div className="files">
      {files.map((f) => (
        <section key={f.path}>
          <h4>{f.path}</h4>
          <pre>{f.content}</pre>
        </section>
      ))}
    </div>
  );
}
export const key = () => crypto.randomUUID();
export const date = (value: string) => new Date(value).toLocaleString("zh-CN");
