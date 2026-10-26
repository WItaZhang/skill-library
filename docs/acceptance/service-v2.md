# 管理服务 v2 验收

2026-10-26；分支 `WItaZhang/skill-service-v2`，保留供用户审阅合并，无 merge/push。共享基线独立提交 `f8e09bc`，内容通过 `git restore --source 2fedeea -- src/contracts src/AGENTS.md docs/development-requirements.md docs/auto-publish-development.md` 精确同步，无额外共享修改。实现提交 `dc3e7f8`；本报告随后单独提交，最终 SHA 见 worker_done。

## 实现与结果

- 唯一发布入口 publishDraft；无需第二位维护者，允许空维护者清单。新版本 reviewerId=null、approvalMode=automatic；旧提案 API 属性不存在。
- 同一 SQLite BEGIN IMMEDIATE 事务核对权限、作者、修订、基线与当前指针，写入版本/指针/作者草稿/事件/审计/幂等回执。任何过期草稿，包括非重叠文本，均拒绝发布。
- previewDraftUpdate 保存服务端随机 token 及完整快照摘要；按用户/团队隔离并绑定草稿/修订/基线/本地内容/目标/候选。预览不修改保存草稿，返回输入拷贝、三方内容和差异。
- applyDraftUpdate 是作者确认；校验 token 与当前状态，原子保存处理结果和新基线。成功重试返回原始草稿，同键不同负载拒绝；保存修订检查阻止旧自动保存覆盖处理结果。
- 草稿允许不完整正文、引用和 JSON；结构/路径/类型/大小/脚本权限继续检查。完整包和平台回调在发布校验。
- v1 升级增加独立预览表并更新 schema 标记，不改写历史 JSON/提案。版本与事件的不可变触发器保留。

## 精确命令与结果

从仓库根执行，除注明外：

| 命令 | 结果 |
| --- | --- |
| `npm ci --prefix src/modules/service` | 成功，18包，0漏洞；npm提示 esbuild/fsevents 安装脚本未在 allowScripts 中，实际 tsx 测试运行成功 |
| `npm run typecheck --prefix src/modules/service` | 成功，TypeScript 无错误 |
| `npm test --prefix src/modules/service` | Node v26.11.1，15/15通过，0跳过 |
| `node --version` | v26.11.1 |
| `npx --yes --package node@24 node --version` | v24.22.1 |
| `npx --yes --package node@24 node --import tsx --test test/*.test.ts`，工作目录 `src/modules/service` | Node24完整15/15通过，包括fork子进程并发/SQLite读写 |
| `git diff --check` | 成功，无空白错误 |

原生 TypeScript 加载（不使用 tsx）也分别验证 Node26 和 Node24：

```sh
node --input-type=module -e "import {createLibraryService} from './src/modules/service/index.ts'; const s=createLibraryService({databasePath:':memory:'}); console.log(await s.listSkills({userId:'a',teamId:'t',role:'contributor'})); s.close();"
npx --yes --package node@24 node --input-type=module -e "import {createLibraryService} from './src/modules/service/index.ts'; const s=createLibraryService({databasePath:':memory:'}); console.log(await s.listSkills({userId:'a',teamId:'t',role:'contributor'})); s.close();"
```

均输出 `[]`，exit 0。Node24测试最初误从仓库根运行，相对glob不存在，zsh退出1；改为模块目录后完整通过。首轮并发测试错误复用首次发布幂等键，触发预期 CONFLICT；测试改为独立 race 键后真正验证一成功、一 STALE_REVISION。

## 15项测试证据

1. 单作者首次发布、草稿推进、后续修改后原请求重放、重启后重放、不同负载同键拒绝、旧review/merge方法不存在，版本/事件/发布审计各一条。
2. 非重叠过期发布拒绝；未保存内容预览、输入拷贝隔离、草稿不变、无冲突仍需显式apply；apply幂等和旧自动保存拒绝；随后发布成功。
3. 伪造token、其他用户/团队/草稿、已变化修订及新目标拒绝；失败保留原草稿。
4. 空正文/缺引用/未完成JSON可保存，发布拒绝；非法路径、脚本修改、viewer修改、身份撤销拒绝；无事件。
5–10. 六个发布故障点 after_version/pointer/draft/event/audit/request：比较versions/skills/drafts/events/audit/requests全部行，回滚后完全相同；使用相同键重试成功。
11. 两个独立OS进程、各自SQLite连接同时发布同基线，恰好一成功一过期；第三进程重放返回同版本，事件总数不增加，失败者草稿原样保留。
12. v1形状数据库（版本标记1、无draft_previews、真实reviewer历史JSON、待评审记录、旧草稿）升级后历史JSON逐字节一致；旧草稿直接产生v2自动版本，历史不可变触发器仍生效。
13. 三方重叠及删除/修改保留冲突内容；Markdown引用检查忽略代码块；排序无关的规范checksum。
14. apply在幂等回执写入后故障，草稿/审计回滚，原token可重试；明确删除与空文件区分；应用/失败不新增事件。
15. 独立连接保存使旧预览失效，保留新内容；撤权后成功发布原请求也不可重放。

## 限制与未验证集成

- HTTP/SSE、web、runtime均未修改；真实服务到浏览器的双客户端广播闭环须组合验收，不以此服务测试替代。
- 客户端未发送的后续输入无法由服务检测；v2 ApplyDraftUpdateInput无本地编辑代次字段。按契约由前端使旧预览失效或明确纳入新输入；服务负责saved revision/target/token检查。测试覆盖另一连接的已保存变化，不声称覆盖浏览器输入交错。
- v1升级测试使用v1兼容SQLite结构和手工插入的历史记录，不是生产数据库备份；不覆盖真实大库迁移性能。历史字段不补写approvalMode，保持原始JSON。
- 身份/成员/脚本/平台包规则回调仍由可信宿主提供，未接生产认证或Agent；无跨库任务接受一致性改动。
- token快照持久保存，当前无自动过期/清理策略；未来可增加保留策略。预览与幂等记录均不作为事件广播。
- 旧v1流程测试已用当前v2验收测试替换；未声称继续支持已移除评审功能。仅测试本机平台Node24/26，未测Windows/Linux或早期Node24补丁。
