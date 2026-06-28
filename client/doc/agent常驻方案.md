# Agent 常驻与单任务队列方案

## 背景

当前 OpenCode Agent 的执行方式是按任务临时启动：`agentService.runTask()` 每次创建任务 workspace，再调用 `startIsolatedOpenCodeServer()` 启动一套 OpenCode Server 和一套 OpenCode AI proxy，任务结束后关闭。

这种方式隔离性强，但有几个明显问题：

- 多个业务同时调用 Agent 时，会同时启动多套 OpenCode Server 和 proxy。
- 每套 proxy 内部都有自己的文本请求队列，`concurrency_limit` 会按 Agent 任务数叠加，可能超过用户设置的文本模型并发上限。
- Agent 的进度和活性分散在各个临时 runtime 中，不利于统一展示“正在工作”还是“卡住”。
- 当前 `timeout_ms` 是绝对超时，任务一直有进展也会在时间到后被取消。
- 每次启动 OpenCode 都有额外进程启动、配置写入、健康检查成本。

本方案目标是把 OpenCode Agent 改成主程序内的常驻子服务，并在业务层强制单任务执行。

## 目标

- Agent 同一时间只允许执行一个任务。
- 如果已有 Agent 任务在执行，新任务不排队等待，也不作为错误统计，直接返回友好提示：`Agent 正在处理其他任务，请耐心等待`。
- Agent 空闲时定期检查 OpenCode 子服务活性。
- Agent 执行中持续记录粗粒度进度，判断它是在工作还是卡住。
- 只要 Agent 持续有进度变化，就永远不因为运行总时长而超时。
- 只有连续一段时间没有任何活动，才触发空闲超时。
- 尽量把 Agent 进度回传给前端，让用户知道 Agent 不是卡住。
- 保持 OpenCode 真实 API Key 不出 `configStore`，OpenCode 仍然只访问本地 proxy。

## 非目标

- 不把 OpenCode 深度 fork 或改造成项目内部 Agent Runtime。
- 不让 Renderer 直接访问 OpenCode HTTP API。
- 不把 Agent 任务混入普通 AI 请求队列中执行。
- 不在第一阶段实现多个 Agent 任务排队等待。
- 不把 Agent 忙碌返回计入 `agent_runtime` 的失败次数。

## 现状排查

| 模块 | 当前职责 | 现状判断 |
| --- | --- | --- |
| `electron/services/agentService.cjs` | Agent 统一入口 | 每次 `runTask()` 都启动并关闭一套 OpenCode Server/proxy |
| `electron/services/opencode/opencodeServerRunner.cjs` | 启动隔离 OpenCode Server | 以任务 workspace 作为 `cwd`，使用临时 HOME 和临时配置 |
| `electron/services/opencode/aiServiceOpenAiProxy.cjs` | OpenCode 专用 OpenAI-compatible proxy | 每次创建 proxy 时都会新建独立 `createOpenCodeTextQueue()` |
| `electron/utils/aiRequestQueue.cjs` | 普通 AI 请求队列 | 支持全局文本/生图队列、scope 暂停、重试和队列状态 |
| `electron/services/aiService.cjs` | 普通文本/生图 AI 请求入口 | `textRequestQueue` 读取文本模型 `concurrency_limit`，所有普通文本请求共享 |
| `electron/services/taskService.cjs` | 后台业务任务管理 | 通过 `aiService.withQueueScope()` 给普通 AI 请求注入 scope，不管理 Agent 互斥 |
| `electron/ipc/agentIpc.cjs` | Agent IPC | 只暴露 `agent:run`、`agent:self-check`、`agent:export-self-check-report` |
| `electron/preload.cjs` | Renderer bridge | `window.yibiao.agent.run()` 当前没有状态订阅能力 |

## AI 队列复用结论

现有 `aiRequestQueue` 不建议直接复用为 Agent 任务队列。

原因如下：

- 普通 AI 队列管理的是单次 HTTP AI 请求，不管理 OpenCode Server 进程、session、workspace、输出文件和任务生命周期。
- OpenCode Agent 请求必须经过本地 OpenAI-compatible proxy，proxy 需要转发 `/v1/chat/completions`、处理 SSE、统计 token、写 OpenCode 专用日志。
- 如果把 Agent 整体塞进普通文本队列，会让普通 AI 请求和 Agent 长任务互相阻塞，且 scope 暂停语义会混乱。
- 当前 OpenCode proxy 内部的队列可以继续保留，用于同一个 Agent 任务内部多轮模型请求限流。
- Agent 是否能并发执行，应由 Agent 专用单任务控制器决定，不应复用文本模型请求队列。

