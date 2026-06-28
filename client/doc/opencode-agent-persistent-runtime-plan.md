# OpenCode 常驻子服务与 Agent 单任务执行改造方案

版本：v1.1  
目标仓库：`FB208/OpenBidKit_Yibiao` / `client` Electron 桌面端  
方案目标：把 OpenCode 改造成跟主程序一起启动、长期存活、统一监控的常驻子服务；Agent 同一时间只执行一个任务；新请求在忙碌时直接友好跳过，不排队、不计失败。

---

## 1. 需求核对结论

| 需求 | 是否满足 | 本方案落点 |
| --- | --- | --- |
| OpenCode 做成常驻子服务，而不是每次使用才启动 | 满足 | 新增 `opencodeRuntimeService.cjs`，App 启动后预热，`agentService.runTask()` 不再启动/关闭 OpenCode |
| 跟主程序一起启动 | 满足 | `registerIpcHandlers()` 创建 `agentService` 后调用 `agentService.warmup()`，不阻塞主窗口 |
| 每次只执行一个 Agent 任务 | 满足 | runtime 内维护 `activeTask` 单槽锁 |
| 多任务请求时直接抛弃新 Agent 任务 | 满足 | busy 时立即 return，不进入 workspace、不调用 OpenCode、不排队等待 |
| busy 不算报错 | 满足 | `status:'busy'`、`skipped:true`，不上报 `agent_runtime failed` |
| busy 友好提示 | 满足 | 固定返回：`Agent 正在处理其他任务，请耐心等待` |
| Agent 空闲时定期检查活性 | 满足 | idle health timer 检查 OpenCode `/global/health` 和 proxy `/health` |
| Agent 有任务时记录实时进度 | 满足 | `touchActivity()` 统一记录阶段、进度文案、最近活动时间 |
| 正在工作就永远不超时 | 满足 | `timeout_ms` 改为“连续无活动超时”，不再是总运行时长 |
| 只在卡住时停止 | 满足 | watchdog 只看 `Date.now() - lastActivityAt` |
| 简单返回 Agent 进度到前端 | 满足 | 新增 `agent:get-status` 和 `agent:status` 事件 |

重要修正：本次改版不再保留“先单任务锁、以后再常驻”的路线。**常驻 runtime 是本次最小可交付范围的一部分**。任何实现都不得回退到“每个任务启动一套 OpenCode Server”。

v1.1 关键修正：常驻 OpenCode 的 `cwd` 根目录在进程存活期间不得删除、重命名或重新创建；workspace 清理只能删除根目录下的子项。App 退出不能在 `before-quit` 中 fire-and-forget 调用 `closeServices()`，必须阻止默认退出并等待 runtime close 完成。任务 activity 必须绑定当前任务上下文，迟到事件不能刷新下一轮任务；OpenCode stdout/stderr 默认只作为诊断信息，不刷新 watchdog activity。

---

## 2. 当前问题定位

当前项目里 Agent 的生命周期绑定在单次任务上，主要问题如下：

1. `agentService.runTask()` 每次创建任务目录、启动 OpenCode Server、执行任务、最后关闭 Server。
2. 旧隔离启动函数使用任务 workspace 作为 OpenCode 进程 `cwd`。
3. 每次启动 OpenCode Server 时都会启动一套新的 OpenCode AI proxy。
4. 每套 proxy 内部都有自己的 `createOpenCodeTextQueue()`，因此多个 Agent 并发时，文本模型并发限制会按 Agent 数量叠加。
5. `timeout_ms` 当前是绝对超时，任务即使持续有进展，也可能到点被取消。
6. `agent:self-check` 当前也会独立启动一套 OpenCode Server，和常驻 runtime 的目标冲突。
7. 前端没有 Agent runtime 状态订阅能力，只能看到最终成功或失败。

本方案通过一个 app-level runtime owner 解决这些问题。

---

## 3. 总体架构

### 3.1 改造后调用链

```text
Electron App 启动
  ↓
registerIpcHandlers()
  ↓
createAgentService()
  ↓
createOpenCodeRuntimeService()
  ↓
agentService.warmup()
  ↓
常驻 OpenCode AI proxy + 常驻 OpenCode Server 启动并进入 idle

Renderer / 业务服务
  ↓ window.yibiao.agent.run(payload)
agent:run IPC
  ↓
agentService.runTask()
  ↓
opencodeRuntimeService.runTask()
  ↓
检查 activeTask 单槽锁
  ├─ busy：直接返回友好提示，不启动任务
  └─ idle：清空 staging workspace 子项，写入当前任务文件，创建 session，执行 message，读取输出，归档 workspace
```

### 3.2 新增核心模块

新增文件：

```text
client/electron/services/opencode/opencodeRuntimeService.cjs
```

它是常驻 OpenCode 子服务的唯一 owner，负责：

- 启动和持有唯一 OpenCode Server 子进程。
- 启动和持有唯一 OpenCode AI proxy。
- 管理 OpenCode runtime root、service workspace、任务归档目录。
- 执行单任务锁。
- 维护 runtime 状态快照。
- 维护 activity watchdog。
- 管理 idle health check。
- 管理 restart 和 close。
- 向 `agentService` 暴露统一 API。

### 3.3 `agentService.cjs` 改造原则

`agentService.cjs` 不再拥有 OpenCode 进程生命周期，只作为业务门面：

```js
function createAgentService({ app, configStore, mainWindow }) {
  const runtime = createOpenCodeRuntimeService({ app, configStore, mainWindow });

  return {
    warmup: () => runtime.warmup(),
    runTask: (payload) => runtime.runTask(payload),
    selfCheck: () => runtime.runSelfCheck(),
    getStatus: () => runtime.getStatus(),
    restart: (reason) => runtime.restart(reason || 'manual'),
    onStatus: (listener) => runtime.onStatus(listener),
    exportSelfCheckReport,
    close: () => runtime.close(),
  };
}
```

---

## 4. Runtime 目录设计

### 4.1 目录结构

采用 **single-staging-cwd** 作为默认方案，避免同一 OpenCode cwd 下暴露多个历史任务目录。

```text
userData/
  agent-runtime/
    service/
      home/
      workspace/              # OpenCode 常驻 cwd，任一时刻只放当前任务文件
      opencode.json
      state.json
      logs/
    tasks/
      <taskId>/
        workspace/            # 任务完成后归档，不在 OpenCode cwd 下
        result.json
        diagnostics.json
  agent-cache/
    opencode-cache/
```

### 4.2 为什么不用 `service/workspace/tasks/<taskId>`

如果 OpenCode cwd 是 `service/workspace`，并且多个任务目录都放在 `service/workspace/tasks/<taskId>`，OpenCode 的读文件权限、grep、cat、find、rg 等工具可能读取兄弟任务目录。Prompt 不能作为隔离边界。

本方案默认让 OpenCode cwd 永远只有一个 staging workspace：

```text
service/workspace/
  当前任务输入文件
  当前任务输出文件
```

任务结束后再复制到：

```text
agent-runtime/tasks/<taskId>/workspace/
```

这样既保持 OpenCode 常驻，又避免跨任务文件泄漏。

### 4.3 可选增强：per-session directory

如果后续验证 OpenCode HTTP API 明确支持 session 级 directory，可以增加：

```js
workspaceStrategy: 'session_directory'
```

但它不能作为本次基础路径的前置条件。基础路径必须在 OpenCode 不支持按 session 切目录时仍然成立，也就是 single-staging-cwd。

---

## 5. Runtime 状态模型

### 5.1 phase 定义

```ts
type AgentRuntimePhase =
  | 'stopped'
  | 'starting'
  | 'idle'
  | 'running'
  | 'aborting'
  | 'unhealthy'
  | 'restarting'
  | 'closing';
```

