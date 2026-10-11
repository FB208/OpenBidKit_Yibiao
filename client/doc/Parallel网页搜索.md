# Parallel 公开网页搜索

开发者模式的 **Pi Agent 链路测试** 页面可为一次任务启用 [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)，用于查询公开技术资料、产品说明和参考网页。勾选 **启用 Parallel 公开网页搜索与读取（本次任务）**，在测试任务中描述需要查找的公开资料，然后运行完整链路测试。

例如：

```text
搜索公开的智慧园区运维技术资料，选择一个来源读取其相关摘要。
把来源链接和要点写入 agent-result.md。
```

搜索使用免费匿名入口的 Fast 模式，无需 Parallel 账号或 API Key，适合轻量使用，有请求限额。文本模型仍使用客户端中已配置的模型。请求失败时会作为工具错误返回给智能体。

此选项默认关闭，仅对本次开发者测试任务生效，不写入全局配置。标书生成、知识库和其他业务任务不会因此启用联网搜索。搜索词和网页地址会发送给 Parallel，请仅查询公开信息，勿发送客户资料、未公开网址或招投标文件内容。

## Main 侧调用

Main 侧已有 `agentService.runTask()` 调用可显式传入 `parallel_search: true`，通过现有 Pi Session 注册 `parallel-web-search` 和 `parallel-web-fetch`。默认不注册这两个工具。若任务显式提供 `active_tools` 或切换阶段权限，仍须在允许的阶段列出需要使用的工具名称。

连接使用 Streamable HTTP 和 `https://search.parallel.ai/mcp`，每次工具调用受取消信号和 60 秒超时控制。搜索和读取在同一个 Pi Session 中共享匿名请求标识，不读取 Parallel 环境密钥或用户凭据。

```js
await agentService.runTask({
  task: '查找公开的智慧园区运维资料，把来源链接和要点写入 agent-result.md。',
  output_file: 'agent-result.md',
  parallel_search: true,
});
```

在 `client/` 中运行定向检查：

```bash
node --test electron/services/pi/piParallelSearchTools.test.cjs
node scripts/check-parallel-search.cjs
```

第一项使用本地 MCP 响应验证请求、错误和取消；第二项在隔离工作区中通过真实 Pi 工具循环访问匿名 MCP 入口，不使用外部文本模型。在线检查受免费入口的网络条件和限额影响。