推荐做法：

| 层级 | 队列策略 |
| --- | --- |
| 普通 AI 请求 | 继续使用 `aiRequestQueue` 和 `aiService` 的文本/生图队列 |
| OpenCode proxy 内部请求 | 继续使用 `createOpenCodeTextQueue()`，后续可改造成共享单例 proxy 队列 |
| Agent 任务 | 新增 Agent 专用单槽运行锁，已有任务时直接返回 busy 结果 |

## 总体方案

采用“分阶段落地”。

| 阶段 | 目标 | 改动规模 | 价值 |
| --- | --- | --- | --- |
| 第一阶段 | Agent 单任务锁 + 忙碌友好返回 + 初步进度事件 | 小 | 立即解决并发超限，不破坏当前隔离启动模式 |
| 第二阶段 | OpenCode 常驻子服务 + 活性监控 + 空闲超时 | 中 | 降低启动成本，统一监控，支持前端展示 Agent 工作状态 |
| 第三阶段 | 完善配置变更重启、自检复用常驻服务、崩溃恢复 | 中 | 提升稳定性和诊断能力 |

第一阶段可以先不改变每次任务启动 OpenCode 的模式，只在 `agentService` 外层加单任务锁。第二阶段再把 OpenCode Server 和 AI proxy 抽成常驻 runtime。

## 第一阶段：Agent 单任务锁

### 行为规则

- `agentService` 内维护 `activeAgentTask`。
- `runTask()` 进入时先判断是否已有活动任务。
- 如果没有活动任务，正常执行并设置 `activeAgentTask`。
- 如果已有活动任务，立即返回 busy 结果，不抛异常。
- busy 结果不调用 `trackAgentRuntime(..., 'failed')`。
- busy 结果不启动 OpenCode，不写任务 workspace，不进入 OpenCode proxy。
- 活动任务结束后在 `finally` 清空 `activeAgentTask`。

### busy 返回结构

建议结构如下：

```json
{
  "success": false,
  "status": "busy",
  "skipped": true,
  "message": "Agent 正在处理其他任务，请耐心等待",
  "active_task": {
    "task_id": "...",
    "title": "...",
    "started_at": "...",
    "last_activity_at": "...",
    "stage": "running",
    "progress_text": "Agent 正在执行任务"
  }
}
```

### 调用方适配

现有业务调用方需要识别 `status === 'busy'`。

| 调用方 | 当前行为 | 适配要求 |
| --- | --- | --- |
| `OpenCodeAgentTestPage.tsx` | `!success` 会进入错误展示 | busy 时展示提示，不标红为系统异常 |
| `outlineGenerationTask.cjs` | Agent 目录修复失败会抛错 | busy 时返回明确业务提示，避免计入 Agent 失败统计 |
| `contentGenerationTask.cjs` | Agent 修复失败会尝试 partial output 恢复 | busy 时跳过本轮 Agent 修复，写日志提示正在执行其他 Agent 任务 |
| `agent:self-check` | 当前自检独立启动 Agent | busy 时返回自检结果 `success:false/status:error`，结论说明 Agent 正忙 |

### 统计口径

- 真实执行并完成：上报 `agent_runtime success`。
- 真实执行并异常：上报 `agent_runtime failed`。
- 忙碌跳过：不上报 `agent_runtime`。
- 用户主动暂停/取消：不建议计入 failed，可单独在开发者日志记录。

## 第二阶段：OpenCode 常驻子服务

### 新增服务

建议新增文件：

```text
client/electron/services/opencode/opencodeRuntimeService.cjs
```

职责：

- 管理唯一 OpenCode Server 进程。
- 管理唯一 OpenCode AI proxy。
- 管理唯一 OpenCode runtime root 和 cache root。
- 提供 `ensureStarted()`。
- 提供 `runTask(payload, options)`。
- 提供 `getStatus()`。
- 提供 `restart(reason)`。
- 提供 `close()`。
- 持续记录最近活动时间和最近进度摘要。

### 生命周期

| 时机 | 行为 |
| --- | --- |
| App 启动 | 不阻塞主窗口，异步预热 OpenCode runtime |
| 首次 Agent 调用 | 如果未启动，调用 `ensureStarted()` 同步启动 |
| 空闲状态 | 定期 health check |
| 运行状态 | 订阅事件、记录进度、刷新活动时间 |
| 配置变更 | 如果影响 OpenCode 配置，空闲时重启 runtime |
| 进程退出 | `app.before-quit` 调用 `close()` |
| OpenCode 崩溃 | 标记 unhealthy，当前任务失败，空闲后允许重启 |