### 5.2 状态快照结构

```json
{
  "phase": "running",
  "healthy": true,
  "message": "Agent 正在调用模型",
  "updated_at": "2026-06-28T00:00:00.000Z",
  "last_health_at": "2026-06-28T00:00:00.000Z",
  "last_health_error": "",
  "restart_pending": false,
  "active_task": {
    "task_id": "...",
    "title": "全文一致性 Agent 修复",
    "stage": "model_request",
    "progress_text": "Agent 正在调用模型",
    "started_at": "2026-06-28T00:00:00.000Z",
    "last_activity_at": "2026-06-28T00:01:12.000Z",
    "last_progress_at": "2026-06-28T00:01:12.000Z",
    "elapsed_seconds": 72,
    "idle_seconds": 3
  },
  "proxy": {
    "active": 1,
    "queued": 0,
    "limit": 10
  },
  "opencode": {
    "pid": 12345,
    "base_url": "http://127.0.0.1:12345",
    "port": 12345,
    "last_exit_code": null,
    "last_exit_signal": ""
  }
}
```

对普通前端隐藏：

- OpenCode auth header。
- proxy token。
- API Key。
- 完整本地路径。
- prompt 和模型返回正文。

开发者模式可以展示端口、pid、runtime root 摘要，但不能展示 secret。

---

## 6. 单任务执行规则

### 6.1 行为规则

- runtime 内维护 `activeTask`。
- `runTask()` 进入时先检查 `activeTask`。
- 如果已有任务处于 `running` 或 `aborting`，立即返回 busy。
- busy 不抛异常。
- busy 不排队等待。
- busy 不启动 session。
- busy 不写 workspace。
- busy 不调用 OpenCode。
- busy 不上报 `agent_runtime failed`。
- 当前任务结束后才允许下一次任务执行。

### 6.2 busy 返回结构

```json
{
  "success": false,
  "status": "busy",
  "skipped": true,
  "message": "Agent 正在处理其他任务，请耐心等待",
  "active_task": {
    "task_id": "...",
    "title": "...",
    "stage": "model_request",
    "progress_text": "Agent 正在调用模型",
    "started_at": "...",
    "last_activity_at": "...",
    "elapsed_seconds": 120,
    "idle_seconds": 4
  }
}
```

### 6.3 busy 统计口径

| 场景 | Analytics |
| --- | --- |
| 任务真实执行成功 | `agent_runtime success` |
| 任务真实执行失败 | `agent_runtime failed` |
| busy 跳过 | 不上报 |
| 用户暂停/取消 | 不上报 failed |
| activity watchdog 判定卡死 | 真实失败，可上报 failed |
| runtime 启动失败 | 真实失败，可上报 failed |

---

## 7. 常驻启动和关闭

### 7.1 App 启动预热

在 `registerIpcHandlers()` 中创建 `agentService` 后，把它返回给 `main.cjs` 或在注册完成后触发 warmup。

推荐：

```js
function registerIpcHandlers(...) {
  const agentService = createAgentService({ app, configStore, mainWindow });

  registerAgentIpc({ agentService, mainWindow });

  setTimeout(() => {
    void agentService.warmup().catch((error) => {
      console.warn('[agent] warmup failed', error?.message || String(error));
    });
  }, 500);

  return {
    closeServices: async () => {
      await agentService.close();
    },
  };
}
```

`warmup()` 失败不应阻塞主窗口。失败后 runtime 状态为 `unhealthy`，下一次 `runTask()` 先尝试 restart。

### 7.2 首次任务兜底启动

即使预热失败或尚未完成，`runTask()` 也要调用：

```js
await ensureStarted();
```

如果已有 `startPromise`，复用同一个 promise，不重复启动。

### 7.3 App 退出关闭

`main.cjs` 中保存 `registerIpcHandlers()` 的返回值：

```js
let services = null;
let appQuitting = false;
let closeBeforeQuitStarted = false;
let quitAfterClose = false;

app.whenReady().then(() => {
  services = registerIpcHandlers(...);
});

async function closeServicesBeforeQuit(event) {
  if (quitAfterClose) return;

  event?.preventDefault?.();
  if (closeBeforeQuitStarted) return;

  closeBeforeQuitStarted = true;
  appQuitting = true;
  try {
    await services?.closeServices?.();
  } catch (error) {
    console.warn('[agent] close before quit failed', error?.message || String(error));
  }

  quitAfterClose = true;
  app.quit();
}

app.on('before-quit', (event) => {
  void closeServicesBeforeQuit(event);
});
```

退出规则：

- 不能只在 `before-quit` 中 `void services?.closeServices?.()`；Electron 不会等待这个 Promise，Windows 下容易残留 OpenCode 子进程或 proxy 端口。
- `closeServicesBeforeQuit()` 必须幂等，多次退出请求只执行一次 close。
- `app.relaunch()`、`app.exit(0)`、`quitAndInstall()`、GPU fallback relaunch、更新安装等主动退出路径，都必须先走同一个 close wrapper，再执行真正的 relaunch/install/exit 动作。
- 如果某条路径必须调用 `app.exit()`，也必须在调用前 `await services?.closeServices?.()`，不能依赖 `before-quit` 兜底。

`runtime.close()` 必须：

1. 标记 `phase='closing'`。
2. 停止 health timer。
3. 停止 status timer。
4. 中止 active task。
5. 停止接受 proxy 新请求。
6. 关闭 OpenCode Server 子进程。
7. 关闭 proxy HTTP server。
8. 超时后强制 kill/destroy sockets。
9. 标记 `phase='stopped'`。

---

## 8. OpenCode sidecar 启动改造

### 8.1 拆分原隔离启动逻辑

原函数当前按任务启动。建议改造为两个层次：

```text
opencodeServerRunner.cjs
  ├─ startOpenCodeSidecar()       # 启动常驻 OpenCode Server + AI proxy
  ├─ waitForOpenCodeHealth()
  ├─ closeOpenCodeSidecar()
  └─ 旧隔离启动逻辑删除
```

`startOpenCodeSidecar()` 输入：

```js
{
  app,
  configStore,
  runtimeRoot,
  workspaceDir,
  diagnostics,
  onStage,
  onActivity,
  getActivityContext,
  onExit
}
```

输出：

```js
{
  baseUrl,
  authHeader,
  port,
  child,
  pid,
  runtimeRoot,
  workspaceDir,
  aiProxy,
  requestLog,
  getStderrTail(size),
  getStdoutTail(size),
  getProxyStatus(),
  close()
}
```

### 8.2 spawn cwd 固定为 service workspace

```js
child = spawn(opencodeBin, [
  'serve',
  '--pure',
  '--hostname', '127.0.0.1',
  '--port', String(port),
], {
  cwd: serviceWorkspaceDir,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

其中 `serviceWorkspaceDir` 是：

```text
userData/agent-runtime/service/workspace
```

这个目录是常驻 OpenCode 进程的 `cwd`，进程存活期间只能清空其子项，不能删除、重命名或重新创建目录根本身。Windows 下删除运行中进程的 `cwd` 根目录容易触发 `EPERM`、`EBUSY` 或残留句柄，必须从设计上禁止。

### 8.3 运行中 crash 处理

`child.once('exit')` 不只在启动前处理。健康检查通过后退出也必须通知 runtime：

```js
child.once('exit', (code, signal) => {
  onExit?.({ code, signal, stdoutTail, stderrTail });
});
```

runtime 行为：

| 状态 | OpenCode 退出后的处理 |
| --- | --- |
| `starting` | 启动失败 |
| `idle` | 标记 `unhealthy`，下次任务前重启 |
| `running` | 当前任务失败，进入 `unhealthy`，清空 staging workspace 子项但保留 cwd 根目录 |
| `closing` | 正常关闭 |

---

## 9. Workspace 执行流程

### 9.1 任务开始

```js
function clearDirectoryContents(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
}

