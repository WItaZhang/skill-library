# 自动生效与作者更新 v2 开发状态

当前有效需求为 development-requirements.md，共享契约为 v2；取代上一轮人工评审/合并流程。main 只包含管理文档、契约和组合验收脚本，各模块仍在独立分支，未合并。

## 本轮编排

Orca run：run_8b186ce69b52。共享基线：2fedeea。组合验收脚本：src/acceptance/run-isolated.py。

| 模块 | 分支 | Task | Dispatch | 当前状态 |
| --- | --- | --- | --- | --- |
| 管理服务 | WItaZhang/skill-service-v2 | task_a342e4f530f2；补充 task_c98ff99bb1db | ctx_2494fa6aa5f4；补充 ctx_22acbe2c8826 | da980c1，16项测试在Node24/26通过，等待组合验收 |
| 编辑界面 | WItaZhang/skill-web-v2 | task_20ef8aac8336 | ctx_cc82fb503f07 | 开发与验收中 |
| 广播适配 | WItaZhang/skill-broadcast-v2 | task_d90e189a6082 | ctx_3d5e4c0bc2b9 | 开发与验收中 |
| 原运行时 | WItaZhang/skill-runtime | 前轮已完成 | 已释放 | 1e9f02b，本轮不改实现，组合时回归 |

管理服务的首次交付为c61b840，交叉检查后补充da980c1：无实际内容变化的发布返回校验错误，不产生空版本/广播；已成功请求重试仍返回原回执。无需另一人审批，旧review/merge API已不在服务对象上。

## 交叉检查重点

- 广播与自动保存不得覆盖尚未保存的编辑。
- 同步请求中若发生新输入，不能把旧基线内容当成已同步基线的新意图自动保存。
- 连续发布改变冲突集合后，用户手写结果必须仍可见、可恢复。
- 广播传输保留可信的可操作校验错误，并支持服务允许的文本包大小。
- 无订阅通知，无人工审批。真实身份和Agent仍通过宿主接入。

## 合并说明

v2服务和前端分支各自包含其v1模块历史，不需重复合并旧模块。广播为新模块；runtime维持旧分支。用户审阅后建议service-v2、runtime、broadcast-v2、web-v2顺序合并；共享契约以main的v2为准。

旧开发状态中的43项测试为上一轮流程的历史结果，不能代替本轮验收。新的测试证据以各分支 docs/acceptance/*-v2.md 与本轮组合报告为准。
