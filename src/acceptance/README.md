# 自动生效组合验收

publication.test.ts 使用真实 SQLite 管理服务、未改动的运行时模块、loopback HTTP/SSE 和广播模块的浏览器 HTTP 客户端。身份解析器仅是显式测试夹具，不能代表生产认证。没有模拟管理服务或持久事件。

验收覆盖：无审批发布、两个同团队客户端收到正式发布、其他团队不收到、作者未保存内容与草稿不被广播改写、过期非重叠修改拒绝、作者显式确认同步后发布、发布幂等、旧审批路由不可用、断线重放、处理期间再次更新拒绝、原任务版本不变而新任务用新版。

三个模块提交后可在管理工作区运行（各模块先安装自身依赖）：

```sh
python3 src/acceptance/run-isolated.py \
  --service-worktree /path/to/skill-service-v2 \
  --runtime-worktree /path/to/skill-runtime \
  --broadcast-worktree /path/to/skill-broadcast-v2
```

脚本将当前管理提交中的契约和验收代码、各模块 HEAD 的已提交代码提取到临时目录；只链接各模块已安装的 node_modules，不修改工作区、不执行 merge。退出自动删除临时目录，并输出所验收提交 SHA。合并后也可直接运行 `node --experimental-strip-types --test src/acceptance/publication.test.ts`。

浏览器编辑行为由 web-v2 的组件交互和浏览器检查单独验收；本套不冒充完整浏览器端到端测试。真实 Agent 接入、生产身份和跨库任务接受一致性仍需后续验证。