async function prepareStagingWorkspace(payload) {
  clearDirectoryContents(serviceWorkspaceDir);
  writeWorkspaceFiles(serviceWorkspaceDir, payload.files || []);
}
```

规则：

- `serviceWorkspaceDir` 任一时刻只包含当前任务文件。
- `serviceWorkspaceDir` 是常驻 OpenCode 进程的 `cwd` 根目录，runtime 存活期间禁止 `fs.rmSync(serviceWorkspaceDir, { recursive: true })`、禁止 rename、禁止删除后重建。
- 清理只删除 `serviceWorkspaceDir` 下的子文件和子目录；清理失败不能静默继续复用脏 workspace，应停止本轮任务并进入可诊断状态。
- `safeRelativePath()` 继续保留，禁止 `..`、OpenCode 指令文件、`.opencode/` 等保留路径。
- `output_file` 也必须用 `safeRelativePath()` 校验。

### 9.2 执行 OpenCode session

```js
const session = await createSession(sidecar, title, { signal, onActivity });
const messageResult = await sendPrompt(sidecar, session.id, prompt, {
  signal,
  agent: payload.agent || 'build',
  onActivity,
});
const diff = await getSessionDiff(sidecar, session.id, { signal }).catch(() => []);
```

### 9.3 输出读取

任务输出只从 staging workspace 读取：

```js
const output = readOutputContent(serviceWorkspaceDir, outputFile);
```

### 9.4 任务归档

任务结束后复制 staging workspace 到：

```text
agent-runtime/tasks/<taskId>/workspace
```

并写诊断：

```text
agent-runtime/tasks/<taskId>/diagnostics.json
```

返回给调用方：

```json
{
  "success": true,
  "task_id": "...",
  "workspace_dir": "归档 workspace 路径",
  "runtime_workspace_dir": "可隐藏或仅开发者模式展示",
  "output_file": "...",
  "output_content": "...",
  "assistant_text": "...",
  "diff": [],
  "session_id": "..."
}
```

### 9.5 任务结束清理

默认任务结束后清空 `service/workspace` 的子项，但保留 `service/workspace` 根目录作为常驻 cwd。任务现场统一归档到 `agent-runtime/tasks/<taskId>/workspace/`，不再暴露保留临时 runtime 的任务参数。

---

## 10. Activity 与进度机制

### 10.1 统一入口

runtime 提供：

```js
function createTaskActivity(activeTaskRef) {
  const taskToken = activeTaskRef.activity_token;
  return (event = {}) => touchActivity({ ...event, task_token: taskToken });
}

function touchActivity({ stage, message, source, meta = {}, visible = true, task_token: taskToken }) {
  if (!activeTask) return;
  if (!taskToken || taskToken !== activeTask.activity_token) {
    appendRuntimeEvent({ at: new Date().toISOString(), stage, message, source, meta, stale: true });
    return;
  }

  const now = new Date().toISOString();
  activeTask.last_activity_at = now;

  if (visible) {
    activeTask.stage = stage || activeTask.stage;
    activeTask.progress_text = message || activeTask.progress_text;
    activeTask.last_progress_at = now;
  }

  appendRuntimeEvent({ at: now, stage, message, source, meta });
  emitStatusThrottled();
}
```

规则：

- 每个 active task 创建时生成 `activity_token`，所有属于本任务的异步 activity 都必须携带该 token。
- `createTaskActivity(activeTask)` 返回的 scoped callback 传给 OpenCode HTTP client。
- proxy 在收到 `/v1/chat/completions` 时读取一次当前 task context，并把同一个 `task_token` 绑定到该请求后续的 queued、headers、chunk、completed、failed 事件。
- 任何迟到事件如果没有匹配当前 `activeTask.activity_token`，只能写 runtime event 诊断，不能刷新 `last_activity_at` 或用户可见进度。

### 10.2 活动来源

| 来源 | 是否刷新 activity | 是否更新用户可见进度 |
| --- | --- | --- |
| OpenCode session 创建开始/成功/失败 | 是 | 是 |
| OpenCode message 发送开始/成功/失败 | 是 | 是 |
| OpenCode diff 读取 | 是 | 是 |
| AI proxy 收到 chat completion | 是 | 是 |
| AI proxy upstream started | 是 | 是 |
| AI proxy upstream headers | 是 | 是 |
| AI proxy stream chunk | 是 | 节流更新 |
| AI proxy upstream completed/failed | 是 | 是 |
| 输出文件 mtime/size 变化 | 是 | 是 |
| OpenCode stdout/stderr | 否，默认只进诊断 | 否 |
| idle health check | 否 | 否 |

注意：idle health check 不能刷新 active task activity，否则会掩盖任务卡死。

注意：OpenCode stdout/stderr 不能默认刷新 active task activity。常驻进程可能在卡住时持续打印日志，如果把 stdout/stderr 当作进展，会让 watchdog 永远无法判定 stalled。只有后续明确解析到 OpenCode 结构化工具事件时，才可以把该事件作为任务 activity。

### 10.3 用户可见 stage

| stage | 用户文案 |
| --- | --- |
| `starting` | 正在启动 Agent 服务 |
| `workspace` | 正在准备 Agent 工作目录 |
| `session` | 正在创建 Agent 会话 |
| `message` | Agent 正在执行任务 |
| `model_request` | Agent 正在调用模型 |
| `model_stream` | 模型正在生成响应 |
| `tool` | Agent 正在读取或修改任务文件 |
| `output` | 正在读取 Agent 输出 |
| `archive` | 正在保存 Agent 任务现场 |
| `idle_watch` | Agent 服务空闲，状态正常 |
| `stalled` | Agent 长时间无进展，正在停止本轮任务 |
| `aborting` | 正在取消 Agent 任务 |
| `restarting` | 正在重启 Agent 服务 |

---

## 11. 无活动超时设计

### 11.1 语义变更

`timeout_ms` 不再表示总运行时长，改为：

> 当前 Agent 任务连续多久没有任何 activity 后，判定卡住。

默认值建议：

```js
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
```

用户传入的 `payload.timeout_ms` 继续支持，但解释为 idle timeout。

### 11.2 Watchdog

```js
function startActivityWatchdog({ timeoutMs, abort }) {
  const timer = setInterval(() => {
    if (!activeTask) return;
    const idleMs = Date.now() - new Date(activeTask.last_activity_at).getTime();
    if (idleMs >= timeoutMs) {
      touchActivity({
        stage: 'stalled',
        message: 'Agent 长时间无进展，正在停止本轮任务',
        source: 'watchdog',
        task_token: activeTask.activity_token,
      });
      abort(new Error('Agent 长时间无进展，已停止本轮任务'));
    }
  }, 2000);

  return () => clearInterval(timer);
}
```

### 11.3 永不按总时长取消

禁止再使用类似：

```js
setTimeout(() => abort(...), timeoutMs)
```

作为 Agent 总任务超时。

只要有以下活动，就持续运行：

- 模型流式 chunk。
- OpenCode 工具事件。
- OpenCode HTTP request 进展。
- 输出文件变化。
- 其他明确任务活动。

不计入 watchdog activity 的来源：

- idle health check。
- OpenCode stdout/stderr 普通日志。
- 没有匹配当前 `activity_token` 的迟到 proxy 或 HTTP 事件。

### 11.4 abort 后的 runtime 状态

如果 OpenCode 没有可靠 cancel API，或者 cancel 后不能确认 session 已停止，必须重启常驻 runtime：

```text
running -> aborting -> restarting -> idle
```

不能直接：

```text
running -> aborting -> idle
```

原因：旧 session 可能仍在 OpenCode 内部运行，继续写 staging workspace，污染下一次任务。

---

## 12. OpenCode HTTP client 改造

### 12.1 `requestJson()` 增加 activity hook

文件：

```text
client/electron/services/opencode/opencodeHttpClient.cjs
```

改造：

```js
async function requestJson(server, routePath, options = {}) {
  options.onActivity?.({
    stage: options.stage || 'opencode_request',
    message: options.progressText || `正在请求 OpenCode：${routePath}`,
    source: 'opencode-http',
    meta: { route: routePath, method },
  });

  // fetch...

  options.onActivity?.({
    stage: options.successStage || options.stage || 'opencode_request',
    message: options.successText || `OpenCode 请求完成：${routePath}`,
    source: 'opencode-http',
    meta: { route: routePath, status: response.status },
  });
}
```

### 12.2 `createSession()`、`sendPrompt()`、`getSessionDiff()` 传 stage

```js
async function createSession(server, title, options = {}) {
  return requestJson(server, '/session', {
    method: 'POST',
    signal: options.signal,
    onActivity: options.onActivity,
    stage: 'session',
    progressText: '正在创建 Agent 会话',
    successText: 'Agent 会话已创建',
    body: { title: title || 'Yibiao Agent Task' },
  });
}
```

`sendPrompt()`：

```js
stage: 'message',
progressText: 'Agent 正在执行任务',
successText: 'Agent 任务执行完成'
```

`getSessionDiff()`：

```js
stage: 'output',
progressText: '正在读取 Agent 修改结果'
```

---

## 13. AI proxy 改造

### 13.1 文件

```text
client/electron/services/opencode/aiServiceOpenAiProxy.cjs
```

### 13.2 新增参数

```js
function createAiServiceOpenAiProxy({
  app,
  configStore,
  timeoutMs,
  diagnostics,
  onActivity,
  getActivityContext,
})
```

### 13.3 proxy activity

在以下位置调用 `onActivity`：

- 收到 `/v1/chat/completions`。
- 请求进入 textQueue。
- upstream started。
- upstream headers。
- upstream completed。
- upstream failed。
- SSE stream chunk。
- client aborted/closed。

示例：

```js
const activityContext = getActivityContext?.() || null;