### 工作目录隔离

当前实现以每个任务的 `workspaceDir` 作为 OpenCode Server 的 `cwd`，常驻模式需要重新处理隔离。

推荐验证并优先采用方案 A。

| 方案 | 说明 | 优先级 |
| --- | --- | --- |
| A | 常驻 OpenCode Server，调用 HTTP API 时通过 workspace routing query 指向每个任务 workspace | 高 |
| B | 常驻 OpenCode Server 固定 `cwd=agent-runtime/service/workspace`，每个任务写入 `tasks/<taskId>/` 子目录 | 中 |
| C | 保留每任务独立 OpenCode Server，只加单任务锁和活性监控 | 低 |

方案 A 需要先做技术验证：

- `POST /session` 是否能通过 query 参数指定目录。
- `POST /session/:id/message` 是否能在同一目录上下文执行工具。
- `GET /session/:id/diff` 是否能读取对应任务目录变更。
- OpenCode `Session.Info.directory` 是否等于任务 workspace。

如果方案 A 不稳定，先落方案 B。方案 B 需要在 prompt 中明确“只允许操作当前任务子目录”，并在输出读取时从 `tasks/<taskId>/<output_file>` 读取。

### 常驻 runtime 目录

建议目录：

```text
userData/
  agent-runtime/
    service/
      home/
      workspace/
      opencode.json
      state.json
  agent-cache/
    opencode-cache/
```

每个任务继续保留独立业务文件目录：

```text
userData/
  agent-runtime/
    tasks/
      <taskId>/
        workspace/
        result.json
```

如果最终选择方案 B，OpenCode 实际操作目录为 `service/workspace/tasks/<taskId>/`。

## Agent 状态模型

建议 runtime 维护统一状态：

```ts
type AgentRuntimePhase =
  | 'stopped'
  | 'starting'
  | 'idle'
  | 'running'
  | 'unhealthy'
  | 'restarting';
```

状态快照：

```json
{
  "phase": "running",
  "healthy": true,
  "message": "Agent 正在调用模型",
  "active_task": {
    "task_id": "...",
    "title": "全文一致性 Agent 修复",
    "stage": "model_request",
    "progress_text": "模型正在生成响应",
    "started_at": "2026-06-28T00:00:00.000Z",
    "last_activity_at": "2026-06-28T00:01:12.000Z",
    "last_progress_at": "2026-06-28T00:01:12.000Z",
    "idle_seconds": 3,
    "elapsed_seconds": 72
  },
  "proxy": {
    "active": 1,
    "queued": 0,
    "limit": 10
  },
  "opencode": {
    "base_url": "http://127.0.0.1:12345",
    "port": 12345,
    "last_health_at": "..."
  }
}
```

## 活性检测

### 活动信号

以下事件都视为 Agent 仍在工作：

- OpenCode Server stdout/stderr 有输出。
- OpenCode HTTP API 请求开始或结束。
- OpenCode `/event` 收到 session/message/part 更新。
- OpenCode `/session/status` 从 idle 变 busy 或 busy 状态持续有更新时间变化。
- AI proxy 收到 `/v1/chat/completions`。
- AI proxy 开始上游请求。
- AI proxy 收到上游响应头。
- AI proxy 流式响应收到 chunk。
- AI proxy 上游请求完成或失败。
- 输出文件 mtime 或大小发生变化。

### 活动记录接口

runtime 内部提供统一方法：

```js
touchActivity({ stage, message, source, meta })
```

字段含义：

| 字段 | 说明 |
| --- | --- |
| `stage` | 当前阶段，例如 `starting`、`session`、`model_request`、`tool`、`output` |
| `message` | 给用户看的短文本，例如 `模型正在生成响应` |
| `source` | 活动来源，例如 `opencode-event`、`proxy-stream`、`health` |
| `meta` | 开发者日志摘要，不写敏感内容 |

## 空闲超时

### 规则

- `timeout_ms` 语义改成“连续无活动超时时间”。
- 任务总运行时长不再触发超时。
- 只要持续有活动，就一直允许任务运行。
- 如果 `Date.now() - lastActivityAt >= timeout_ms`，判定 Agent 卡住并取消当前 session。
- 用户暂停、用户取消、业务任务取消仍然立即 abort。

