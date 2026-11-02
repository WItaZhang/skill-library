# Skill Library

**技能持续进化，协作不丢修改，每次执行都有版本可查。**

面向共同维护 AI Agent 技能的团队：把可复用指令与配套文本资源，组织成可协作编辑、可发布、可追溯的技能库。

[English](README.md) · [开始使用](#开始使用) · [数据库设计](src/modules/persistence/README.md) · [部署指南](docs/deployment/runbook.md)

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

## 一次更新，不打断正在进行的工作

以两位同事共同维护研究技能为例：

- 两人都从 **v1** 开始修改，一人先发布 **v2**。
- 另一人收到提醒，保留自己的输入，明确处理差异后发布 **v3**。
- 已经接受的任务继续使用 **v1**，它的重试与子任务也保持 **v1**。
- 新任务默认使用 **v3**。

团队可以持续改进技能，每个任务也始终能查到自己使用的指令版本。

<details>
<summary><strong>查看协作与差异处理界面</strong></summary>

![保留本地输入的三方差异界面](docs/images/collaboration.png)

对照基础版本、自己的修改和团队最新版，再决定如何应用更新。图中使用示例数据。

</details>

## 产品承诺背后的工程设计

采用 **TypeScript / React / Node.js / PostgreSQL / SSE**，保持模块化单体。身份、技能和执行共享数据库及连接池。

**发布事务**一次提交版本、当前指针、草稿推进、审计、持久事件和幂等回执，同时检查权限、修订和基线。失败全部回滚；请求重试不重复发布。

**接受任务事务**一次提交固定版本快照和待执行请求。外部模型调用发生在事务之外，避免持锁等待网络。执行尝试有次数上限和租约；无法确认远端结果时标记 `uncertain`，不盲目自动重试。

应用采用单实例服务与持久 PostgreSQL，使用团队级锁明确发布和接受任务的先后顺序。执行器连接配置的 Anthropic 模型，依据所选技能资源生成文本，不开放 shell 或工具执行。

详细设计见 [数据库与迁移](src/modules/persistence/README.md)、[执行状态机](src/modules/execution/README.md)。

## 开始使用

**先用它管理你自己的技能。** macOS 本机版可以导入现有 skill 目录，在网页中编辑和发布，再带备份写回原目录；发现外部修改时会要求先处理差异。按照[个人技能库指南](docs/personal-library.md)启动，无需服务器或 GitHub OAuth 应用。

使用 **Node.js 24+ 和 PostgreSQL 17+** 自行部署，配置 HTTPS 访问地址与 GitHub OAuth 应用。[部署指南](docs/deployment/runbook.md)提供 Docker Compose、密钥、备份和监控配置。

在仓库根目录执行：

```sh
sh src/deployment/install.sh
npm run build --prefix src/modules/product

# 配置服务端环境变量后启动：
npm run start:production --prefix src
```

| 配置 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接 |
| `PUBLIC_ORIGIN` | 工作空间的 HTTPS 地址 |
| `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` | GitHub 登录；回调地址为 `PUBLIC_ORIGIN/api/identity/callback` |
| `METRICS_TOKEN` | 私有监控接口凭据 |
| `EXECUTION_ENABLED=true`、`ANTHROPIC_API_KEY`、`EXECUTION_MODEL` | 使用你的模型账号启用任务执行 |

凭据只放在服务端。密钥文件方式和可选的 Anthropic workspace 配置见部署指南。

启动后，登录并创建团队，发布第一个技能。邀请同事共同编辑，或选择已发布技能创建任务。

源码目录与架构图见 [English README](README.md#code-map)。
