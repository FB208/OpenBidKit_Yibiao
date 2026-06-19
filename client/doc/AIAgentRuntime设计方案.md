# AI Agent Runtime 设计方案

## 目标

在客户端内部实现一个可复用的 AI Agent Runtime，用于替代部分固定 AI 流水线，让 AI 能在受控工具集合内自行判断下一步动作，并通过多轮“观察、决策、执行、复核”产出可用结果。

## 为什么需要 Agent Runtime

当前很多 AI 流程是固定步骤：

```text
提取 -> 生成 -> 审核 -> 不通过则重新提取/重新生成
```

这种方式的问题是：

- 无法区分局部问题和全局问题。
- 审核建议无法被精确执行。
- 容易把局部修复变成全量重写。
- 每个业务流程都需要单独写一套“如果失败怎么办”的控制逻辑。
- Prompt 越堆越长，但流程仍然不具备自主判断能力。

Agent Runtime 的目标是把控制逻辑抽象为：

```text
AI 观察当前状态 -> AI 选择工具 -> 程序执行工具 -> 返回观察结果 -> AI 继续判断
```

## 借鉴 opencode 的核心思想

https://github.com/anomalyco/opencode

- Plan/Build 分离：先分析和制定修复目标，再执行修改。
- 工具受控：AI 不能直接写最终状态，只能调用程序提供的工具。
- 多步循环：遇到失败可根据 observation 继续调整，而不是固定重试同一请求。
- 读写边界清晰：只读工具、修改工具、校验工具分开。
- 子任务可拆分：复杂任务可由领域工具完成，例如“只重生成某个章节”。
- 最终结果可验证：AI 的 final 不等于成功，程序校验通过才成功。

## 总体架构

```text
Electron Main
└─ aiAgentRuntime.cjs
   ├─ runAgentTask()
   ├─ Agent Loop
   ├─ Tool Registry
   ├─ Action Normalizer
   ├─ Step Limit / Timeout
   ├─ Observation Builder
   └─ Developer Logger

Domain Agents
├─ outlineAgent.cjs
├─ contentAgent.cjs
├─ rejectionCheckAgent.cjs
└─ knowledgeBaseAgent.cjs

Domain Tools
├─ read_context
├─ review_outline
├─ patch_outline
├─ validate_outline
├─ generate_children
├─ extract_requirement_groups
└─ finalize
```

## Runtime 放置位置

建议新增目录：

```text
client/electron/services/agentRuntime/
├─ aiAgentRuntime.cjs
├─ actionSchema.cjs
├─ toolRegistry.cjs
├─ runtimeLog.cjs
├─ agents/
│  ├─ outlineAgent.cjs
│  ├─ contentAgent.cjs
│  └─ rejectionCheckAgent.cjs
└─ tools/
   ├─ outlineTools.cjs
   ├─ contentTools.cjs
   └─ commonTools.cjs
```

所有实现都在 Electron Main 侧，Renderer 只启动后台任务、展示进度、读取最终结果。

## Agent Loop 协议

每一轮 AI 必须返回 JSON：

```json
{
  "thought": "简短说明当前判断，不保存到用户结果，仅写入开发者日志",
  "action": "patch_outline",
  "args": {
    "operations": []
  }
}
```

允许的 `action` 由具体 Agent 配置。

特殊动作：

- `finalize`：表示 AI 认为任务完成，返回最终摘要。
- `ask_review`：请求程序执行复核工具。
- `abort`：AI 判断无法可靠完成，返回原因。

程序收到 action 后：

1. 解析 JSON。
2. 校验 action 是否允许。
3. 校验 args schema。
4. 执行工具。
5. 生成 observation。
6. 将 observation 追加到下一轮上下文。

## Runtime 输入输出

### 输入

```js
runAgentTask({
  aiService,
  agent,
  context,
  tools,
  maxSteps,
  timeoutMs,
  log,
})
```

### 输出

```js
{
  status: 'success' | 'failed' | 'aborted',
  result,
  steps: [
    {
      index,
      action,
      argsSummary,
      observationSummary,
      ok,
    }
  ],
  finalValidation
}
```

## 工具设计原则

- 工具是纯业务能力，不直接让 AI 访问 Node `fs`、SQLite 或 IPC。
- 工具参数必须经过 schema 校验。
- 修改类工具返回修改摘要，不返回无限长全文。
- 工具应尽量幂等或可重复调用。
- 工具失败要返回结构化错误，供 AI 下一步修正。
- 所有最终保存仍由现有 Store 服务执行。



## 日志设计

开发者模式下写入：

```text
userData/logs/agent-runtime/<task>.jsonl
```

每行记录：

```json
{
  "at": "2026-06-18T00:00:00.000Z",
  "agent": "outline",
  "step": 3,
  "event": "tool_result",
  "action": "patch_outline",
  "ok": true,
  "summary": "删除节点 2.3，重新编号",
  "duration_ms": 1234
}
```

敏感边界：

- 不写 API Key、Base URL、Token。
- 不写完整本地路径。
- 大文本只写 hash、长度和必要摘要。
- AI 完整请求仍沿用现有 `logs/ai/`。

## 与 aiService 的关系

Runtime 不直接发 HTTP 请求，必须通过现有 `aiService`：

- `aiService.collectJsonResponse()` 用于 action JSON。
- `aiService.chat()` 或已有业务函数用于工具内部 AI 子任务。
- 继续使用全局文本模型队列和 `queueScopeId`。
- 继续支持暂停、取消、开发者模式日志。

## 失败处理

### 工具参数非法

返回 observation 给 AI，例如：

```json
{
  "ok": false,
  "error_code": "INVALID_NODE_ID",
  "message": "节点 2.3 不存在，请重新读取目录或选择其他节点。"
}
```

### 多次无效动作

Runtime 统计连续无效动作次数。

- 连续 2 次无效：提示 AI 必须换策略。
- 连续 3 次无效：终止 Agent，返回失败。

### 步数上限

默认 8 步。

达到上限后：

- 如果当前结果已通过最终校验，可以保存。
- 否则失败并记录最后问题。

## 安全边界

- Agent 不能直接调用任意 IPC。
- Agent 不能直接写 SQLite。
- Agent 不能直接读写文件系统。
- Agent 不能新增工具白名单外动作。
- 修改类工具必须先 clone 当前状态，成功校验后再返回。
- 保存前统一走现有 Store transaction。