onActivity?.({
  stage: 'model_request',
  message: 'Agent 正在调用模型',
  source: 'proxy.upstream.started',
  task_token: activityContext?.task_token,
  meta: { request_id: requestId, attempt },
});
```

常驻 proxy 绑定规则：

- `getActivityContext()` 在每个 `/v1/chat/completions` 请求开始时调用一次，返回当前 `activeTask` 的 `task_token`、`task_id` 等摘要。
- 同一个 proxy 请求后续的 queued、upstream started、headers、stream chunk、completed、failed、client aborted/closed 都携带同一个 `task_token`。
- 不能在每个 chunk 时重新读取当前 active task，否则旧 stream 的迟到 chunk 可能刷新下一轮任务的 watchdog。
- 无 active task 或 token 不匹配时，proxy event 仍可进入 diagnostics，但不能刷新 runtime activity。

### 13.4 修复流式超时

当前流式请求存在一个关键问题：上游 `fetch()` 返回 headers 后，`prepareProxyResponse()` 返回 `Response`，随后 `finally` 清理 timeout；真正的 stream 读取发生在后面的 pipe 中。因此不能只靠当前 `createTimeoutSignal()`。

改造思路：

- 非流式请求保留普通请求超时。
- 流式请求使用 idle timeout。
- 每个 chunk 调用 `touch()`。
- 连续超过 `timeout_ms` 没有 chunk 才 abort。

示例接口：

```js
function createIdleTimeoutController(parentSignal, timeoutMs, message) {
  const controller = new AbortController();
  let timer = null;

  function reset() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort(new Error(message || 'AI 流式响应长时间无数据'));
    }, timeoutMs);
  }

  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error('请求已取消'));

  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }

  reset();

  return {
    signal: controller.signal,
    touch: reset,
    clear() {
      clearTimeout(timer);
      if (parentSignal) {
        try { parentSignal.removeEventListener('abort', abortFromParent); } catch {}
      }
    },
  };
}
```

`createUsageCapturingStream()` 增加：

```js
function createUsageCapturingStream(source, onDone, options = {}) {
  const { onChunk, onActivity } = options;
  // ...
  if (value) {
    onChunk?.(value);
    onActivity?.({
      stage: 'model_stream',
      message: '模型正在生成响应',
      source: 'proxy.stream.chunk',
      visible: true,
    });
  }
}
```

`pipeWebStreamToNode()` 也增加 chunk hook：

```js
async function pipeWebStreamToNode(webStream, res, options = {}) {
  // 每次 res.write 前 options.onChunk?.(value)
}
```

### 13.5 proxy 队列状态

`createOpenCodeTextQueue()` 增加：

```js
return {
  enqueue,
  getStatus() {
    return {
      active: activeCount,
      queued: queue.length,
      limit: currentLimit(),
    };
  },
  clearQueued(reason) {
    while (queue.length) {
      const job = queue.shift();
      job.reject(reason || new Error('Agent proxy 队列已清空'));
    }
  },
};
```

proxy 对外暴露：

```js
getStatus() {
  return textQueue.getStatus();
}
```

### 13.6 proxy close 强化

当前 `server.close()` 等待连接自然结束，常驻重启时可能挂住。需要 socket tracking：

```js
const sockets = new Set();

server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

async function close({ forceAfterMs = 2000 } = {}) {
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      for (const socket of sockets) {
        try { socket.destroy(); } catch {}
      }
      resolve();
    }, forceAfterMs);

    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
```

---

## 14. 空闲健康检查

### 14.1 规则

- runtime `phase === 'idle'` 时，每 30 秒检查一次。
- 检查 OpenCode `/global/health`。
- 检查 proxy `/health`。
- 成功后更新 `last_health_at`。
- 失败一次记录 warning。
- 连续 3 次失败标记 `unhealthy`。
- idle 下可自动尝试 restart 一次。
- running 下不做会影响 active task 的 health restart。

### 14.2 不刷新任务 activity

health check 不调用 active task 的 `touchActivity()`。空闲 health 只更新 runtime health，不说明当前任务有进展。

---

## 15. 取消、暂停与卡死处理

### 15.1 用户取消或业务暂停

父级 `signal` abort 时：

1. runtime 进入 `aborting`。
2. 尝试取消当前 OpenCode session。
3. 如果取消 API 不可靠或不存在，标记 `restartRequiredAfterAbort = true`。
4. 不计入 `agent_runtime failed`。
5. 返回或抛给业务层时保留原暂停语义。

### 15.2 Watchdog 卡死

连续无活动超过 `timeout_ms`：

1. runtime 进入 `aborting`。
2. abort 当前任务。
3. 记录 `stage='stalled'`。
4. 如果不能确认 session 停止，则重启 runtime。
5. 计入真实失败，便于稳定性统计。

### 15.3 不允许旧 session 污染下一任务

任务异常结束后，下一任务开始前必须满足：

- `activeTask === null`。
- `phase === 'idle'`。
- `service/workspace` 根目录仍存在，且目录子项已清空。
- 如果上次 abort 不可靠，OpenCode 已 restart。

---

## 16. IPC 与 preload 改造

### 16.1 `agentIpc.cjs`

新增：

```js
function registerAgentIpc({ agentService, mainWindow }) {
  ipcMain.handle('agent:run', async (_event, payload) => agentService.runTask(payload));
  ipcMain.handle('agent:self-check', async () => agentService.selfCheck());
  ipcMain.handle('agent:export-self-check-report', async (_event, payload) => agentService.exportSelfCheckReport(payload));
  ipcMain.handle('agent:get-status', async () => agentService.getStatus());
  ipcMain.handle('agent:restart', async (_event, reason) => agentService.restart(reason || 'manual'));

  agentService.onStatus((status) => {
    if (!mainWindow?.isDestroyed?.()) {
      mainWindow.webContents.send('agent:status', status);
    }
  });
}
```

### 16.2 `preload.cjs`

```js
agent: {
  run: (payload) => ipcRenderer.invoke('agent:run', payload),
  selfCheck: () => ipcRenderer.invoke('agent:self-check'),
  exportSelfCheckReport: (payload) => ipcRenderer.invoke('agent:export-self-check-report', payload),
  getStatus: () => ipcRenderer.invoke('agent:get-status'),
  restart: (reason) => ipcRenderer.invoke('agent:restart', reason),
  onStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:status', listener);
    return () => ipcRenderer.removeListener('agent:status', listener);
  },
}
```

### 16.3 类型文件

更新：

```text
client/src/shared/types/ipc.ts
```

增加：

```ts
type AgentRuntimeStatus = {
  phase: 'stopped' | 'starting' | 'idle' | 'running' | 'aborting' | 'unhealthy' | 'restarting' | 'closing';
  healthy: boolean;
  message: string;
  updated_at: string;
  active_task?: {
    task_id: string;
    title: string;
    stage: string;
    progress_text: string;
    started_at: string;
    last_activity_at: string;
    elapsed_seconds: number;
    idle_seconds: number;
  } | null;
  proxy?: {
    active: number;
    queued: number;
    limit: number;
  };
};

