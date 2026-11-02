# 广播适配层 v2 验收

本分支只新增 `src/modules/broadcast/**` 和本文档。独立 package/lock；不依赖具体 service、web 或 runtime 实现，不修改共享契约。

## 交付

- `server.ts`: `createLibraryHttpHandler({library, resolveActor, allowedOrigins?, maxBodyBytes?, bodyTimeoutMs?, pollIntervalMs?, backpressureTimeoutMs?})`，返回可直接传给 `node:http.createServer` 的函数；`handler.close()` 终止连接和轮询。
- `client.ts`: `createHttpLibraryClient({baseUrl?, fetch?})` 和 `createSseSkillUpdateSource({baseUrl?, afterSequence?, EventSource?})`。包默认入口和 `/client` 均为浏览器安全入口；`/server` 单独导出 Node 代码，适合 Vite 分离。
- 16 个 v2 方法显式白名单；无旧批准、评审或合并入口；JSON 不接受额外 Actor 字段。Actor 只来自必传的可信服务器回调；客户端接口中的 Actor 参数不序列化。
- POST 自定义请求头及来源校验、大小/时间限制、未知异常的固定中文安全错误，保留可信领域错误的有限长度可操作消息及白名单详情。SSE 使用持久事件查询，轮询检测服务外部写入、游标重放、团队过滤、连接期间身份再验证、慢客户端超时及取消清理。
- 具体集成方式、默认值、身份和代理边界见模块 README。

## 实际验证

环境：本机 Node `v26.11.1`，目标 Node >=24；使用真正 `127.0.0.1` 临时监听端口，不通过 mock fetch 替代传输测试。

执行命令：

```sh
npm install --prefix src/modules/broadcast
npm run typecheck --prefix src/modules/broadcast
npm test --prefix src/modules/broadcast
```

结果：依赖安装成功，审计 0 漏洞；TypeScript 检查通过；Node 测试 **8 通过、0 失败、0 跳过**。

1. HTTP 白名单、伪造 Actor 不改变可信身份、旧入口/对象属性 404、跨来源和缺自定义头 403、坏 JSON/超量正文/参数数量错误 400、认证失败、安全领域错误和网络/非 JSON 错误。
2. Alice/Bob 两个真实 HTTP/SSE 客户端同时收发布事件，Eve 不收到其他团队数据；保存、预览、应用、失败发布无事件，幂等发布仅一条逻辑事件；服务外部追加事件被轮询发现；断线期间连续发布后按 Last-Event-ID 补发；显式 after 游标重放；每次连接触发 onReconnect；取消不再回调，身份撤销后停止发送，close 后停止查询。
3. 非法 SSE 游标和未认证请求不能建立事件流。
4. 浏览器 HTTP 客户端覆盖全部 v2 方法路由。
5. 更新源拒绝错误事件、过滤异团队数据、重连回调、unsubscribe 移除监听器并防止已排队回调继续生效。
6. 即使 fixture 错误返回全部团队及倒序日志，SSE 仍按团队过滤并排序；Last-Event-ID 优先于更旧 query 游标。
7. 慢 POST 正文超时；暂停读取的真实 TCP 客户端触发 SSE 背压期限，服务端不继续轮询并清理该连接。

8. 默认 16 MiB 正文上限接受经过 JSON 转义膨胀的 2 MiB 文本；RESOURCE_MISSING 保留缺失资源路径及修订信息，同时过滤 stack/sql/cause，消息最长 1024 字符。

首轮执行曾发现测试配置缺 DOM.Iterable 和 Node strip-only 不支持测试里的参数属性；修正后上述检查全部通过。

## 验收限制与后续组合

`test/fixture.ts` 是显式 `LibraryService` fixture，身份来自测试专用 cookie 映射；它不证明真实认证、SQLite 事务、草稿权限、完整内容校验或跨进程数据库一致性。测试中的外部发布通过直接追加 fixture 日志模拟，证实适配器不依赖同进程发布回调，但不是双数据库进程实测。

SSE 客户端测试使用注入的 fetch-backed EventSource 测试替身，通过真实 HTTP/TCP 完成数据与 Last-Event-ID 重放；浏览器原生 EventSource 的自动重试调度、真实浏览器 Cookie/CORS 和实际 Vite 构建仍由组合验收验证。慢连接测试使用大体积 fixture 事件，仅用于触发真实 socket 背压，不代表生产事件载荷。

协调端后续需要组合真实 SQLite service、runtime 和前端客户端完成 A 发布 → B 收到 → B 预览并明确确认 → B 发布闭环，并验证真实第二进程数据库发布。该集成不在本 fixture 报告中冒充完成；生产身份及真实 Agent 平台接入仍未提供。运行中任务不切换版本，本模块没有任务状态写入路径。

提交 SHA 随 worker_done 报告提供，避免文档自引用当前提交哈希。
