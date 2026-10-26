# Skill Library Web

独立的中文 React / TypeScript / Vite 应用。只依赖 `../../contracts`，不导入管理服务或运行时实现，也不定义 HTTP 路由。

## 启动和验证

需要 Node >= 24。以下命令从仓库根目录执行：

```sh
npm ci --prefix src/modules/web
npm run dev --prefix src/modules/web -- --port 5178
npm run typecheck --prefix src/modules/web
npm test --prefix src/modules/web
npm run build --prefix src/modules/web
```

打开 http://127.0.0.1:5178 。独立入口 `main.tsx` 明确使用一次性内存演示；刷新页面重置示例内容。演示包含三个技能、两份提案、一个使用 v1 的旧任务和 v2 更新提示。`demo.ts` 的简单按文件比较、权限检查和内存回执只支持 UI 开发，不是服务持久化、三方文本合并、事务或真实 Agent 验收证据。

## 注入服务

```tsx
import { App } from "./src/modules/web";

<App
  library={libraryClient}
  runtime={runtimeClient}
  actor={actor}
  initialSessionId={hostSessionId}
/>;
```

必须注入契约中的 `LibraryService`、`RuntimeService`、`Actor`；`demo` 默认 false，独立演示入口显式设为 true。`initialSessionId` 可选，允许宿主打开已有会话；不传时由运行时创建。切换身份时由宿主重挂载 App，不应把前端传入 Actor 当作服务器认证。

- 列表搜索、正文与文本资源快照、历史、两版本比较、历史恢复草稿。
- 独立草稿 1.8 秒防抖自动保存和手动保存；保存失败不清空输入、不循环自动重试。过期修订可读取服务器内容，对照后明确采用新修订号，保留本地输入。只在 sessionStorage 保存按团队/用户/技能/历史源隔离的草稿 ID；内容保存由 LibraryService 承担。未保存内容离开有确认，关闭页面有浏览器提示。
- 提交绑定修订与幂等键；作者不得评审；只有 pending 提案允许非作者维护者评审。预览是只读操作，作者或维护者可读取 pending / changes_requested / conflicted。批准绑定服务预览令牌与当前版本，必须检查最终内容。
- 三方冲突显示基础、最新、提案；文本资源可编辑、选择或明确删除。解决后创建当前基线的新草稿，检查新基线仍与预览相同，保存解决内容，再撤回原提案，最后由作者提交新提案。无冲突但请求修改的提案也有继续调整入口。该多步流程不是事务，失败保留原始输入，可能留下未提交草稿；不存在自动覆盖或自动批准。
- 会话读取真实调用记录与运行时重建的更新状态；`setPreference` 精确传递已查看目标和预期偏好修订，STALE_REVISION 只刷新状态并提示重新确认，绝不自动重试为另一目标。页面不改写既有任务快照。
- “接受新任务并载入技能”通过运行时接受任务、解析技能包、记录已解析的调用。此入口未执行 LLM/Agent，UI 明示此边界；阶段 2 必须接入宿主真实任务接受与调用生命周期，不能把这条前端演示链当成生产 Agent 执行。

## 暂定会话规则及边界

D1：只影响本会话后续新任务。D2：每个会话、每个技能可保留已用旧版，直到选择新版或结束会话；新会话默认最新。D3：不处理提示时后续新任务使用最新。这些是待产品确认的默认值，UI 中可展开查看；具体选择由注入的 RuntimeService 负责持久化与并发控制。若产品改变默认值，需要一起调整适配器配置和显示文案。

当前任务、子任务、自动重试与恢复始终固定接受时版本。新任务与偏好选择的原子顺序由服务/宿主保证；浏览器操作顺序不能代替这一保证。

没有订阅、通知中心、邮件或外部消息。当前使用显式刷新、操作后刷新和重新进入页面加载；推送、断线重连、跨标签同步属于阶段 2 接线。会话固定版本标记来自 `getSessionUpdates` 返回的 preference，宿主应持续返回已保留的版本状态。

资源仅为 UTF-8 文本，原始文本安全呈现，不执行 Markdown HTML 或脚本。不提供二进制资源上传、维护者配置、首次创建技能表单、真实登录、Agent 效果验证、审计运维或服务端完整授权保证。这些不属于本轮 task C 界面验收；首次创建等完整 M2 管理能力仍需后续集成补齐。