interface Window {
  yibiao: {
    agent: {
      run(payload: AgentRunPayload): Promise<AgentRunResult>;
      selfCheck(): Promise<AgentSelfCheckResult>;
      exportSelfCheckReport(payload: unknown): Promise<unknown>;
      getStatus(): Promise<AgentRuntimeStatus>;
      restart(reason?: string): Promise<AgentRuntimeStatus>;
      onStatus(callback: (status: AgentRuntimeStatus) => void): () => void;
    };
  };
}
```

---

## 17. 前端展示建议

### 17.1 开发者测试页

文件：

```text
client/src/features/developer/pages/OpenCodeAgentTestPage.tsx
```

展示：

- runtime phase。
- healthy。
- active task title。
- progress_text。
- elapsed_seconds。
- idle_seconds。
- proxy active/queued/limit。
- restartPending。
- 手动 restart 按钮。

busy 时：

- 不使用错误红色样式。
- 显示黄色/提示态：
  ```text
  Agent 正在处理其他任务，请耐心等待
  ```
- 展示当前 active task 的 progress_text 和 elapsed_seconds。

### 17.2 业务页面

正文生成、目录生成等业务流程中，如果 Agent busy：

- 不弹系统错误。
- 写业务日志：
  ```text
  Agent 正在处理其他任务，本轮跳过 Agent 修复。
  ```
- 不把该小节或整个任务标记为系统失败，除非 Agent 是该流程不可替代的必需步骤。

---

## 18. self-check 改造

### 18.1 原则

`agent:self-check` 必须复用常驻 runtime，不能独立启动第二套 OpenCode Server。

### 18.2 忙碌时 self-check

如果 `activeTask` 存在：

```json
{
  "success": false,
  "status": "busy",
  "message": "Agent 正在处理其他任务，请耐心等待",
  "conclusion": "Agent 子服务正在执行任务，自检已跳过；这不是 OpenCode 故障。",
  "runtime_status": { "...": "..." }
}
```

### 18.3 空闲时 self-check

空闲时自检作为一个普通 Agent 任务执行，但使用内部 self-check title 和 output file：

```js
runtime.runTask({
  task_id: 'agent-self-check-latest',
  title: '易标智能体自检',
  output_file: 'agent-self-check-result.json',
  files: [{ path: 'self-check-input.txt', content: 'YIBIAO_AGENT_SELF_CHECK_INPUT' }],
  prompt: buildSelfCheckPrompt(),
  timeout_ms: SELF_CHECK_TIMEOUT_MS,
  onActivity: handleSelfCheckActivity,
});
```

自检报告增加：

- runtime phase。
- OpenCode pid。
- OpenCode port。
- proxy port。
- last_health_at。
- last_activity_at。
- idle_seconds。
- restart_pending。
- proxy active/queued/limit。
- 最近 health 错误。
- 最近 OpenCode exit code/signal。

---

## 19. 配置变更策略

### 19.1 动态生效字段

这些字段由 proxy 每次请求时读取 `configStore.load()`，可以动态生效：

- `api_key`
- `base_url`
- `model_name`
- `concurrency_limit`
- `developer_mode`

### 19.2 需要重启 runtime 的字段

这些字段写入 OpenCode config 或影响 OpenCode provider 能力，需要 runtime 重启：

- `context_length_limit`
- OpenCode binary version。
- OpenCode provider config 结构变更。

如果运行中变更：

```js
runtime.markRestartPending('context_length_limit changed');
```

当 active task 结束并进入 idle 后自动重启。

### 19.3 不把 `payload.timeout_ms` 写进 OpenCode config

`payload.timeout_ms` 是 Agent activity idle timeout，不应写入 OpenCode provider timeout。Provider timeout 使用较大的固定值或单独配置项，避免和“任务是否卡住”的判断混在一起。

---

## 20. 业务调用方适配

### 20.1 `contentGenerationTask.cjs`

涉及 Agent 的一致性修复、原方案覆盖修复等位置。

新增工具：

```js
function isAgentBusyResult(result) {
  return result?.status === 'busy' || result?.skipped === true;
}
```

处理策略：

```js
const agentResult = await runAgentTaskWithRecoveredOutput(...);

