# Skill Library

**技能持续进化，协作不丢修改，每次执行都有版本可查。**

面向共同维护 AI Agent 技能的团队：把可复用指令与配套文本资源，组织成可协作编辑、可发布、可追溯的技能库。

[English](README.md) · [数据库设计](src/modules/persistence/README.md) · [验收记录](docs/acceptance/production-456-merged.md) · [部署手册](docs/deployment/runbook.md)

## 当一份好用的提示词，开始被整个团队依赖

最初，你只需要修改一份文件。后来，同事也开始编辑，正在运行的任务依赖旧内容，一次超时又让你不确定模型是否已经执行。

这时，团队需要回答三个问题：**我的修改还在吗？这次任务用了哪一版？重试会不会重复执行？**

| 真实痛点 | 产品如何处理 |
| --- | --- |
| 同事发布新版时，我还没保存 | 更新提醒不覆盖输入；保留草稿，展示基础、我的修改和团队最新版。 |
| 两个人从同一版本提交 | 服务端只允许一个发布成功；另一个保留草稿，明确处理差异后再发布。 |
| 技能更新后，任务结果发生变化 | 任务固定接受时的版本；重试和子任务继承它，新任务默认用最新版。 |
| 请求超时，不知道模型是否完成 | 记录执行尝试与可用的提供方请求编号；不确定的调用单独标记，由用户决定是否重试。 |
| 成员离开，还开着编辑页面 | 请求和事件流持续核验权限，撤权后关闭旧工作区。 |

## 从草稿到执行结果，一条完整路径

1. 创建团队、邀请成员，分配管理员、贡献者或查看者权限。
2. 创建技能，编辑个人草稿，添加配套文本资源，恢复已保存的草稿。
3. 校验通过后直接发布新版本；历史保持不可变，更新即时通知协作者。
4. 查看三方差异，明确确认同步；恢复旧版会创建新草稿，不改写历史。
5. 在任务详情里查看固定技能版本、执行尝试、结果和错误状态。

<details>
<summary><strong>查看协作与差异处理界面</strong></summary>

![保留本地输入的三方差异界面](docs/images/collaboration.png)

真实产品的双浏览器验收截图，账号与内容为测试数据。

</details>

<details>
<summary><strong>查看任务执行详情</strong></summary>

![固定技能版本、执行尝试与结果](docs/images/execution.png)

截图来自已接入的任务界面；其中模型提供方与结果明确为 fixture，不代表真实模型调用成功。

</details>

## 产品承诺背后的工程设计

采用 **TypeScript / React / Node.js / PostgreSQL / SSE**，保持模块化单体。身份、技能和执行共享数据库及连接池。

**发布事务**一次提交版本、当前指针、草稿推进、审计、持久事件和幂等回执，同时检查权限、修订和基线。失败全部回滚；请求重试不重复发布。

**接受任务事务**一次提交固定版本快照和待执行请求。外部模型调用发生在事务之外，避免持锁等待网络。执行尝试有次数上限和租约；无法确认远端结果时标记 `uncertain`，不盲目自动重试。

取舍也保持明确：团队级锁简化写入顺序，但限制单团队并行写入；OAuth 临时状态和限流保留在内存，首版按单实例部署。技能内容使用 JSONB 配合生成列、外键和唯一约束，新增执行记录使用显式业务列。当前执行器生成文本，不开放 shell 或工具执行。

详细设计见 [数据库与迁移](src/modules/persistence/README.md)、[执行状态机](src/modules/execution/README.md)。

## 本地运行与验证

需要 Node.js 24+、PostgreSQL 17+ 和 Chrome/Chromium。仓库根目录执行：

```sh
sh src/deployment/install.sh

export DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/skill_library_test'
export DRILL_ADMIN_URL="$DATABASE_URL"
export PG_BIN='/path/to/postgresql-17/bin'
export CHROME_PATH='/path/to/chrome-or-chromium'

sh src/integration/verify-release.sh
```

使用独立测试数据库，账号须能创建 schema 和临时数据库；脚本清理自己创建的测试数据。该路径使用明确的 OAuth / 模型 fixture，不需要真实提供方凭据。

启动正式应用前，按[部署手册](docs/deployment/runbook.md)配置 HTTPS origin、GitHub OAuth、PostgreSQL 和监控密钥，再执行：

```sh
npm run build --prefix src/modules/product
npm run start:production --prefix src
```

真实模型执行另需服务端 `ANTHROPIC_API_KEY`、`EXECUTION_MODEL` 和 `EXECUTION_ENABLED=true`。缺配置明确失败，不返回假执行结果。

## 当前验证到哪一步

Node 24、真实 PostgreSQL 与隔离 Chrome 会话下，**155 项发布验收测试通过**；随后对任务文本转义边界的修复，重新通过全部 18 项执行测试和类型检查。

已验证并发发布、输入保护、断线恢复、权限撤销、worker 崩溃、重试和子任务版本固定、限流、日志脱敏、进程重启，以及真正的 `pg_dump / pg_restore` 备份恢复。[完整证据](docs/acceptance/production-456-merged.md)

真实双 GitHub 账号、真实模型调用、Docker 镜像运行、GitHub CI 实际运行和公网 HTTPS 仍待外部配置与验收。当前没有公开演示链接；部署定义、运行手册和最后验收步骤已在仓库中提供。

源码目录和架构图见 [English README](README.md#code-map)。生产路径使用 PostgreSQL，旧 SQLite 模块保留用于历史数据迁移与回归。