### Watchdog

建议每 2 秒检查一次：

```js
function startActivityWatchdog({ timeoutMs, signal }) {
  const timer = setInterval(() => {
    if (signal.aborted) return;
    if (!activeTask) return;
    const idleMs = Date.now() - activeTask.lastActivityAt;
    if (idleMs >= timeoutMs) {
      abortCurrentTask(new Error('Agent 长时间无进展，已停止本轮任务'));
    }
  }, 2000);
  return () => clearInterval(timer);
}
```

### 单次上游请求超时

当前 `aiServiceOpenAiProxy.cjs` 对单次上游请求也使用绝对超时。常驻方案需要同步改为“流式活动续期”。

调整规则：

- 非流式请求仍保留单次请求超时。
- 流式请求收到任意 chunk 就刷新上游请求活动时间。
- 如果流式请求连续 `timeout_ms` 没有 chunk，才 abort 上游请求。
- 上游请求 abort 后，当前 Agent 任务进入失败诊断。

## 空闲健康检查

Agent 无任务时定期检查活性。

建议规则：

- 空闲时每 30 秒请求 OpenCode `/global/health`。
- 空闲时每 30 秒请求 AI proxy `/health`。
- health 失败一次只记录 `warning`。
- 连续 3 次失败标记 `unhealthy`。
- 标记 `unhealthy` 后不主动启动新任务，下一次 `runTask()` 先尝试重启。
- 如果重启失败，返回友好错误，计入真实 Agent 失败。

## 进度回传到前端

### IPC 增强

新增 IPC：

| Channel | 方向 | 说明 |
| --- | --- | --- |
| `agent:get-status` | Renderer invoke Main | 获取当前 Agent runtime 状态快照 |
| `agent:subscribe-status` | Renderer on Main | 订阅 Agent runtime 状态变化 |
| `agent:restart` | Renderer invoke Main | 开发者模式下手动重启 Agent 子服务 |

preload 增强：

```js
agent: {
  run: (payload) => ipcRenderer.invoke('agent:run', payload),
  getStatus: () => ipcRenderer.invoke('agent:get-status'),
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:status', listener);
    return () => ipcRenderer.removeListener('agent:status', listener);
  },
}
```

### 用户可见进度

前端只展示粗粒度状态：

| stage | 用户文案 |
| --- | --- |
| `starting` | 正在启动 Agent 服务 |
| `session` | 正在创建 Agent 会话 |
| `model_request` | Agent 正在调用模型 |
| `tool` | Agent 正在读取或修改任务文件 |
| `compaction` | Agent 正在整理上下文 |
| `output` | Agent 正在生成输出文件 |
| `idle_watch` | Agent 暂无任务，服务正常 |
| `stalled` | Agent 长时间无进展，正在停止本轮任务 |

不展示 prompt、输出正文、API Key、Base URL、本地完整路径。

## 常驻服务 API 设计

`opencodeRuntimeService.cjs` 对外建议暴露：

```js
function createOpenCodeRuntimeService({ app, configStore, mainWindow }) {
  return {
    ensureStarted,
    runTask,
    getStatus,
    restart,
    close,
    onStatus,
  };
}
```

`agentService.cjs` 调整后只做业务门面：

```js
function createAgentService({ app, configStore, mainWindow }) {
  const runtime = createOpenCodeRuntimeService({ app, configStore, mainWindow });
  return {
    runTask: (payload) => runtime.runTask(payload),
    selfCheck,
    exportSelfCheckReport,
    getStatus: () => runtime.getStatus(),
    onStatus: (listener) => runtime.onStatus(listener),
    close: () => runtime.close(),
  };
}
```

## 错误与忙碌返回

### 忙碌不是错误

busy 返回不 throw，不上报失败，不写错误日志。只写开发者日志 `agent.busy_skipped`。

```json
{
  "success": false,
  "status": "busy",
  "skipped": true,
  "message": "Agent 正在处理其他任务，请耐心等待"
}
```

### 真正失败

以下情况算真实失败：

- OpenCode binary 缺失。
- OpenCode Server 启动失败。
- OpenCode health 失败并重启失败。
- AI proxy 启动失败。
- 上游模型请求失败且无法恢复。
- Agent 执行异常退出。
- 输出文件读取失败且无 partial output 可恢复。

### 用户取消和业务暂停

建议不计入 `agent_runtime failed`。

原因：

- 用户取消不是 Agent 能力失败。
- 业务暂停是正常流程控制。
- 开发者日志需要记录，但 Analytics 成功率不应被污染。

