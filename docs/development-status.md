# Skill Library 开发状态

## 管理约定

当前 main 为开发管理及用户合并入口。共同基线为 4e9a658。应用代码全部位于 src。各模块独立提交，不自动合并或推送。

Orca run：run_1fef2cedd9d4。

## 第一阶段并行模块

| 模块 | 分支 | Worktree | Task | Dispatch | 状态 |
| --- | --- | --- | --- | --- | --- |
| 管理服务 | WItaZhang/skill-service | /Users/qianqian/orca/workspaces/skill-library/skill-service | task_4f1130c18f08 | ctx_144ddc8696a9 | 开发中 |
| 任务运行时 | WItaZhang/skill-runtime | /Users/qianqian/orca/workspaces/skill-library/skill-runtime | task_5e2aa529581b | ctx_dd45d1ab774e | 开发中 |
| 前端交互 | WItaZhang/skill-web | /Users/qianqian/orca/workspaces/skill-library/skill-web | task_5feb4b5f1e8b | ctx_34379d9af4ec | 开发中 |

模块验收报告分别由 worker 写入各分支的 docs/acceptance/service.md、runtime.md、web.md。主工作区在用户合并前不会出现这些模块代码与报告。

## 后续阶段

阶段 2 为 HTTP 接线、身份适配、实时推送和跨模块端到端验收。必须在用户审阅并合并第一阶段分支后，从合并后的新基线创建集成 worktree；当前未启动。

阶段 3 为真实 Agent 平台接入、容量及恢复验收。依赖平台接口和需求中 D1 至 D6 的最终确认，不能用本地演示替代。

## 管理命令

```sh
orca orchestration worker-list --run run_1fef2cedd9d4 --include-remote --json
git worktree list
git diff main...WItaZhang/skill-service --stat
git diff main...WItaZhang/skill-runtime --stat
git diff main...WItaZhang/skill-web --stat
```

建议审阅与合并顺序为 service、runtime、web。实际合并由用户在本会话指示，不由 worker 自动执行。
