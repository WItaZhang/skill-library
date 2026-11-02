# 在 Mac 上管理自己的技能库

本机版把已有的技能目录导入独立 PostgreSQL 数据库，保留草稿和发布历史。网页中的发布与本机文件写回是两个明确的操作。

## 启动

需要 Node.js 24 或更新版本，以及 PostgreSQL 17。首次准备：

```sh
sh src/deployment/install.sh
npm run build --prefix src/modules/product
node src/local/manage.ts scan
node src/local/manage.ts import
node src/local/manage.ts open
```

默认使用 Homebrew 的 `/opt/homebrew/opt/postgresql@17/bin`。其他安装位置可在首次启动前设置 `PG_BIN`。再次使用只需运行 `node src/local/manage.ts open`；它会启动数据库和网页，并通过本机访问密钥登录。

默认地址为 `http://127.0.0.1:18880`。这是个人本机账号，不是 GitHub 账号；本机服务只监听回环地址，校验 Host、Origin、访问密钥、会话、团队权限和 CSRF。公网入口仍要求 HTTPS 与 GitHub OAuth，不能通过环境变量开启本机访问。

## 日常使用

1. 在“技能库”打开技能，编辑正文或附属文本文件，保存草稿。
2. 填写修改说明，点击“提交并生效”。历史版本始终保留。
3. 前往“本机目录”，点击“写回已发布版本”，确认版本与目录。此时才更新工具实际读取的技能文件。
4. 外部编辑器修改过原文件时，写回会停止。点击“读取为新草稿”，再到技能详情恢复该草稿。若网页与本机两边都有更新，编辑器要求明确处理差异后才能发布。

工具是否立即重新读取技能取决于工具自身的缓存和会话行为；必要时在对应工具中新开会话。

首次扫描 `~/.codex/skills`、`~/.agents/skills`、`~/.claude/skills` 的直接技能子目录。目录别名按真实路径去重；不自动导入系统、插件和嵌套同步目录。要增加来源，可在私有配置的 `directories` 中加入完整技能目录路径，再重启应用并从“本机目录”导入。网页不能指定任意磁盘路径。

当前支持 UTF-8 文本包，每个技能最多 256 个文件、2 MiB。二进制资源、目录内部软链接、隐藏凭证文件和缺失的 Markdown 附件会阻止导入；不会悄悄丢弃附件。脚本编辑仍受平台授权约束，本机入口没有开放脚本修改权限。导入和写回均不会执行技能中的指令。

## 数据和备份

默认私有目录：`~/Library/Application Support/Skill Library`。目录权限为 `0700`，配置文件为 `0600`，包含数据库密码和本机访问密钥，请勿上传到代码仓库。

- `postgres/`：独立的 PostgreSQL 集群，端口 `55433`，启用密码认证。
- `config.json`：账号、目录连接、端口和本机凭证。删除它不会重置数据库，且会失去已有账号连接；应与数据库备份一起妥善保存。
- `backups/`：每次写回前保存的完整原目录。
- `database-backups/`：数据库备份，包含账号、草稿、版本和目录连接。
- `application.log`、`postgres.log`：本机运行日志。

```sh
node src/local/manage.ts status
node src/local/manage.ts backup
node src/local/manage.ts stop
```

停止或重启保留数据。备份命令使用 `pg_dump`；恢复时先创建独立空数据库，用 `pg_restore --exit-on-error --single-transaction` 恢复并核对，再切换配置，避免覆盖现有库。不要将测试数据库作为个人库。

写回先生成待替换目录，核对原目录是否发生变化，保存备份，再切换目录；数据库记录随后提交。文件系统和数据库不属于一个原子事务：进程中断会留下恢复日志，服务下次启动先恢复原目录；数据库提交失败时可通过内容摘要识别重试。原目录还保留为同级隐藏的 `.skill-library-previous-*`，以保护仍被编辑器打开的旧文件。保留这些副本，确认无需恢复后再手动清理。

本机服务不会在开机时自动启动；使用启动器即可重新打开。不要将本机端口通过代理或隧道公开到网络。
