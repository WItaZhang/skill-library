# Skill Library 开发状态

## 管理约定

当前 main 为开发管理及用户合并入口。共同基线为 4e9a658。应用代码全部位于 src。各模块独立提交，不自动合并或推送。

Orca run：run_1fef2cedd9d4。

## 第一阶段并行模块

| 模块 | 分支 | Worktree | Task | Dispatch | 状态 |
| --- | --- | --- | --- | --- | --- |
| 管理服务 | WItaZhang/skill-service | /Users/qianqian/orca/workspaces/skill-library/skill-service | task_4f1130c18f08 | ctx_144ddc8696a9 | 开发中 |
| 任务运行时 | WItaZhang/skill-runtime | /Users/qianqian/orca/workspaces/skill-library/skill-runtime | task_5e2aa529581b | ctx_dd45d1ab774e | 模块验收通过，提交 1e9f02b，等待用户合并 |
| 前端交互 | WItaZhang/skill-web | /Users/qianqian/orca/workspaces/skill-library/skill-web | task_5feb4b5f1e8b | ctx_34379d9af4ec | 开发中 |

模块验收报告分别由 worker 写入各分支的 docs/acceptance/service.md、runtime.md、web.md。主工作区在用户合并前不会出现这些模块代码与报告。

运行时验收：类型检查与 9 项测试通过，管理端已检查报告、文件范围及提交差异。完成后的 worker 终端已释放，分支与 worktree 保留。

## 后续阶段

阶段 2 为 HTTP 接线、身份适配、实时推送和跨模块端到端验收。必须在用户审阅并合并第一阶段分支后，从合并后的新基线创建集成 worktree；当前未启动。

已登记集成 Task `task_b99f8b646ab6`，依赖三个第一阶段 Task；合并门槛 `gate_52d91832c64e` 保持 pending。模块完成不自动解除合并门槛。

阶段 3 为真实 Agent 平台接入、容量及恢复验收。依赖平台接口和需求中 D1 至 D6 的最终确认，不能用本地演示替代。

已识别的集成重点：运行时本地事务能保护偏好修订和任务快照，但 Host 目录捕获与本地任务提交不是同一事务。阶段 2 必须协调发布、偏好与任务接受，或引入目录 revision 条件提交；在此之前不宣称跨模块线性一致性通过。

## 管理命令

```sh
orca orchestration worker-list --run run_1fef2cedd9d4 --include-remote --json
git worktree list
git diff main...WItaZhang/skill-service --stat
git diff main...WItaZhang/skill-runtime --stat
git diff main...WItaZhang/skill-web --stat
```

建议审阅与合并顺序为 service、runtime、web。实际合并由用户在本会话指示，不由 worker 自动执行。