if (isAgentBusyResult(agentResult)) {
  logs = [...logs, 'Agent 正在处理其他任务，本轮跳过 Agent 修复。'];
  updateTask(...);
  return { ran: false, fixedCount: 0, failedCount: 0, skipped: true, reason: 'busy' };
}
```

如果 Agent 修复是兜底增强能力，busy 不应让正文任务系统失败。

### 20.2 `outlineGenerationTask.cjs`

目录 Agent 修复是最终兜底时，如果 busy：

- 返回明确业务提示。
- 不计入 Agent 失败统计。
- 根据当前流程决定：
  - 如果已有非 Agent 目录结果可保存，则继续保存。
  - 如果没有可用结果，则向用户提示稍后重试 Agent 修复。

示例：

```js
if (agentResult?.status === 'busy') {
  throw createUserVisibleError('Agent 正在处理其他任务，请稍后重新生成或重试目录修复。', {
    code: 'AGENT_BUSY',
    userVisible: true,
  });
}
```

### 20.3 开发者测试页

busy 展示为提示，不作为异常堆栈。

### 20.4 Analytics

`trackAgentRuntime()` 只能在真实执行任务后调用：

- `success` 后调用 success。
- 真实异常调用 failed。
- busy、用户取消、业务暂停不调用 failed。

---

## 21. 实施步骤

### 步骤 1：新增 runtime service 骨架

新增文件：

```text
client/electron/services/opencode/opencodeRuntimeService.cjs
```

先实现：

- `createOpenCodeRuntimeService()`
- `getStatus()`
- `onStatus()`
- `emitStatus()`
- `setPhase()`
- `touchActivity()`
- `createBusyResult()`
- `warmup()`
- `ensureStarted()`
- `close()`

此时 `ensureStarted()` 可以先调用改造后的 `startOpenCodeSidecar()`。

验收：

```powershell
cd client
node --check electron\services\opencode\opencodeRuntimeService.cjs
```

### 步骤 2：改造 `opencodeServerRunner.cjs`

把当前按任务启动逻辑抽成常驻 sidecar：

- 参数从单任务隔离目录改成 `runtimeRoot/serviceWorkspaceDir`。
- AI proxy 只启动一次。
- OpenCode Server 只启动一次。
- `cwd` 固定为 `serviceWorkspaceDir`。
- 增加 `onActivity`、`getActivityContext`、`onExit`。
- `close()` 不清理整个 runtimeRoot，只关闭进程和 proxy。
- 增加 pid、proxy status、stdout/stderr tail。

删除旧隔离启动逻辑。本次业务路径不能再调用单任务独立 OpenCode Server。

验收：

```powershell
cd client
node --check electron\services\opencode\opencodeServerRunner.cjs
```

### 步骤 3：改造 `agentService.cjs`

- 引入 `createOpenCodeRuntimeService`。
- 删除 `runTask()` 中直接启动单任务独立 OpenCode Server 的路径。
- `runTask()` 改为 `runtime.runTask(payload)`。
- `selfCheck()` 改为 `runtime.runSelfCheck()`。
- 保留 `exportSelfCheckReport()`。
- 新增 `warmup/getStatus/restart/onStatus/close`。

验收：

- 搜索确认 `agentService.cjs` 不再调用单任务独立 OpenCode Server。
- `agentService.runTask()` 不再在 `finally` 里关闭 server。

### 步骤 4：实现 staging workspace 任务流程

在 runtime service 中实现：

- `prepareTaskWorkspace(payload)`。
- `readOutputContent(outputFile)`。
- `archiveTaskWorkspace(taskId)`。
- `cleanupStagingWorkspace()`。
- `runOpenCodeTask()` 调用现有 HTTP client。

硬性约束：

- `prepareTaskWorkspace()` 和 `cleanupStagingWorkspace()` 只能清空 `serviceWorkspaceDir` 子项，不能删除 `serviceWorkspaceDir` 根目录。
- `serviceWorkspaceDir` 根目录必须在 sidecar 启动前创建，并在 sidecar 存活期间持续存在。
- 清理失败不能继续执行新任务，避免脏 workspace 被新任务复用。

验收：

- 第一个任务可以生成输出。
- 第二个任务开始前 staging workspace 已清空。
- 第二个任务开始前 `serviceWorkspaceDir` 根目录仍是同一路径且未被删除重建。
- 两个任务归档目录分别存在。
- OpenCode pid 不变化。

### 步骤 5：实现单任务 busy 返回

在 `runTask()` 开头：

```js
if (activeTask) {
  return createBusyResult(activeTask);
}
```

任务开始时设置：

```js
activeTask = createActiveTask({ ...payload, activity_token: crypto.randomUUID() });
phase = 'running';
```

任务结束 finally：

```js
activeTask = null;
phase = sidecarHealthy ? 'idle' : 'unhealthy';
```

验收：

- 同时触发两个 Agent。
- 第一个执行。
- 第二个立即返回 busy。
- 第二个不创建 workspace。
- 第二个不进入 OpenCode request log。
- Analytics 不增加 failed。

### 步骤 6：接入 OpenCode HTTP activity

改造：

```text
client/electron/services/opencode/opencodeHttpClient.cjs
```

- `requestJson()` 增加 `onActivity`。
- `createSession/sendPrompt/getSessionDiff/runOpenCodeTask` 透传 `onActivity`。
- request start/success/fail 都记录 activity。

验收：

- 前端 status 能看到 `正在创建 Agent 会话`。
- 发送 message 时能看到 `Agent 正在执行任务`。
- diff 阶段能看到 `正在读取 Agent 修改结果`。

### 步骤 7：接入 AI proxy activity 与流式 idle timeout

改造：

```text
client/electron/services/opencode/aiServiceOpenAiProxy.cjs
```

- `createAiServiceOpenAiProxy()` 增加 `onActivity`。
- `createAiServiceOpenAiProxy()` 增加 `getActivityContext`，每个 proxy 请求开始时固定当前 task token。
- chat received、queued、upstream started、headers、chunk、completed、failed 调用 activity。
- `createUsageCapturingStream()` 和 `pipeWebStreamToNode()` 增加 chunk hook。
- 实现流式 idle timeout。
- textQueue 增加 `getStatus()` 和 `clearQueued()`。
- proxy close 增加 socket tracking。

验收：

- 模型流式返回期间 `last_activity_at` 持续刷新。
- 旧请求迟到 chunk 不会刷新下一轮任务的 `last_activity_at`。
- 运行超过 `timeout_ms` 但持续有 chunk 的任务不会被取消。
- 模型无响应超过 `timeout_ms` 后任务被判定 stalled。
- status 中 proxy active/queued/limit 正确。

### 步骤 8：实现 activity watchdog

在 runtime 的 active task 中启动 watchdog：

```js
const stopWatchdog = startActivityWatchdog({
  timeoutMs,
  abort: (error) => activeTaskAbortController.abort(error),
});
```

清理：

```js
finally {
  stopWatchdog?.();
}
```

验收：

- 总运行时长超过 `timeout_ms` 但有活动：不中断。
- 连续无活动超过 `timeout_ms`：中断。
- 用户暂停 signal：立即中断，不等 watchdog。
- OpenCode stdout/stderr 普通日志不会刷新 `last_activity_at`。
- 没有匹配当前 `activity_token` 的迟到事件不会刷新 `last_activity_at`。

### 步骤 9：实现 idle health check

runtime 启动成功后：

```js
startIdleHealthTimer();
```

规则：

- idle 每 30 秒检查 OpenCode 和 proxy。
- 连续 3 次失败 phase 变 `unhealthy`。
- unhealthy 后下一次 runTask 先 restart。
- running 时 health 不触发 restart。

验收：

- idle 状态下 status 更新 last_health_at。
- 手动杀 OpenCode 子进程后 phase 变 unhealthy。
- 下一次任务会自动 restart。

### 步骤 10：IPC / preload / types

改造：

```text
client/electron/ipc/agentIpc.cjs
client/electron/preload.cjs
client/src/shared/types/ipc.ts
```

增加：

- `agent:get-status`
- `agent:restart`
- `agent:status`

验收：

- Renderer 可调用 `window.yibiao.agent.getStatus()`。
- Renderer 可订阅 `window.yibiao.agent.onStatus()`。
- Agent 执行时前端能收到粗粒度进度变化。

### 步骤 11：前端开发者页适配

改造：

```text
client/src/features/developer/pages/OpenCodeAgentTestPage.tsx
```

- 展示 runtime status。
- 展示 progress_text。
- 展示 elapsed/idle seconds。
- busy 时显示友好提示。
- 增加手动 restart。
- 不展示 secret。

验收：

- 开发者页能看到常驻服务 idle/running/unhealthy。
- 同时点击两次运行，第二次显示 busy 提示。
- 手动 restart 后 pid 变化，status 恢复 idle。

### 步骤 12：self-check 复用 runtime

改造 `agentService.cjs`：

- 删除 selfCheck 内部独立启动 OpenCode 的逻辑。
- 空闲时调用 `runtime.runSelfCheck()`。
- 忙碌时返回 busy self-check 结果。
- 自检报告包含 runtime status。

验收：

- self-check 不再产生第二个 OpenCode pid。
- 任务运行中点自检，返回 Agent 正忙。
- 空闲自检通过后 OpenCode pid 不变化。

### 步骤 13：业务调用方 busy 适配

改造：

```text
client/electron/services/contentGenerationTask.cjs
client/electron/services/outlineGenerationTask.cjs
client/src/features/developer/pages/OpenCodeAgentTestPage.tsx
```

验收：

- busy 不作为系统异常。
- contentGenerationTask 中 busy 不导致正文任务 failed。
- outlineGenerationTask 中 busy 给出用户可理解提示。
- busy 不上报 failed。

### 步骤 14：配置变更与 restartPending

改造配置保存链路，保存后通知 agent runtime：

```js
agentService.handleConfigChanged?.(nextConfig, previousConfig);
```

或者 runtime 在每次 `ensureStarted()` 前检测 config signature。

需要重启时：

```js
runtime.markRestartPending('context_length_limit changed');
```

idle 后自动：

```js
await runtime.restart('config changed');
```

验收：

- 修改 `context_length_limit` 后 status 显示 restart_pending。
- 当前任务不被打断。
- 任务结束后 runtime 自动重启。
- 修改 api_key/base_url/model_name 后无需重启，下一次 proxy 请求读取新值。

### 步骤 15：app 退出清理

改造：

```text
client/electron/ipc/index.cjs
client/electron/main.cjs
```

- `registerIpcHandlers()` 返回 `closeServices`。
- `before-quit` 使用 `event.preventDefault()` 等待 `closeServices` 完成后再真正退出。
- `app.relaunch()`、`app.exit(0)`、更新安装等主动退出路径统一先调用 close wrapper。
- close 内强制释放 OpenCode 子进程和 proxy 端口。

验收：

- 退出应用后任务管理器里没有残留 OpenCode 进程。
- proxy 端口释放。
- `before-quit` 不使用 fire-and-forget close。
- 主动重启或更新安装后没有残留 OpenCode 进程。
- macOS/Windows 都验证。

---

## 22. 关键伪代码

### 22.1 runtime `runTask()`

```js
async function runTask(payload = {}) {
  if (activeTask) {
    return createBusyResult(activeTask);
  }

  const taskId = payload.task_id || crypto.randomUUID();
  const title = payload.title || '易标智能体任务';
  const outputFile = payload.output_file || 'agent-result.md';
  const timeoutMs = normalizeTimeoutMs(payload.timeout_ms, DEFAULT_AGENT_IDLE_TIMEOUT_MS);

  activeTask = createActiveTask({ taskId, title, timeoutMs, activity_token: crypto.randomUUID() });
  setPhase('running', 'Agent 正在执行任务');
  emitStatus();
  const taskActivity = createTaskActivity(activeTask);

  const abortController = new AbortController();
  const stopParentAbort = bindParentSignal(payload.signal, abortController);
  const stopWatchdog = startActivityWatchdog({
    timeoutMs,
    abort: (error) => abortController.abort(error),
  });

  let mustRestartAfterTask = false;

  try {
    await ensureStarted();

    taskActivity({ stage: 'workspace', message: '正在准备 Agent 工作目录', source: 'runtime' });
    prepareStagingWorkspace(payload);

    const result = await runOpenCodeTask(sidecar, {
      title,
      prompt: payload.prompt || createDefaultAgentPrompt({ task: payload.task, outputFile }),
      signal: abortController.signal,
      onActivity: taskActivity,
    });

    taskActivity({ stage: 'output', message: '正在读取 Agent 输出', source: 'runtime' });
    const output = readOutputContent(serviceWorkspaceDir, outputFile);

    taskActivity({ stage: 'archive', message: '正在保存 Agent 任务现场', source: 'runtime' });
    const archivedWorkspaceDir = archiveTaskWorkspace(taskId);

    trackAgentRuntime(app, configStore, 'success');

    return {
      success: true,
      task_id: taskId,
      title,
      workspace_dir: archivedWorkspaceDir,
      output_file: outputFile,
      output_content: output.content,
      assistant_text: result.text,
      diff: result.diff,
      session_id: result.session?.id || '',
      opencode_request_log: sidecar.requestLog || [],
      opencode_stderr_tail: sidecar.getStderrTail?.(8000) || '',
      opencode_stdout_tail: sidecar.getStdoutTail?.(8000) || '',
    };
  } catch (error) {
    if (isUserCancelOrPause(error)) {
      mustRestartAfterTask = true;
      throw error;
    }

    if (isWatchdogStall(error)) {
      mustRestartAfterTask = true;
      trackAgentRuntime(app, configStore, 'failed');
      throw annotateAgentError(error, collectDiagnostics());
    }

    trackAgentRuntime(app, configStore, 'failed');
    throw annotateAgentError(error, collectDiagnostics());
  } finally {
    stopWatchdog?.();
    stopParentAbort?.();

    const shouldRestart = mustRestartAfterTask || restartRequiredAfterAbort;
    activeTask = null;

    cleanupStagingWorkspace(); // 只清空 serviceWorkspaceDir 子项，不删除 cwd 根目录。

    if (shouldRestart && phase !== 'closing') {
      await restart('task aborted or stalled');
    } else if (restartPending && phase !== 'closing') {
      await restart('config changed');
    } else if (phase !== 'closing') {
      setPhase(sidecar ? 'idle' : 'unhealthy', sidecar ? 'Agent 服务空闲' : 'Agent 服务异常');
    }

    emitStatus();
  }
}
```

### 22.2 busy result

```js
function createBusyResult(activeTask) {
  return {
    success: false,
    status: 'busy',
    skipped: true,
    message: 'Agent 正在处理其他任务，请耐心等待',
    active_task: summarizeActiveTask(activeTask),
  };
}
```

### 22.3 `ensureStarted()`

```js
async function ensureStarted() {
  if (sidecar && phase !== 'unhealthy') return sidecar;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    setPhase('starting', '正在启动 Agent 服务');
    ensureRuntimeDirs();

    sidecar = await startOpenCodeSidecar({
      app,
      configStore,
      runtimeRoot: serviceRuntimeRoot,
      workspaceDir: serviceWorkspaceDir,
      diagnostics,
      onActivity: touchActivity,
      getActivityContext: () => activeTask
        ? { task_token: activeTask.activity_token, task_id: activeTask.task_id }
        : null,
      onExit: handleOpenCodeExit,
    });

    setPhase('idle', 'Agent 服务空闲');
    startIdleHealthTimer();
    return sidecar;
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}
```

---

## 23. 验证计划

### 23.1 静态检查

```powershell
cd client
node --check electron\services\agentService.cjs
node --check electron\services\opencode\opencodeRuntimeService.cjs
node --check electron\services\opencode\opencodeServerRunner.cjs
node --check electron\services\opencode\opencodeHttpClient.cjs
node --check electron\services\opencode\aiServiceOpenAiProxy.cjs
node --check electron\ipc\agentIpc.cjs
node --check electron\preload.cjs
npm run build
```

### 23.2 常驻性验证

1. 启动 App。
2. 打开开发者 Agent 页。
3. 记录 OpenCode pid。
4. 执行 Agent 任务 A。
5. 任务结束后确认 runtime phase 为 `idle`。
6. 执行 Agent 任务 B。
7. 确认 OpenCode pid 不变。
8. 确认 proxy port 不变。
9. 确认 `service/workspace` 根目录路径不变，任务间只清空其子项。

通过标准：

- 两个任务复用同一个 OpenCode Server。
- 没有第二套 OpenCode 进程。
- 没有第二套 proxy。
- 没有删除或重建常驻 OpenCode cwd 根目录。

### 23.3 单任务 busy 验证

1. 启动一个耗时 Agent 任务。
2. 在任务未完成时再次触发 Agent。
3. 第二个请求立即返回：
   ```text
   Agent 正在处理其他任务，请耐心等待
   ```
4. 第二个请求不创建 workspace。
5. 第二个请求不进入 OpenCode request log。
6. Analytics 没有 failed。

### 23.4 activity watchdog 验证

场景 A：持续活动

1. 设置较短 `timeout_ms`，例如 30 秒。
2. 使用一个持续流式输出超过 30 秒的模型任务。
3. 确认任务不会因总时长超过 30 秒被取消。

场景 B：卡死

1. 模拟上游模型连接后不返回 chunk。
2. 连续超过 `timeout_ms`。
3. 确认任务进入 `stalled`。
4. 确认 runtime abort 当前任务并重启或回到可用状态。

场景 C：无效 activity 不续命

1. 模拟 OpenCode stdout/stderr 持续输出普通日志，但模型和文件无实际进展。
2. 连续超过 `timeout_ms`。
3. 确认任务仍进入 `stalled`。
4. 模拟旧 proxy 请求迟到 chunk，确认新任务的 `last_activity_at` 不更新。

### 23.5 idle health 验证

1. Agent idle。
2. 等待至少 30 秒。
3. 确认 `last_health_at` 更新。
4. 手动杀 OpenCode 子进程。
5. 确认 status 变为 `unhealthy`。
6. 再执行 Agent，确认 runtime 尝试 restart。

### 23.6 self-check 验证

1. idle 状态执行 self-check。
2. 确认 OpenCode pid 不变。
3. running 状态执行 self-check。
4. 确认返回 busy，不启动第二套 OpenCode。

### 23.7 退出验证

1. 执行或空闲状态下退出 App。
2. 确认 `before-quit` 等待 `closeServices()` 完成。
3. 确认 OpenCode 子进程退出。
4. 确认 proxy 端口释放。
5. 触发 relaunch、更新安装或其他主动退出路径，确认没有残留 OpenCode 进程。
6. Windows 和 macOS 分别验证。

---

## 24. 风险与处理

| 风险 | 处理 |
| --- | --- |
| OpenCode 无可靠 session cancel API | abort 后强制 restart runtime，不复用旧进程 |
| staging workspace 被旧 session 写入 | 任何不可靠 abort 后必须 restart，restart 后再清理 staging |
| 运行中删除 OpenCode cwd 根目录导致 Windows `EPERM/EBUSY` 或句柄残留 | `service/workspace` 根目录在 sidecar 存活期间禁止删除，只清空子项 |
| 常驻进程运行中崩溃 | runtime 监听 child exit，running 中任务失败，idle 中标记 unhealthy |
| 模型长时间流式输出被误杀 | chunk 刷新 activity，不按总时长取消 |
| health check 掩盖任务卡死 | health 不刷新 active task activity |
| stdout/stderr 噪声掩盖任务卡死 | stdout/stderr 默认只写诊断，不刷新 `last_activity_at` |
| 旧 proxy stream 迟到事件污染下一轮任务 | 每个 proxy 请求固定 task token，token 不匹配只记诊断不刷新 activity |
| busy 被业务误判为失败 | 所有调用点识别 `status === 'busy'` |
| 配置变更未生效 | 动态字段由 proxy 每次读取，OpenCode config 字段 idle 后 restart |
| 多任务历史目录泄露 | 历史任务归档放在 OpenCode cwd 外，cwd 只保留当前任务文件 |
| close 卡住 | proxy socket tracking + OpenCode 子进程 SIGTERM/SIGKILL 兜底 |
| App 退出时 `closeServices()` 未完成导致子进程残留 | `before-quit` 阻止默认退出并等待 close；主动 relaunch、exit、更新安装路径先 close 再退出 |

---

## 25. 最小交付范围

本次改版的最小交付范围必须包含：

1. 常驻 `opencodeRuntimeService.cjs`。
2. App 启动后预热 OpenCode Server 和 OpenCode AI proxy。
3. `agentService.runTask()` 复用常驻 runtime。
4. 单任务 activeTask 锁。
5. busy 友好返回，不报错、不排队、不计失败。
6. single-staging-cwd 工作目录隔离，且常驻 cwd 根目录只清空子项、不删除根目录。
7. activity watchdog 替代绝对任务超时。
8. AI proxy 流式 chunk 刷新 activity。
9. activity token 防止旧请求迟到事件刷新新任务。
10. stdout/stderr 普通日志不刷新 watchdog activity。
11. idle health check。
12. `agent:get-status` / `agent:status` 前端状态回传。
13. self-check 复用常驻 runtime。
14. App 退出等待 runtime close 完成。

以下内容可以作为后续增强，但不能阻塞本次常驻交付：

- per-session directory workspace routing。
- 更详细的 OpenCode `/event` 事件解析。
- 多任务排队等待。
- 更复杂的 UI 进度条百分比。
- 更细粒度的 OpenCode 工具调用分类。

---

## 26. 最终验收清单

- [ ] App 启动后常驻 OpenCode runtime 可以进入 idle。
- [ ] 首个 Agent 任务使用已启动的 OpenCode runtime。
- [ ] 连续两个 Agent 任务复用同一个 OpenCode pid。
- [ ] 连续两个 Agent 任务之间只清空 `service/workspace` 子项，不删除 `service/workspace` 根目录。
- [ ] 同时两个 Agent 请求，第二个立即 busy。
- [ ] busy 返回文案为 `Agent 正在处理其他任务，请耐心等待`。
- [ ] busy 不创建 workspace。
- [ ] busy 不调用 OpenCode。
- [ ] busy 不上报 failed。
- [ ] Agent running 时前端能看到 progress_text。
- [ ] Agent running 时前端能看到 elapsed_seconds 和 idle_seconds。
- [ ] 持续有模型 chunk 时不会超时。
- [ ] 旧 proxy stream 或 HTTP 迟到事件不会刷新下一轮任务的 `last_activity_at`。
- [ ] OpenCode stdout/stderr 普通日志不会刷新 `last_activity_at`。
- [ ] 连续无 activity 超过 timeout_ms 时会 stalled 并停止任务。
- [ ] idle 时 health check 正常更新。
- [ ] OpenCode 崩溃后 runtime 标记 unhealthy。
- [ ] self-check 不启动第二套 OpenCode。
- [ ] App 退出后 OpenCode 子进程和 proxy 端口释放。
- [ ] `before-quit` 等待 `closeServices()` 完成，不使用 fire-and-forget close。
- [ ] relaunch、更新安装、`app.exit()` 类主动退出路径先 close runtime 再退出。
- [ ] 历史任务目录不在 OpenCode cwd 下。
- [ ] `context_length_limit` 变更后 idle 自动 restart。
- [ ] `api_key/base_url/model_name/concurrency_limit` 不需要重启即可由 proxy 下次请求读取。

---

## 27. 执行顺序建议

严格按下面顺序执行，避免中间态破坏业务：

1. 新增 `opencodeRuntimeService.cjs` 骨架。
2. 改造 `opencodeServerRunner.cjs`，先能启动常驻 sidecar。
3. 改造 `agentService.cjs`，让 `runTask()` 走 runtime。
4. 实现 single-staging-cwd 任务执行和归档，清理时只删除 cwd 子项。
5. 实现 activeTask 单槽锁和 busy 返回。
6. 改造 `opencodeHttpClient.cjs` activity。
7. 改造 `aiServiceOpenAiProxy.cjs` activity、stream idle timeout、task token、proxy status。
8. 实现 runtime watchdog。
9. 实现 idle health check。
10. 接 IPC、preload、types。
11. 改开发者测试页状态展示。
12. 改 self-check 复用 runtime。
13. 改 content/outline 调用方 busy 适配。
14. 接配置变更 restartPending。
15. 接 app 退出 close，确保 `before-quit` 和主动 relaunch/exit/update 路径都等待 close。
16. 跑完整验证计划。

完成以上步骤后，项目即从“每任务临时启动 OpenCode”改为“App-level 常驻 OpenCode 子服务 + 单任务执行 + 活性监控 + 前端状态回传”。
