# Runtime 模块验收记录

状态：模块验收通过，等待用户合并。日期：2026-10-26。仅提交 `src/modules/runtime/**` 与本报告；没有修改 service、web、contracts、根配置，没有合并、推送或删除 worktree。

## 范围与证据

实现共享契约的 `createRuntimeService({databasePath, host})`，返回 `RuntimeService & {close()}`。SQLite 持久化会话、不可变任务快照、内部包校验值、真实调用记录、会话偏好及修订。M5 的目录冻结、子任务继承、重试恢复、资源完整性、M6 的提示重建、保留/跟随和并发保护已实现；不是实际 Agent 接入或完整 M6 推送交付。

在 Node v26.11.1 上实际执行（目标 Node >=24；未在 Node 24 单独执行）：

```sh
npm install --prefix src/modules/runtime --no-audit --no-fund
npm ci --prefix src/modules/runtime --no-audit --no-fund
npm run typecheck --prefix src/modules/runtime
npm test --prefix src/modules/runtime
git diff --check
```

安装成功，独立 lockfile 可复现；类型检查通过；最终测试 9 通过、0 失败、0 跳过。首次测试 5/6 通过，发现首次返回的空原型映射与幂等重读的普通 JSON 对象不同；已统一返回结构，之后全部通过。

| 测试 | 实际验证 |
| --- | --- |
| full catalog freezes resources… | v1→v2 后旧任务正文/附件/脚本固定；子任务固定；同 ID 重试；新任务最新版；任务后出现 Skill 不可调用；ID 请求冲突 |
| actual invocations rebuild… | 未调用不提示；更新早于首调用仍提示；无事件 v2→v3→v4 重建；重复查询不堆叠；过期目标拒绝；保留/跟随/新会话隔离 |
| two database connections… | 两个独立连接的同 revision 竞争仅一成功；资源验证中偏好提交使任务重捕获；保存准确 revision；并发同任务 ID 返回相同快照 |
| ownership, team isolation… | 同团队其他用户和跨团队被拒绝；Host 撤权后读取/解析失败；非法输入和未调用的保留选择失败 |
| missing, corrupt, mutated… | 历史资源缺失、坏 checksum、相同 ID 内容篡改并重算 checksum、跨团队版本拒绝；失败不记录调用、不接受部分任务 |
| database recovery… | 第二连接读取持久化偏好/调用/快照；独立进程幂等重读；SQLite 触发器拒绝改写任务和删除调用 |
| publication during latest-target… | 目标资源读取期间发布新版，二次目标检查拒绝过期确认，偏好未写入 |
| writer process exit… | 独立进程持久化后直接退出（无 close）；新进程上下文重开 SQLite 后恢复会话/偏好/调用/旧资源及子任务 |
| resource validation rejects… | 路径遍历、非规范路径、缺少 SKILL.md 拒绝；重复路径在资源失败测试覆盖 |

## 接口假设与限制

D1–D3 采用明确暂定默认值：仅影响未来任务、会话按 Skill 保留直到解除、未选择跟随最新；未确认产品决策，其他策略未开放。会话生命周期无结束 API，由宿主停止使用已结束会话 ID。调用记录 API 没有幂等键或结果字段，不能声称提供执行结果或调用网络重试去重。

Host 必须返回单次一致授权目录，实施真实身份和撤权校验，保留完整历史版本。runtime 校验规范路径、必要入口、完整包 checksum 和身份关联；内容只支持契约的 UTF-8 文本，未实施任意 Markdown/脚本动态引用解析或二进制支持，资源清单完整性由发布校验和 Host 负责。没有执行 Skill 脚本或绕过平台工具权限。

**Host catalog / preference 事务边界：** runtime 偏好与 epoch 原子提交，任务提交时比较捕获的 epoch，冲突重读整个 Host 目录与偏好；本地没有部分 Skill 切换。Host 目录捕获和 runtime SQLite 提交属于两库两阶段，当前接口没有目录 revision 条件提交能力；目录响应后、快照提交前的发布不能被本地事务排除，最新选择最后一次目标检查后仍有同类窗口。明确任务选版点为成功尝试的 Host catalog 捕获，提交后返回接受。阶段 2 必须统一协调发布/偏好/任务接受，或经协调扩展 Host revision/条件提交边界，才能声称平台接受提交瞬间的跨库线性一致性；详见模块 README。当前契约无需变更以交付第一波，不能将本波局部竞态测试当作跨模块一致性证明。

没有订阅、外部通知、HTTP 服务、事件投递器、真实 Agent 或生产身份。重复/丢失事件的证据是完全不依赖事件且重复查询幂等，不是对真实消息系统的故障注入。尚未进行负载/P95、真实平台生命周期、跨库备份恢复、断电恢复、实际推送或二进制验收。SQLite 同步 API 和全目录逐版本校验可能限制大目录吞吐；宿主慢响应会延迟首次接受，需后续容量验证。关闭服务前需等待进行中的调用完成。

## 合并与提交

独立 package.json、package-lock.json、tsconfig.json；只使用内建 SQLite，无生产 npm 依赖。共享类型使用相对路径引用。用户可独立审阅合并本模块，再由第二阶段接线。提交 SHA 由最终 worker_done 报告补充，避免在同一提交中自引用。worktree 保留供用户审查。