## 配置变更策略

影响常驻 OpenCode 配置的字段：

- `base_url`
- `api_key`
- `model_name`
- `request_mode`
- `context_length_limit`
- `concurrency_limit`
- `developer_mode`

建议规则：

- `concurrency_limit` 可由 proxy 动态读取，不必重启。
- `api_key`、`base_url`、`model_name` 由 proxy 每次请求读取，也不必重启。
- `context_length_limit` 写入 OpenCode config，需要空闲重启才生效。
- `developer_mode` 可动态读取，不必重启。
- 如果运行中修改了需要重启的字段，标记 `restartPending`，任务结束后自动重启。

## 与现有业务任务的关系

### taskService

`taskService.cjs` 继续管理技术方案、废标项检查、查重等后台任务。

Agent 单任务锁不放进 `taskService` 的 `activeTasks` 中，原因：

- Agent 是跨业务共享子服务，不属于单个业务任务类型。
- Agent 可能被正文生成、目录修复、自检、开发测试页共同调用。
- 放入 `taskService` 会把跨业务互斥和业务任务互斥混在一起。

但 Agent 状态可以通过 `tasks:event` 之外的 `agent:status` 单独回传。

### contentGenerationTask

正文生成中的两个 Agent 修复是可选增强能力。

如果 Agent busy：

- 不抛系统错误。
- 写入业务日志：`Agent 正在处理其他任务，本轮跳过 Agent 修复`。
- 不修改正文结果。
- 不计入 Agent 失败统计。

### outlineGenerationTask

目录 Agent 修复通常是兜底能力。

如果 Agent busy：

- 返回业务可理解提示。
- 不计入 Agent 失败统计。
- 是否继续使用原有非 Agent 修复结果，由目录生成流程决定。

## 开发步骤

### 阶段一：单任务锁和忙碌返回

涉及文件：

```text
client/electron/services/agentService.cjs
client/electron/services/contentGenerationTask.cjs
client/electron/services/outlineGenerationTask.cjs
client/src/features/developer/pages/OpenCodeAgentTestPage.tsx
client/src/shared/types/ipc.ts
```

实施内容：

- 在 `createAgentService()` 内新增 `activeAgentTask`。
- 新增 `createAgentBusyResult(activeTask)`。
- `runTask()` 开头判断 busy 并直接 return。
- `runTask()` 真实执行时设置 active task，并在 `finally` 清空。
- busy 不调用 `trackAgentRuntime()`。
- 更新内部业务调用方识别 busy。
- 更新开发者测试页 busy 展示。

验收：

- 同时触发两个 Agent 调用，只有第一个启动 OpenCode。
- 第二个立即返回 `Agent 正在处理其他任务，请耐心等待`。
- Analytics 不增加 failed。
- 第一个任务结束后可以再次启动 Agent。

### 阶段二：状态订阅和粗粒度进度

涉及文件：

```text
client/electron/ipc/agentIpc.cjs
client/electron/preload.cjs
client/src/shared/types/ipc.ts
client/electron/services/agentService.cjs
client/electron/services/opencode/opencodeServerRunner.cjs
client/electron/services/opencode/aiServiceOpenAiProxy.cjs
client/electron/services/opencode/opencodeHttpClient.cjs
```

实施内容：

- 新增 Agent status snapshot。
- 新增 `agent:get-status`。
- 新增 `agent:status` 事件订阅。
- `onStage`、OpenCode 请求日志、AI proxy diagnostics 都调用 `touchActivity()`。
- AI proxy 流式 chunk 刷新活动时间。
- 前端测试页展示 `progress_text`、运行时长、空闲时长。

验收：

- Agent 执行时前端能看到阶段变化。
- 模型流式输出期间 `last_activity_at` 持续刷新。
- 输出文件变化能触发活动刷新。

### 阶段三：空闲超时替代绝对超时

涉及文件：

```text
client/electron/services/agentService.cjs
client/electron/services/opencode/aiServiceOpenAiProxy.cjs
```

实施内容：

- 把 `createTaskAbortController()` 调整为 activity watchdog。
- 保留父级 signal 立即 abort。
- `timeout_ms` 改为连续无活动阈值。
- AI proxy 流式请求改为 chunk 活动续期。
- 超时错误文案改为 `Agent 长时间无进展，已停止本轮任务`。

验收：

- 一个运行超过 `timeout_ms` 但持续有活动的 Agent 不会被取消。
- 一个无任何活动超过 `timeout_ms` 的 Agent 会被取消。
- 暂停和取消仍立即生效。

