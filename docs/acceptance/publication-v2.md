# 自动生效与作者更新组合验收

日期：2026-10-26。结果：本次范围内的服务、作者交互和广播实现已交付；模块分支保持独立，尚未合并到main。

## 验收代码版本

| 模块 | 分支提交 | 证据 |
| --- | --- | --- |
| 管理服务v2 | da980c194a197678fa5ae74b4829d92872b17aa9 | 各模块报告 service-v2.md，16项测试在Node24/26通过 |
| 前端v2 | 79906664e76f4d20c4cf8525f367b89dd0afcf15 | 各模块报告 web-v2.md，22项交互测试、类型检查、构建通过 |
| 广播v2 | bb74c4acb674119ecb100e4042e4407d2312d6ac | 各模块报告 broadcast-v2.md，8项HTTP/SSE测试通过 |
| 原运行时 | 1e9f02b399e877ed852800bdf948d24cb904a95f | 在v2共享契约和真实新版管理服务组合中回归 |

模块报告当前位于对应worktree，用户合并后会出现在统一目录。管理端检查了报告、关键实现、提交范围和差异，不把模块fixture测试当作真实持久化证明。

## 管理端实际执行

在管理工作区执行：

```sh
python3 src/acceptance/run-isolated.py \
  --service-worktree /Users/qianqian/orca/workspaces/skill-library/skill-service-v2 \
  --runtime-worktree /Users/qianqian/orca/workspaces/skill-library/skill-runtime \
  --broadcast-worktree /Users/qianqian/orca/workspaces/skill-library/skill-broadcast-v2
```

脚本提取已提交代码到临时目录并统一共享契约，只链接已安装依赖，不修改worktree或执行merge。环境Node v26.11.1。

结果：publication.test.ts **3/3通过**，runtime.test.ts **9/9通过**，exit 0。

1. 真实SQLite创建与自动发布v1，维护者清单可为空。A、B两个同团队SSE连接收到v2；其他团队无事件。B的保存草稿不被广播改写；过期非重叠修改被拒绝，预览含本地输入且不推进基线，显式同步后发布v3。同步无事件、成功重试无额外事件、v1资源不变、旧mergeProposal路由不可调用。
2. 独立Node进程通过另一个SQLite连接发布，已连接SSE客户端收到恰好一个逻辑新事件，证明不依赖同进程回调。
3. 离线期间连续发布，重连从游标补发；对旧目标的手动解决结果被拒绝且原草稿保留。原运行任务继续解析v1，新任务解析v3，会话重建提示指向v3。

运行时原9项测试继续通过，覆盖子任务、同ID恢复、偏好竞态、身份隔离、资源校验和进程退出恢复。共享契约另执行1项测试通过。

初次组合脚本因系统Python不支持tarfile.extractall的filter参数而失败，未进入应用测试。已改为先验证本地git归档的路径和文件类型，再提取；修复后组合与回归测试均通过。没有遗留应用测试失败。

## 前端证据与本轮修复

Web worker在实际Chrome内存演示中确认：无评审导航；另一作者发布后本地输入仍在，发布禁用；三方差异和无重叠说明可见；确认前不能同步；确认后保留远端新增资源及本地正文，提交立即显示自动生效。

交叉检查补充了：同步请求期间输入后的显式恢复状态，暂停自动保存/发布；连续发布后原手写结果仍可见；查看者兼维护者的既有编辑授权对齐；无内容变化禁止发布；传输保留可操作的领域校验信息并支持合法文本包大小。

## 未验证边界

- Chrome交互使用明确内存演示；真实HTTP/SSE组合使用程序化客户端。没有声称已完成完整React页面、原生EventSource、真实身份和Agent的一条浏览器端到端链路。
- 生产认证由可信resolveActor宿主提供，测试身份为显式夹具。真实Agent和先前记录的跨库任务接受顺序未在本次改造中解决。
- 二进制资源、首次创建表单、完整管理员界面、窄屏回归、容量和生产部署仍属于后续工作。
- 用户负责正式合并。新service-v2/web-v2已包含各自v1历史，不必再次重复合并旧模块分支。
