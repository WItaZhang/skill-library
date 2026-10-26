import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createDemo } from "./demo";
const root = createRoot(document.getElementById("root")!);
root.render(<p role="status">正在准备本地演示…</p>);
createDemo()
  .then(({ library, runtime, actor, sessionId }) =>
    root.render(
      <App
        library={library}
        runtime={runtime}
        actor={actor}
        demo
        initialSessionId={sessionId}
      />,
    ),
  )
  .catch(() =>
    root.render(<p role="alert">演示初始化失败。请刷新页面重试。</p>),
  );