### 阶段四：常驻 runtime service

涉及文件：

```text
client/electron/services/opencode/opencodeRuntimeService.cjs
client/electron/services/opencode/opencodeServerRunner.cjs
client/electron/services/opencode/opencodeConfigFactory.cjs
client/electron/services/opencode/opencodeHttpClient.cjs
client/electron/services/agentService.cjs
client/electron/ipc/index.cjs
client/electron/main.cjs
```

实施内容：

- 新增常驻 runtime service。
- App 启动后异步预热 runtime。
- `agentService.runTask()` 改为调用 runtime。
- 空闲 health check。
- 运行中订阅 OpenCode `/event`。
- 配置变更后空闲重启。
- App 退出时关闭 runtime。

验收：

- App 启动后 OpenCode 子服务可进入 idle。
- 首个 Agent 任务不再重复启动 proxy 和 server。
- 多次 Agent 调用复用同一个子服务。
- OpenCode 崩溃后状态变 `unhealthy`，下次任务前可重启。

### 阶段五：自检复用和诊断完善

涉及文件：

```text
client/electron/services/agentService.cjs
client/src/features/settings/pages/SettingsPage.tsx
```

实施内容：

- 自检优先复用常驻 runtime。
- 自检报告增加 runtime phase、health、last_activity_at、idle_seconds。
- 增加“Agent 正忙”自检结论。
- 开发者模式增加手动重启 Agent 服务入口。

验收：

- 设置页 Agent 自检能反映常驻服务状态。
- 忙碌时自检不误判为 OpenCode 故障。
- 导出的自检报告包含常驻服务诊断。

## 验证计划

### 语法和构建

```powershell
cd client
node --check electron\services\agentService.cjs
node --check electron\services\opencode\aiServiceOpenAiProxy.cjs
node --check electron\services\opencode\opencodeServerRunner.cjs
node --check electron\services\opencode\opencodeHttpClient.cjs
node --check electron\preload.cjs
npm run build
```

新增常驻 service 后补充：

```powershell
cd client
node --check electron\services\opencode\opencodeRuntimeService.cjs
```

### 手动验证

- 设置页配置文本模型后运行 Agent 自检。
- 开发者测试页连续快速点击两次运行。
- 正文生成中触发 Agent 修复，同时打开开发者测试页运行 Agent。
- 设置很短 `timeout_ms`，确认持续流式输出不会被取消。
- 模拟模型无响应，确认空闲超时会取消。
- 修改 `context_length_limit`，确认空闲后 runtime 重启。
- 退出应用，确认 OpenCode 子进程和 proxy 端口释放。

### Analytics 验证

- 正常成功任务增加 success。
- 真实失败任务增加 failed。
- busy 返回不增加 success 或 failed。
- 用户暂停和取消不污染失败率。

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| OpenCode 不能稳定按请求切换目录 | 使用常驻总 workspace + 每任务子目录隔离 |
| 常驻进程长期运行后状态异常 | health check + 手动重启 + 崩溃自动标记 unhealthy |
| busy 返回导致现有业务误判失败 | 所有 Agent 调用点统一识别 `status === 'busy'` |
| 空闲超时误杀慢模型 | 以 proxy chunk、event、status、文件变化共同刷新 activity |
| 进度事件过于频繁 | 只在 stage 变化或每 2 秒节流发送状态 |
| 配置变更不生效 | 需要重启的字段标记 `restartPending`，空闲后重启 |

## 最小可交付版本

最小可交付版本只做第一阶段和第三阶段的核心能力：

- 单任务锁。
- busy 友好返回。
- busy 不计入失败。
- activity watchdog 替代绝对超时。
- AI proxy 流式 chunk 刷新活动。
- 开发者测试页展示 busy 和粗粒度进度。

这个版本已经能解决并发叠加和“正在工作也被超时取消”的主要问题。常驻 OpenCode 子服务可以作为第二个迭代继续推进。

## 最终推荐

推荐按以下顺序执行：

1. 先实现 Agent 单任务锁，忙碌时直接返回 `Agent 正在处理其他任务，请耐心等待`。
2. 再实现 Agent status 和 activity watchdog，让正在工作的 Agent 不被绝对超时取消。
3. 最后把 OpenCode Server/proxy 抽成常驻 runtime service，降低启动成本并统一监控。

这样可以最小风险地先解决当前并发超限问题，同时为后续常驻化保留清晰演进路径。
