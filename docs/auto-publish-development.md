# 自动生效与作者更新开发计划

本次取代此前人工评审流程。当前有效需求见 development-requirements.md，共享接口为 src/contracts v2。旧模块分支保留；从其提交创建 v2 worktree，主工作区只提交需求与契约，不代用户合并模块。

## 并行任务

| 任务 | 基础提交 | 拥有目录 | 验收 |
| --- | --- | --- | --- |
| A2 管理服务 | f4b1e3d | src/modules/service，docs/acceptance/service-v2.md | publishDraft、previewDraftUpdate、applyDraftUpdate；真实 SQLite 并发/回滚/幂等/升级 |
| C2 编辑界面 | 3d9629f | src/modules/web，docs/acceptance/web-v2.md | 移除人工评审；作者编辑区更新处理、输入保护、发布与广播交互 |
| D2 广播适配 | 本次管理基线 | src/modules/broadcast，docs/acceptance/broadcast-v2.md | HTTP/SSE 与客户端；权限、断线重放、只有正式发布事件 |

所有 worker 启动时精确同步管理基线的 src/contracts、src/AGENTS.md、docs/development-requirements.md、docs/auto-publish-development.md，不自行修改共享契约。模块源码只修改自有目录。运行时接口兼容，无需重做 runtime 模块。

## 组合与合并

三个独立模块完成后，在临时验收目录中使用真实 service 与 broadcast、运行时回归及浏览器客户端进行组合验收。可以复制或引用各 worktree 的已提交代码来验证，不把模块分支合并到 main。真实 Agent、生产认证与跨库任务接受边界仍是后续平台接入项。

用户审阅并合并 v2 分支时，它们已经包含对应 v1 模块历史，不再另行重复合并旧模块分支。广播分支是新增模块。runtime 分支维持 1e9f02b。旧集成计划中的人工审批、提案评审接口和自审限制不再作为当前流程要求。
