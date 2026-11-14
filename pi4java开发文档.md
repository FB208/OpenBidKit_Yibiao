# pi4java 开发文档

本文是 pi4java 的完整开发依据。开发者（人或 AI）只凭本文，加上下面两份可读的源码，就应能完成全部开发。

| 代号 | 含义 | 说明 |
|---|---|---|
| `$PI` | Pi 1.5.2 源码根目录 | 目录下有 `packages/ai`、`packages/agent`、`packages/coding-agent` 等。各包 `package.json` 的版本是 `1.5.2` |
| `$YIBIAO` | 易标投标工具箱（yibiao-simple）源码根目录 | 只用到 `client/electron/services/pi/` 和 `client/electron/services/agent/` 下的少量文件，用于第 9 章的内置附加能力 |

开工第一步：确认这两个目录在本机的实际路径，并写进新仓库的 `README` 开发说明。本文所有路径都以这两个代号开头。

---

## 1. 项目定位

pi4java 是 Pi（<https://github.com/earendil-works/pi>）的 Java SDK：把 Pi 的**无界面 Agent 内核**用 Java 重新实现，行为与 Pi 1.5.2 保持一致，独立开源并发布到 Maven 仓库。

它是一个库，不是命令行工具，也不是服务。使用方在自己的 Java 程序里创建会话、发提示词、订阅事件、注册工具和扩展。

### 1.1 三条总原则

1. **忠实复刻，不做设计**。凡是属于复刻范围的代码，行为以 `$PI` 源码为准：同样的输入产生同样的模型请求、同样的会话文件、同样的事件顺序。遇到不确定的地方去读源码，不要按“合理猜测”实现。
2. **所有偏离都要登记**。因为语言差异或范围裁剪导致的任何行为差异，在代码处加注释 `// PI4JAVA-DIFF: <原因>`，并在仓库根目录 `DIFF.md` 里登记一行。没有登记的差异视为缺陷。
3. **附加能力与复刻部分物理隔离**。第 9 章的内置附加能力放在独立的包里，只通过 Pi 的公开接口和扩展机制工作。复刻部分为配合它们而改动的地方必须极少，且逐一登记。

### 1.2 不做的事

以下内容明确不在范围内，不要实现，也不要为它们预留复杂的抽象：

- 交互界面、打印模式、RPC 模式、命令行、`pi-tui`
- OpenAI Chat Completions 以外的任何模型接口（Anthropic、Google、Bedrock、Mistral、OpenAI Responses、Codex、Azure、Cloudflare 等）
- 登录认证（OAuth、订阅登录、从环境变量取 Key、`auth.json`）
- 图片生成的实现（只保留类型定义，见 5.6）
- 图片输入处理（读图、缩放、格式转换）
- 缓存保活（`cache-warming.ts`、`cache-warmer.ts`）
- 随包扩展 `codemode`、`mcp`、`tool-search`、`llama`，以及 `packages/codemode`、`packages/mcp`
- `packages/durable`、`packages/chord`、`packages/env`、`packages/evals`
- 包管理、项目信任管理的交互流程、快捷键、主题、导出网页、崩溃与错误报告、版本检查与自更新、剪贴板
- 扩展的自动发现和从文件加载（扩展只通过代码显式注册，见第 8 章）
- 分类器模型、批量延迟请求、WebSocket 传输、虚拟模型、远程模型目录刷新

---

## 2. 工程基础

| 项 | 规定 |
|---|---|
| Java 版本 | 21（使用虚拟线程；不使用预览特性） |
| 构建 | Maven 多模块 |
| groupId | `io.github.fb208`（发布前以 Maven Central 实际验证通过的命名空间为准；若验证结果的大小写不同，只改这一处） |
| Java 根包 | `io.github.fb208.pi4java` |
| 框架依赖 | 不依赖 Spring 或任何应用框架 |
| 操作系统 | Linux、macOS、Windows 都要支持（Pi 自身也支持 Windows，含 PowerShell 工具） |
| 许可证 | MIT。仓库带 `LICENSE` 和 `NOTICE`，`NOTICE` 中保留 Pi 的版权声明并说明本项目是其 Java 移植 |
| 注释与 Javadoc | 英文（与上游一致，便于逐行对照）。第 9 章中文提示文本除外，必须逐字保留 |
| README | 中文、英文各一份 |

### 2.1 模块划分

| 模块（artifactId） | 对应上游 | Java 包 |
|---|---|---|
| `pi4java-telemetry` | `packages/telemetry` 的接口部分 | `…pi4java.telemetry` |
| `pi4java-ai` | `packages/ai` 的裁剪子集 | `…pi4java.ai` |
| `pi4java-agent` | `packages/agent`（即 `pi-agent-core`） | `…pi4java.agent` |
| `pi4java-coding-agent` | `packages/coding-agent/src/core` 和 `src/utils` 的裁剪子集 | `…pi4java.codingagent`，附加能力在 `…pi4java.codingagent.extras` |
| `pi4java-bom` | 无 | 版本对齐用的 BOM |

依赖方向：`telemetry` ← `ai` ← `agent` ← `coding-agent`。不允许反向依赖。

### 2.2 第三方依赖

只允许下列用途的依赖，版本取开发时的最新稳定版并在父 `pom.xml` 统一管理。新增其他依赖前必须在 `DIFF.md` 说明理由。

| 用途 | 建议 | 替代的上游依赖 |
|---|---|---|
| JSON | Jackson（`jackson-databind`） | 原生 JSON |
| HTTP 与流式响应 | JDK 自带 `java.net.http.HttpClient`，SSE 解析自己写 | `openai` npm 包、`undici` |
| JSON Schema 校验 | `com.networknt:json-schema-validator` | `pi-schema`、`typebox`、`ajv` |
| 文本差异 | `io.github.java-diff-utils:java-diff-utils` | `diff` |
| YAML（技能和提示词模板的头部） | SnakeYAML | `yaml` |
| 日志 | 只依赖 `slf4j-api`，不绑定实现 | 无 |
| 测试 | JUnit 5、AssertJ | vitest |

`minimatch`、`ignore`、`glob` 在范围内的用法很少：先读源码确认具体用到的匹配语义，能用 JDK 的 `PathMatcher` 等价表达就用，不能就按用到的语义做最小移植，并用上游对应的测试覆盖。

`rg`（ripgrep）和 `fd` 是 `grep`、`find` 工具运行时调用的外部程序，见 7.5。

---

## 3. TypeScript 到 Java 的翻译约定

这一章是全局规则。后面各章不再重复。

### 3.1 文件与命名

- 一个上游源文件对应一个同名 Java 类或一组放在同一个包里的类。类名、方法名、字段名沿用上游的名字（Java 驼峰写法）。
- 每个 Java 文件顶部注明来源，格式固定：
  `// Ported from packages/coding-agent/src/core/agent-session.ts (pi 1.5.2)`
- 上游一个文件导出多个函数时，Java 里放进一个以文件名命名的 `final` 工具类的静态方法里，例如 `utils/retry.ts` → `Retry.isRetryableAssistantError(...)`。

### 3.2 类型

| TypeScript | Java |
|---|---|
| `interface` 数据结构 | `record`；需要可变时用普通类 |
| 带判别字段的联合类型（`type`、`role`） | `sealed interface` + 多个 `record`，Jackson 按判别字段多态序列化 |
| 字符串字面量联合 | `enum`，序列化值与上游字符串完全一致 |
| 可选字段 `x?: T` | 可空引用，序列化时省略空值（`@JsonInclude(NON_NULL)`） |
| `Record<string, T>`、对象字面量 | `LinkedHashMap`（保持插入顺序，JS 对象按插入顺序遍历） |
| `unknown`、任意 JSON | Jackson `JsonNode` |
| TypeBox Schema（`Type.Object(...)`） | 用一个小的构建器生成 JSON Schema 的 `ObjectNode`，见 3.6 |

**JSON 字段名必须与上游逐字一致**（大小写、下划线都不能变）。这直接决定会话文件能否与 Pi 互通，以及发给模型的请求是否一致。

### 3.3 异步与并发

Pi 运行在 JavaScript 单线程事件循环上，代码里大量依赖“两个 `await` 之间不会被打断”。Java 侧按下面的模型实现，这是全项目最容易出错的地方。

- **对外接口是同步阻塞的**。`Promise<T>` 翻译成直接返回 `T`，调用方在虚拟线程上调用即可。不使用 `CompletableFuture` 链式风格，也不引入响应式库。
- **一次运行只有一个主线程**。`prompt()` 等入口在调用者线程上跑完整个工具循环，循环内的状态只在这个线程上读写。
- **会被其他线程调用的入口只碰线程安全的字段**。`abort()`、`steer()`、`followUp()`、`subscribe()` 以及取消订阅，可能在别的线程上被调用，它们只操作：并发队列、原子引用、写时复制的监听器列表。不要让它们直接改循环状态。
- **并行执行工具时**，每个工具调用在自己的虚拟线程上跑，主线程等待并按上游规定的顺序收集结果。工具线程里发出的进度更新（`onUpdate`）要经过一把“发事件锁”串行化后再通知监听器。
- **事件按上游顺序同步派发**。监听器在派发线程上被同步调用；一个监听器抛异常不影响其他监听器（与上游行为一致，读源码确认各处的处理）。
- **禁止持锁做阻塞操作**（模型请求、工具执行、钩子回调、文件读写）。上游代码里的每个 `await` 都是一个“可能被插入其他操作”的点，翻译时要保证这些点上没有持有会阻塞其他入口的锁。
- **中止**：`AbortSignal` / `AbortController` 翻译为自实现的 `CancellationToken` / `CancellationSource`（`isCancelled()`、`throwIfCancelled()`、`onCancel(Runnable)`、可带原因）。所有阻塞点都必须响应取消：HTTP 流要能立刻断开，子进程要能连同子进程树一起结束，`sleep` 要能被唤醒。
- **定时器**：`setTimeout` 用一个共享的调度线程池；涉及时间的逻辑通过可注入的 `Clock` 取时间，便于测试。

### 3.4 错误

- `Error` 翻译为运行时异常。上游代码靠给 `Error` 对象挂属性区分类型的地方，Java 里用带字段的异常子类。
- **错误文案逐字保留**。Pi 的自动重试靠正则匹配错误文案（`utils/retry.ts`），文案差一个词都会改变行为。
- 上游用的 `openai` npm 包（1.5.2 依赖的是 `7.19.0`）会按固定格式生成错误文案，Java 自己写 HTTP 客户端后必须生成相同的文案。HTTP 错误的格式是：
  - 有状态码也有消息：`<状态码> <消息>`，其中消息取响应体 `error.message`（是字符串就直接用，否则转成 JSON 文本）；没有 `error.message` 但有 `error` 对象时取整个 `error` 的 JSON 文本
  - 只有状态码：`<状态码> status code (no body)`
  - 只有消息：消息本身
  - 都没有：`(no status code or body)`

  连接失败、超时、被中止这几种情况的文案，以及上面格式的准确性，以 `openai` 包 `7.19.0` 的 `core/error` 源码为准。本机没有该版本时可参考 `$YIBIAO/client/node_modules/openai/core/error.js`（版本 `6.26.0`，这部分逻辑相同），并在 `DIFF.md` 注明核对依据。

### 3.5 文本、数字与 JSON 输出

- JS 字符串长度按 UTF-16 码元计，Java `String.length()` 相同，按字符数截断的逻辑可以直接对应。按字节截断的逻辑统一用 UTF-8。注意上游对代理对（surrogate）的处理，有专门的测试。
- **`JSON.stringify(x, null, 2)` 的输出会进入工具结果、发给模型**。Jackson 默认的缩进格式与 JS 不同，必须配置一个输出与 JS 完全一致的格式化器（两个空格缩进、冒号后一个空格、空数组和空对象的写法、数字的写法），并写专门的测试覆盖。
- JS 的数字转字符串规则与 Java `double` 不同（如 `1.0` 在 JS 里输出 `1`）。凡是数字会进入文本或 JSON 的地方，整数用 `long`，并测试输出。
- 正则表达式逐条移植并加测试。JS 与 Java 正则语法大体相同，但标志位、Unicode 处理有差异。
- 所有提示词、工具说明、给模型看的错误信息，**逐字复制**，包括标点、空行和缩进。这些文本放在所属类里（Java 文本块），不要另建资源文件。

### 3.6 工具参数 Schema

上游用 TypeBox 定义工具参数，运行时得到的是一个 JSON Schema 对象，原样发给模型。

- Java 侧提供一个最小的 Schema 构建器（对象、字符串、数字、布尔、数组、枚举、可选、联合、`additionalProperties`、`description`、`minLength` 等用到的关键字），产出 `ObjectNode`。
- **产出的 JSON 必须与 TypeBox 的输出一致**，包括属性顺序、`required` 数组的顺序、哪些关键字出现。对每个原生工具写一个“Schema 黄金样本”测试（见 10.3）。
- 工具执行时拿到的参数是 `JsonNode`，各工具自己取值。参数校验按上游 `utils/validation.ts` 的行为（含类型强制转换规则）实现，底层用 JSON Schema 校验库。校验失败的报错文本要与上游一致，因为它会作为工具结果返回给模型。

### 3.7 平台接口

| Node.js | Java |
|---|---|
| `fs`、`fs/promises` | `java.nio.file.Files`。显式用 UTF-8，注意 BOM 处理（上游有 `splitBom`） |
| `path` | `java.nio.file.Path`。上游有些地方刻意用 POSIX 风格路径（存进会话文件或显示给模型），这些地方要保持 `/` 分隔 |
| `child_process.spawn` | `ProcessBuilder`；结束进程树用 `ProcessHandle.descendants()` |
| `os.homedir()`、`process.env`、`process.platform` | `System.getProperty("user.home")`、`System.getenv`、`os.name` 判断 |
| `crypto.randomUUID`、哈希 | `java.util.UUID`、`MessageDigest`。上游的 `uuidv7` 要按算法移植 |
| `fetch`、`undici` 代理与超时 | `HttpClient`；代理和超时作为构造参数暴露，默认行为读 `core/http-dispatcher.ts` 后对应实现 |

---

## 4. 阶段零：盘点（开工前必须完成）

本文第 5 至 7 章给出了各包的处理清单，但没有穷举每一个文件。开工后第一件事是做一次完整盘点，产出两份文件并提交：

**`PORTING_MAP.md`**：列出 `$PI/packages/ai/src`、`$PI/packages/agent/src`、`$PI/packages/coding-agent/src/core`、`$PI/packages/coding-agent/src/utils`、`$PI/packages/telemetry/src` 下的**每一个**源文件，各占一行：

| 上游文件 | 处理 | Java 类 | 备注 |
|---|---|---|---|
| … | 完整复刻 / 部分复刻 / 不复刻 | … | 部分复刻时写明留什么、去什么 |

**`TEST_MAP.md`**：列出上述各包 `test/` 下每一个测试文件，标明“移植 / 不移植”及原因（见第 10 章）。

判定一个未在本文点名的文件该怎么处理，用这个顺序：

1. 它属于 1.2 列出的不做范围吗？是则不复刻。
2. 它被某个要复刻的文件引用，且引用的功能在范围内吗？是则复刻被用到的部分。
3. 它只服务于界面、命令行或已排除的功能吗？是则不复刻。
4. 仍拿不准时，倾向于复刻，并在备注里写明疑点。

盘点时发现本文的清单与源码实际情况有出入（文件不存在、职责与描述不符），以源码为准，并在 `PORTING_MAP.md` 备注。

---

## 5. 模块一：`pi4java-ai`（对应 `$PI/packages/ai`）

### 5.1 完整复刻

| 上游文件 | 说明 |
|---|---|
| `src/types.ts` | 消息、内容块、工具、用量、停止原因、流式事件、`Context`、`Model`、`StreamOptions` 等。只去掉 5.5 列出的类型 |
| `src/utils/event-stream.ts` | `AssistantMessageEventStream`。Java 里是一个可阻塞迭代的事件流，另有 `result()` 取最终消息 |
| `src/utils/streaming-json.ts`、`src/utils/json-parse.ts` | 流式工具参数的增量解析、宽松 JSON 解析 |
| `src/utils/validation.ts`、`src/utils/string-enum.ts` | 工具参数校验 |
| `src/utils/retry.ts` | 可重试错误判定。两组正则的每一条都要移植，并移植 `test/retry.test.ts` |
| `src/utils/overflow.ts` | 上下文溢出判定 |
| `src/utils/provider-retry.ts`、`src/utils/error-body.ts` | 请求级重试和错误体整理 |
| `src/utils/estimate.ts` | token 估算 |
| `src/utils/transcript.ts`、`src/utils/text.ts`、`src/utils/sanitize-unicode.ts`、`src/utils/hash.ts`、`src/utils/headers.ts`、`src/utils/uuid.ts`、`src/utils/abort.ts`、`src/utils/abort-signals.ts`、`src/utils/sleep.ts`、`src/utils/diagnostics.ts`、`src/utils/models-error.ts`、`src/utils/model-operations.ts` | 被上面各项和后续模块引用的工具函数 |
| `src/api/openai-completions.ts` | **OpenAI 兼容 Chat Completions 流式接口，全项目唯一的真实模型接口**，见 5.3 |
| `src/api/transform-messages.ts`、`src/api/openai-prompt-cache.ts`、`src/api/simple-options.ts`、`src/api/strict-tool-limits.ts` | 上一项的依赖 |
| `src/providers/faux.ts` | 假的模型来源，测试专用，必须复刻（第 10 章的测试都靠它） |
| `src/models-store.ts` | 只要接口和内存实现 |

### 5.2 部分复刻

| 上游文件 | 留下 | 去掉 |
|---|---|---|
| `src/models.ts` | `Models`、`MutableModels`、`Provider`、`createModels`、`createProvider`、`calculateCost`、`clampThinkingLevel`、`getSupportedThinkingLevels`、`modelsAreEqual` 等与“注册模型来源、取模型、发起流式请求”有关的部分 | 认证相关（`Provider.auth` 及其调用链）、远程目录刷新、分类器、图片、延迟请求 |
| `src/providers/compat-schema.ts`、`src/providers/model-schema.ts` | OpenAI Chat Completions 的兼容项定义（`supportsDeveloperRole`、`maxTokensField`、各种思考格式等）及其默认值推断 | 其他接口的兼容项 |
| `src/compat.ts` | 只在后续模块确实引用时，移植被引用的函数 | 其余 |
| `src/utils/identity.ts` | 客户端标识的结构和传递方式 | 标识内容改为 pi4java 自己的（名称 `pi4java`、本项目版本号），登记到 `DIFF.md` |
| `src/utils/provider-env.ts` | 调用方显式传入的环境值 | 读取进程环境变量取 Key 的逻辑 |
| `src/telemetry.ts` | 模型请求的遥测上报点，接到 `pi4java-telemetry` 的接口上 | 无 |
| `src/api/constrained-sampling.ts` | 仅当 `openai-completions.ts` 实际用到时，移植被用到的部分 | 其余 |

API Key 的来源：调用方在注册模型来源时直接给出（固定值或一个取值函数）。pi4java 不读环境变量、不做登录。

### 5.3 `openai-completions.ts` 的要求

- 上游用 `openai` npm 包发请求。Java 用 `HttpClient` 直接发 `POST {baseUrl}/chat/completions`，自己解析 SSE。
- **请求体必须与上游逐字段一致**。上游根据模型的兼容项决定很多细节：系统消息用 `system` 还是 `developer` 角色、`max_tokens` 还是 `max_completion_tokens`、思考内容的各种格式、工具结果是否带 `name`、缓存控制字段、是否请求流式用量等。这些分支**全部保留**，因为使用方会通过 OpenAI 格式接入 DeepSeek、通义、智谱等多家模型。
- 只去掉 GitHub Copilot 专属的请求头逻辑（`github-copilot-headers.ts`）。
- 不发送 `openai` npm 包自带的 `x-stainless-*` 等客户端标识头。请求头只包含：认证头、内容类型、上游代码显式设置的头、调用方传入的头。登记到 `DIFF.md`。
- 上游把 `openai` 包自身的重试关掉（`maxRetries: 0`），请求级重试由 `utils/provider-retry.ts` 负责，会话级重试由 `AgentSession` 负责。Java 侧保持这个分工，不要在 HTTP 客户端里另加重试。
- 错误文案的格式见 3.4。
- 流中途的错误、流提前结束、空响应等异常路径，逐一对照上游处理，并移植相应测试。

### 5.4 不复刻

`src/api/` 下除 5.1 列出的以外全部文件；`src/auth/` 整个目录；`src/providers/` 下除 `faux.ts`、`compat-schema.ts`、`model-schema.ts` 以外的全部文件（各厂商的模型目录和工厂）；`src/cache-warming.ts`；`src/cli.ts`；`src/env-api-keys.ts`；`src/oauth.ts`、`src/lazy-oauth.ts`、`src/bun-oauth.ts`；`src/bedrock-provider.ts`、`src/lazy-bedrock-provider.ts`；`src/legacy-api-aliases.ts`；`src/model-catalog.ts`、`src/models.generated.ts`；`src/utils/oauth-page.ts`、`src/utils/openrouter-cost.ts`、`src/utils/node-http-proxy.ts`（代理改由 `HttpClient` 配置）。

### 5.5 从 `types.ts` 去掉的类型

分类器相关（`Classifier*`）、延迟请求相关（`Deferred*`）、其他厂商接口专属的选项类型、WebSocket 传输。`KnownApi` 只保留 `openai-completions`，但 `Api` 仍是开放的字符串类型，保留将来注册其他接口的可能。

### 5.6 图片生成：只留类型

保留 `types.ts` 中的 `ImageModel`、`ImagesContext`、`AssistantImages`、`ImagesOptions`、`ProviderImages` 等类型定义，以及 `Provider` 上对应的可选字段。不实现任何图片接口，不复刻 `images.ts`、`images-api-registry.ts`、`image-models.ts`、`providers/images/`、`api/openrouter-images.ts`。在 `DIFF.md` 注明“图片生成预留，未实现”。

---

## 6. 模块二：`pi4java-agent`（对应 `$PI/packages/agent`）

| 上游文件 | 处理 |
|---|---|
| `src/types.ts` | 完整复刻 |
| `src/agent-loop.ts` | 完整复刻 |
| `src/agent.ts` | 完整复刻 |
| `src/stream-fn.ts`、`src/index.ts` | 完整复刻 |
| `src/proxy.ts` | 不复刻 |

这个包只有约 2,150 行，是整个项目的心脏，必须逐行对照翻译。特别注意：

- 所有钩子都要有：`beforeToolCall`、`afterToolCall`、`prepareRequest`、`prepareNextTurn`、`prepareNextTurnWithContext`、`finishTurn`、`transformContext`、`convertToLlm`、`getApiKey`、`onPayload`、`getSteeringMessages`、`getFollowUpMessages`。
- 工具执行模式（并行、顺序）以及单个工具的 `executionMode` 覆盖。
- “整批提前结束”规则：只有同一批里**每一个**已完成的工具结果都带 `terminate: true`，循环才提前结束。
- 引导消息和后续消息两个队列，以及各自的 `one-at-a-time` / `all` 模式。
- 事件类型和发出顺序：`agent_start`、`turn_start`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`turn_end`、`agent_end`。
- 中止时的行为：已发出的消息如何收尾、未执行的工具调用如何处理。

完成标准：`$PI/packages/agent/test/` 下 `agent-loop.test.ts`、`agent.test.ts`、`agent-tool-typebox.test.ts` 全部移植并通过。`e2e.test.ts` 中需要真实模型的用例不移植；`proxy.test.ts` 不移植。

---

## 7. 模块三：`pi4java-coding-agent`（对应 `$PI/packages/coding-agent`）

只涉及 `src/core/` 和 `src/utils/`。`src/modes/`、`src/cli/`、`src/extensions/`（随包扩展）、`src/bun/`、`src/experimental/` 全部不复刻。

### 7.1 `src/core/` 文件清单

| 上游文件 | 处理 | 说明 |
|---|---|---|
| `agent-session.ts` | 部分复刻 | 见 7.2 |
| `sdk.ts`、`agent-session-runtime.ts`、`agent-session-services.ts` | 复刻 | 会话创建入口与服务装配。`createAgentSession` 的选项与上游一致，另加第 9 章的附加选项 |
| `session-manager.ts` | 完整复刻 | 见 7.3 |
| `session-cwd.ts` | 复刻 | |
| `compaction/` 全部 | 完整复刻 | 压缩与分支摘要，含提示词文本 |
| `tools/` 下除 `renderers/`、`render-utils.ts` 外全部 | 复刻 | 见 7.5 |
| `bash-executor.ts`、`exec.ts` | 复刻 | |
| `system-prompt.ts`、`messages.ts` | 完整复刻 | 文本逐字一致 |
| `settings-manager.ts`、`settings-schema.ts`、`settings-defaults.ts` | 部分复刻 | 见 7.6 |
| `resource-loader.ts` | 部分复刻 | 见 7.7 |
| `skills.ts`、`prompt-templates.ts` | 完整复刻 | 技能与提示词模板，含 `utils/frontmatter.ts` |
| `slash-commands.ts` | 部分复刻 | 留下 `prompt()` 处理输入时需要的命令解析、提示词模板展开、技能命令；去掉只服务交互界面的内置命令 |
| `model-runtime.ts`、`model-resolver.ts`、`model-registry.ts`、`model-config.ts`、`provider-composer.ts`、`runtime-credentials.ts`、`models-store.ts` | 部分复刻 | 见 7.8 |
| `nested-tool-calls.ts` | 完整复刻 | 工具内部再调工具 |
| `extensions/types.ts`、`extensions/runner.ts`、`extensions/wrapper.ts`、`extensions/index.ts` | 部分复刻 | 见第 8 章 |
| `extensions/loader.ts` | 改写 | 见第 8 章 |
| `usage-totals.ts`、`cache-stats.ts` | 完整复刻 | |
| `event-bus.ts`、`source-info.ts`、`diagnostics.ts`、`defaults.ts` | 复刻 | 被上面各项引用 |
| `http-dispatcher.ts` | 部分复刻 | 读懂它设定的超时和代理行为，对应到 `HttpClient` 的配置上 |
| `telemetry.ts` | 部分复刻 | 接到 `pi4java-telemetry` 的接口上 |
| `resolve-config-value.ts` | 按需 | 仅当被范围内的代码用到时移植被用到的部分 |
| `cache-warmer.ts` | 不复刻 | `AgentSession` 中调用它的地方全部去掉 |
| `package-manager.ts`、`auth-storage.ts`、`auth-guidance.ts`、`trust-manager.ts`、`project-trust.ts`、`mcp-servers.ts`、`radius.ts`、`radius-mcp.ts`、`remote-catalog-provider.ts`、`virtual-models.ts`、`footer-data-provider.ts`、`keybindings.ts`、`bug-report.ts`、`crash-log.ts`、`export-html/`、`output-guard.ts`、`timings.ts`、`pi-ai-schemas.ts`、`extensions/jiti-loader.ts`、`extensions/jiti-static-loader.ts`、`extensions/virtual-modules.ts`、`extensions/pi-ai-extension-view.ts`、`experimental.ts` | 不复刻 | |

`src/config.ts`：只复刻路径相关的常量和函数（配置目录名、`getAgentDir`、`getSessionsDir`、`getSettingsPath`、`getPromptsDir`、环境变量名等）。**默认目录与 Pi 相同**，这样 pi4java 写的会话文件 Pi 可以直接打开，反之亦然。去掉安装方式检测、自更新、打包资源路径等。

`src/utils/`：复刻 `shell.ts`、`child-process.ts`、`paths.ts`、`frontmatter.ts`、`abort.ts`、`output-files.ts`、`text` 相关（如 `splitBom`），以及被范围内代码引用的其他小工具。不复刻剪贴板、图片处理、语法高亮、变更日志、版本检查、自更新、zip、`git.ts`、`tools-manager.ts`（改写，见 7.5）。

### 7.2 `AgentSession`

约 4,600 行，按下面的取舍翻译。

**保留**：

- `prompt`、`steer`、`followUp`、`sendUserMessage`、`sendCustomMessage` 及输入预处理（提示词模板展开、技能命令、`input` 事件）
- `abort`、`waitForIdle`、`dispose`、`subscribe`
- 自动重试的全部逻辑（`_isRetryableError`、退避、`abortRetry`、`setAutoRetryEnabled`、`auto_retry_start` / `auto_retry_end` 事件）
- 压缩：手动 `compact`、`abortCompaction`、自动压缩（阈值触发和溢出触发）、`setAutoCompactionEnabled`，以及相关事件
- 工具管理：`getActiveToolNames`、`getAllTools`、`setActiveToolsByName`、工具的 `defaultActive`、系统提示词随工具变化而重建
- 模型与思考级别的读取和切换（`setModel` 等），去掉其中的虚拟模型和订阅登录分支
- 会话树：分支导航（`navigateTree`）、分叉、分支摘要
- “收尾边界”机制：`turn_end` 与 `agent_before_settle` 两个可返回 `BoundaryResult` 的事件，以及随后的 `agent_settled`。**这是使用方实现“提交校验、失败修复、出错续跑”的基础，必须完整且准确**，见 8.4
- `executeBash`（用户直接执行命令并记入会话）
- 统计：会话统计、用量累计、上下文占用
- `reload`

**去掉**：

- 缓存保活相关的全部代码
- 图片相关：排队图片、图片缩放。`blockImages` 设置保留，其“过滤图片内容”的防御逻辑保留
- MCP、`codemode`、工具搜索相关的分支
- 只为交互界面服务的状态和回调

去掉任何一段代码时，如果它影响了其他保留逻辑的行为，登记到 `DIFF.md`。

### 7.3 `SessionManager`

- 会话文件是 JSONL：第一行是会话头，其后每行一条记录。当前格式版本是 `3`（`CURRENT_SESSION_VERSION`）。
- 记录类型全部复刻：消息、思考级别变更、模型变更、用量、压缩、分支摘要、自定义记录、标签、会话信息、自定义消息、上下文编辑。
- 复刻旧版本到新版本的迁移逻辑。
- 复刻全部静态入口：`create`、`open`、`continueRecent`、`inMemory`、`forkFrom`、`findById`，以及列举会话的函数。
- 文件命名、目录结构（按工作目录分目录的规则）、写入时机（何时落盘、何时追加）都与上游一致。
- **互通性是硬指标**：见 10.4。

### 7.4 系统提示词

`system-prompt.ts` 的输出逐字一致，包括：工具列表段落的生成（每个工具的 `promptSnippet`、`promptGuidelines`）、上下文文件段落、技能段落、日期与工作目录的格式。日期等动态内容通过可注入的 `Clock` 生成，测试里固定时间后与上游输出比对。

### 7.5 原生工具

复刻八个工具：`read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`。工具名、标签、说明、参数 Schema、`promptSnippet`、`promptGuidelines` 逐字一致。默认启用哪些工具以上游的 `DEFAULT_TOOL_NAMES` 为准（在 `settings-manager.ts` 及其引用处查实），第 9 章对默认清单有两处追加。

| 工具 | 要点 |
|---|---|
| `read` | 行范围、截断规则（`truncate.ts`）、BOM、二进制判断。遇到图片文件：pi4java 不支持图片输入，按上游“图片被禁用”时的分支处理；上游若无对应分支，返回一条明确的文本说明，并登记到 `DIFF.md` |
| `write` | 自动建目录、文件修改队列 |
| `edit` | `edit-diff.ts` 的匹配规则是重点：精确匹配、模糊匹配的退化顺序、多处匹配的报错、换行符保持、BOM 保持。差异文本用 java-diff-utils 生成后，格式要与上游一致（有测试） |
| `bash` | Shell 的选择（`utils/shell.ts`，含 Windows 下找 Git Bash 的逻辑）、`commandPrefix`、`spawnHook`、`exposeSessionEnvironment`、超时、输出累积与截断（`output-accumulator.ts`）、超长输出落临时文件、进程树终止、流式进度更新的节流 |
| `powershell` | `powershell.ts`，与 `bash` 共用执行框架 |
| `grep` | 调用外部程序 `rg`，命令行参数与上游完全一致，解析它的 JSON 输出 |
| `find` | 调用外部程序 `fd`，参数与上游一致；支持自定义的 `glob` 操作 |
| `ls` | 排序、条数上限、截断 |

`file-mutation-queue.ts`：同一文件的写操作串行化，Java 里按规范化后的绝对路径加锁实现，语义与上游一致。

各工具都有可替换的“操作接口”（如 `BashOperations`、读写操作），用于把执行转到别处。这些接口要保留。

**`rg` 和 `fd` 的来源**：上游的 `utils/tools-manager.ts` 会在找不到时从 GitHub 下载。pi4java **不下载**：按“调用方显式配置的路径 → 系统 PATH”的顺序查找（保留上游对系统里别名的查找，如 `fdfind`）；找不到时报错，文案去掉“无法下载”的部分。登记到 `DIFF.md`，并在 README 写明运行环境需要安装这两个程序。

终端渲染相关的一切（`renderers/`、工具定义里的 `renderCall`、`renderResult`、`renderShell`）不复刻。

### 7.6 设置

`SettingsManager` 的结构（全局设置、项目设置、内存模式、合并规则、读写与迁移）复刻。设置项按下表取舍：

| 保留 | 去掉 |
|---|---|
| `compaction`、`branchSummary`、`retry`、`steeringMode`、`followUpMode`、`images.blockImages`、`shellPath`、`shellCommandPrefix`、`httpIdleTimeoutMs`、`defaultProvider`、`defaultModel`、`defaultThinkingLevel`、`defaultTools`、`enableSkillCommands`、技能与提示词模板相关的路径设置，以及其他被范围内代码读取的项 | 终端显示、主题、快捷键、编辑器、Markdown 渲染、全屏模式、更新日志、安装遥测、警告开关、`codemode`、`cacheWarming`、`transport`、会话分享、信任相关的交互项 |

设置文件里出现被去掉的项时不报错、不丢弃（原样保留在文件里），保证与 Pi 共用同一份设置文件时互不破坏。

默认值以 `settings-defaults.ts` 为准。

新增一个 pi4java 自有的设置项 `maxTurnsPerPrompt`（见 9.6），登记到 `DIFF.md`。

### 7.7 资源加载

`DefaultResourceLoader` 的选项保留：`cwd`、`agentDir`、`settingsManager`、`eventBus`、`additionalSkillPaths`、`additionalPromptTemplatePaths`、`extensionFactories`、`noExtensions`、`noSkills`、`noPromptTemplates`、`noContextFiles`、`systemPrompt`、`appendSystemPrompt`、`skillsOverride`、`promptsOverride`、`agentsFilesOverride`、`systemPromptOverride`、`appendSystemPromptOverride`、`extensionsOverride`。

去掉：主题相关（`additionalThemePaths`、`noThemes`、`themesOverride`）、`additionalExtensionPaths`、`disabledBuiltinExtensions`、从包管理器解析资源的逻辑。

- 上下文文件（`AGENTS.md` 等）的发现规则与上游一致：从哪些目录找、按什么顺序拼接。
- 技能和提示词模板的发现规则与上游一致。
- 扩展只来自 `extensionFactories`（见第 8 章）。

另提供一个便捷预设 `IsolatedResources`（pi4java 自有，登记到 `DIFF.md`）：一次性设置 `noSkills`、`noPromptTemplates`、`noContextFiles`，并配合 `SettingsManager.inMemory`，得到一个不读取任何用户目录内容的会话环境。

### 7.8 模型运行时

目标是保留“使用方注册一个 OpenAI 兼容的模型来源，会话用它发请求”这条路径，以及扩展的 `registerProvider`。

- 保留：`ModelRuntime` 的创建、`registerProvider` / `unregisterProvider`、`getModel`、运行时设置 API Key（`setRuntimeApiKey`）、按名称解析模型（`model-resolver.ts` 中与此有关的部分）、`streamSimple` 的转发、模型的 `compat` 配置。
- 去掉：`auth.json` 与登录、订阅判断、远程模型目录、虚拟模型、`models.json` 自定义模型文件、厂商内置目录、分类器和图片的转发。
- `provider-composer.ts` 只留下把 `registerProvider` 的配置转换成模型定义的部分，且只处理 `openai-completions`。传入其他接口类型时抛出明确的“不支持”异常。

---

## 8. 扩展机制

### 8.1 加载方式（与上游的唯一结构性差异）

上游在运行时从文件加载 TypeScript 扩展。pi4java 的扩展**只通过代码显式注册**：

```java
ExtensionFactory factory = pi -> {
    pi.on(ToolCallEvent.class, (event, ctx) -> { ... });
    pi.registerTool(...);
};

var loader = new DefaultResourceLoader(DefaultResourceLoaderOptions.builder()
    .cwd(cwd).agentDir(agentDir)
    .extensionFactories(List.of(new InlineExtension("my-extension", factory)))
    .build());
```

- `ExtensionFactory` 对应上游的扩展工厂函数，接收 `ExtensionAPI`。
- `InlineExtension` 对应上游同名结构（名称 + 工厂）。
- 扩展的初始化顺序、同一事件多个处理函数的调用顺序，与上游一致（按注册顺序）。
- `extensions/loader.ts` 中“发现文件、动态加载模块”的部分不复刻；“执行工厂、收集它注册的处理函数、工具、命令”的部分保留。
- 不做自动发现（包括 `ServiceLoader`）。在 README 注明留待以后。

### 8.2 `ExtensionAPI`

**事件**：下面这些事件，只要其触发点位于已复刻的代码里，就要复刻，名称、事件对象的字段、处理函数的返回值语义与上游一致：

`session_start`、`session_info_changed`、`session_before_switch`、`session_before_fork`、`session_before_compact`、`session_compact`、`session_compact_failed`、`session_shutdown`、`session_before_tree`、`session_tree`、`resources_discover`、`context`、`context_with_system`、`before_provider_request`、`before_provider_headers`、`after_provider_response`、`provider_stream_event`、`before_agent_start`、`agent_start`、`agent_end`、`agent_before_settle`、`agent_settled`、`ui_prompt_start`、`ui_prompt_end`、`turn_start`、`turn_end`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`model_select`、`thinking_level_select`、`tool_call`、`tool_result`、`user_bash`、`input`。

不复刻的事件：`project_trust`、`mcp_servers_change`、`cache_warming_decision`。其余事件若其触发点全部落在不复刻的代码里，也不复刻。所有未复刻的事件登记到 `DIFF.md`。

Java 里事件订阅的写法由开发者定（按事件类或按事件名均可），但必须满足：事件名字符串与上游一致并可取得；`on` 返回取消订阅的句柄；处理函数能返回上游规定的结果对象。

**方法**：

| 保留 | 去掉 |
|---|---|
| `registerTool`、`registerCommand`、`registerFlag` / `getFlag`、`sendMessage`、`sendUserMessage`、`appendEntry`、`setSessionName` / `getSessionName`、`getActiveTools` / `setActiveTools`、`getAllTools`、`registerProvider` / `unregisterProvider`，以及 `ExtensionAPI` 上其余不涉及界面的方法（读 `extensions/types.ts` 的完整定义逐个判断） | `registerShortcut`、`registerMessageRenderer`、`registerMarkdownTransformer`、`registerEntryRenderer`、`registerToolRenderer` |

`registerFlag`：没有命令行，标志的值由使用方在创建会话时以键值表传入；未传入时取注册时的默认值。

`ToolDefinition`：保留 `name`、`label`、`description`、`promptSnippet`、`promptGuidelines`、`parameters`、`prepareArguments`、`outputSchema`、`exposure`、`namespace`、`reachesTools`、`annotations`、`defaultActive`、`prepareLoadout`、`executionMode`、`constrainedSampling`、`execute`。去掉 `renderCall`、`renderResult`、`renderShell` 及其他渲染字段。

`ExtensionContext` 和工具执行时的 `ExtensionToolContext`（含 `executeTool`）：保留全部不涉及界面的成员。

### 8.3 界面交互上下文

上游的 `ExtensionUIContext` 大部分方法是给终端界面用的。pi4java 只保留无界面场景下有意义的子集。

**判定依据**：上游的 RPC 模式是 Pi 自己定义的“无界面宿主”，它把一部分界面请求转发给外部客户端。读 `$PI/packages/coding-agent/src/modes/rpc/rpc-mode.ts` 和 `$PI/packages/coding-agent/docs/rpc-extension-ui.md`，凡是 RPC 模式会转发给客户端的方法就保留，其余去掉。预期保留的至少包括 `select`、`confirm`、`input`、`notify`，是否包括 `editor`、`setStatus`、`setTitle` 等以该文档为准。

- 使用方在创建会话时可传入一个 `ExtensionUIContext` 实现；不传时使用上游的空实现（`noOpUIContext` 的行为：读 `extensions/runner.ts` 确认每个方法在无界面时返回什么），此时 `hasUI` 为 `false`。
- `ui_prompt_start`、`ui_prompt_end` 事件随界面提示的开始和结束发出，与上游一致。

### 8.4 收尾边界（重点）

这是使用方最依赖的扩展点，必须在动手前把上游实现完全读懂。相关定义在 `extensions/types.ts`（`BoundaryState`、`BoundaryResult`、`AgentBeforeSettleEvent`、`AgentSettledEvent`、`SessionBoundaryDraft` 及其四种记录草稿），实现在 `agent-session.ts`。

需要准确复刻并用测试固定下来的行为：

- `agent_before_settle` 在一次运行最终收尾前触发，事件里带有：本次运行的结果（`completed`、`aborted`、`error`）、待追加的记录、是否继续、上下文预览（含“能否继续”标志）。
- 处理函数可以返回要追加的记录（自定义记录、自定义消息、上下文编辑、压缩）和 `continue: true`，使会话再发一次模型请求。
- 多个处理函数依次执行，后一个能看到前一个修改后的状态。
- `turn_end` 也能返回同样的结果对象。
- `agent_settled` 在运行彻底结束、且不会再有自动重试、压缩或排队续跑时触发，带有是否被中止的标志。
- 运行以错误或中止结束时，`agent_before_settle` 是否触发、`continue` 是否生效、与自动重试的先后关系。

上游测试 `test/suite/agent-session-boundaries.test.ts` 必须完整移植。另外为“出错结束时返回 `continue`”“中止时返回 `continue`”各补一个测试，把上游的实际行为固定下来，并把结论写进 README 的扩展章节（使用方要靠它实现出错续跑）。

---

## 9. 内置附加能力（pi4java 自有）

这一章的内容不来自 Pi，来自易标项目在 Pi 之上积累的做法。它们全部放在包 `io.github.fb208.pi4java.codingagent.extras`，对复刻部分的改动只有三处，都要登记到 `DIFF.md`：

1. `createAgentSession` 的选项多一个 `extras` 字段（类型 `ExtrasOptions`）。
2. 默认启用的工具清单多两个名字：`json-validation`、`ask-user`。
3. 设置项多一个 `maxTurnsPerPrompt`。

除此之外，附加能力只通过第 8 章的扩展接口和第 6 章的钩子工作。

**提示文本的语言**：本章涉及的工具说明、追加的系统提示词、返回给模型的文字，默认**逐字沿用易标项目的中文原文**（下文给出了出处，短的直接给出全文）。每一项都要允许使用方整体替换文本。

**状态的取得方式**：Pi 的 `prompt()` 没有返回值，`abort()` 也不带原因。附加能力需要告诉使用方“为什么停了”时，统一做法是：每个附加能力是一个使用方持有的对象，对象上有查询方法和可选的回调。使用方在 `prompt()` 返回后查询这些对象。不要为此修改 `AgentSession` 的接口。

总览：

| 序号 | 能力 | 默认 | 形式 |
|---|---|---|---|
| 9.1 | JSON 自查工具 `json-validation` | 开启，可关闭 | 自带工具 |
| 9.2 | 提问工具 `ask-user` | 开启（需使用方提供交互实现），可关闭 | 自带工具 |
| 9.3 | 终止需确认 `report-failure` | 关闭 | 可选工具 |
| 9.4 | 关闭结束总结 | 关闭 | 可选配置 |
| 9.5 | 固定工具列表 | 关闭 | 可选配置 |
| 9.6 | 每条提示词的轮数上限 | 不限制 | 可选配置，支持全局默认值 |
| 9.7 | 无进展看门狗 | 关闭 | 可选配置 |
| 9.8 | 受保护文件 | 关闭 | 可选配置 |
| 9.9 | 会话记录导出为文本 | — | 工具方法 |

明确**不纳入**的（由使用方在自己的业务层或以扩展形式实现，pi4java 不提供）：提交校验、提交修复策略、执行异常重试、多阶段编排、持久任务目录与检查点、输入与产物文件准备、空转检测与诊断、子代理限流、中断原因归一、推荐项自动回答、命令垫片、模型请求代理、自检、统计上报。

### 9.1 JSON 自查工具 `json-validation`

出处：`$YIBIAO/client/electron/services/pi/piJsonValidationTool.cjs`。

- 工具名 `json-validation`，标签 `JSON 校验`。说明、`promptSnippet`、参数说明逐字取自出处文件。
- 参数：`file_path`（必填，工作区内的相对路径）、`schema`（可选，对象或布尔值；仅当该文件没有预置 Schema 时由模型提供，按 JSON Schema Draft-07）。不允许其他属性。
- 预置 Schema：使用方通过 `ExtrasOptions` 传入“相对路径 → Schema”的映射，并可在会话运行期间更新。路径匹配规则与出处一致：统一成 `/` 分隔后规范化；Windows 下不区分大小写。
- 执行流程与出处一致，分四个阶段，任一阶段失败即返回：
  1. `read`：路径必须是非空相对路径且不能越出工作区，读取文件；
  2. `parse`：解析 JSON；
  3. `schema`：取预置 Schema，没有则用模型提供的；两者都没有时报错 `任务未为 <相对路径> 预置 Schema，调用时必须提供 schema`；编译 Schema；
  4. `validation`：校验，收集全部错误。
- 返回内容是下面结构的 JSON 文本（两个空格缩进），同时作为 `details`；校验未通过时结果标记为错误：

  ```json
  {
    "valid": false,
    "stage": "validation",
    "file_path": "相对路径",
    "errors": [{ "instancePath": "/a/0", "schemaPath": "...", "keyword": "type", "message": "...", "params": {} }],
    "message": "校验未通过，请根据 errors 修复文件后重新校验。"
  }
  ```

  成功时 `stage` 为 `success`，`errors` 为空数组，`message` 为 `JSON.parse 和 Ajv 校验均已通过。`。`read`、`parse`、`schema` 阶段失败时 `errors` 是只含 `message` 的单元素数组。各阶段的报错文案取自出处文件。
- 出处用的是 Ajv（`allErrors: true, strict: true`）。Java 用 JSON Schema 校验库实现，`errors` 各字段尽量给出等价信息（`instancePath` 用 JSON Pointer，根路径为 `/`）。说明文字里提到 “Ajv” 的地方保持原文不改。差异登记到 `DIFF.md`。
- 默认注册并启用。使用方可用 Pi 原生的方式关闭：`excludeTools`、`tools` 选项里写 `-json-validation`，或 `defaultTools` 设置。

### 9.2 提问工具 `ask-user`

出处：`$YIBIAO/client/electron/services/pi/piUserQuestionTool.cjs`。

- 工具名 `ask-user`，标签 `询问用户`，`executionMode` 为顺序执行。说明、`promptSnippet`、八条 `promptGuidelines`、参数说明逐字取自出处文件。
- 参数：`question`（必填字符串）、`options`（2 到 5 项的数组，每项含 `label` 必填、`description` 可选、`custom` 必填布尔值）。不允许其他属性。
- 执行前的检查与报错文案（取自出处）：`custom` 为真的选项超过一个时报 `自定义输入选项最多只能有一个，请调整选项后重新提问`；第一个选项的 `custom` 为真时报 `推荐选项不能要求用户补充输入，请调整选项后重新提问`。
- 交互由使用方提供。pi4java 定义接口：

  ```java
  public interface UserQuestionHandler {
      UserAnswer ask(UserQuestion question, CancellationToken token);
  }
  // UserQuestion: toolCallId, question, options(label, description, custom, recommended), autoAnswerAllowed
  // UserAnswer:   answer, selectedOption, isCustom
  ```

  第一个选项的 `recommended` 为真。`autoAnswerAllowed` 是给使用方的提示（是否允许它自动选择推荐项），pi4java 自己不做任何自动回答。
- 返回给模型的是 JSON 文本（两个空格缩进）：`{"answered": true, "answer": "...", "selected_option": "...", "is_custom": false}`。
- **是否注册**按下面的顺序决定：
  1. 使用方提供了 `UserQuestionHandler`：注册，用它；
  2. 没提供，但会话有界面交互上下文（`hasUI` 为真）：注册，用 `ui.select` 展示选项（每项显示为 `标签 — 说明`），选中的是自定义项时再用 `ui.input` 取输入；
  3. 两者都没有：**不注册**这个工具，模型看不到它。
- 等待回答期间，9.7 的看门狗暂停计时。
- 关闭方式同 9.1。

### 9.3 终止需确认 `report-failure`

出处：`$YIBIAO/client/electron/services/pi/piTaskFailureTool.cjs`。默认不启用，使用方通过 `ExtrasOptions` 开启。

工具名 `report-failure`，参数只有必填的 `reason`。出处文件里有两套完整定义（标签、说明、`promptSnippet`、`promptGuidelines`、参数说明都不同），逐字照搬：

- **直接失败模式**（使用方没有提供可用的提问通道，或显式选择此模式）：标签 `报告任务失败`。执行时记录失败原因，中止当前运行，返回 `{"reported": true, "reason": "..."}`。
- **确认模式**（有提问通道，同 9.2 的判定）：标签 `请求终止任务`。执行时向用户提问，问题文本由出处的 `buildTerminationQuestion(reason)` 生成，选项固定三个（标签和说明取自出处）：`降低质量继续`、`终止任务`、`补充处理要求`（最后一个是自定义输入）。
  - 用户选 `终止任务`：记录失败原因 `<reason>（已按您的选择终止任务）`，中止运行，返回 `{"terminated": true, "reason": "..."}`。
  - 其他选择：返回出处 `buildContinueInstruction(answer)` 生成的文字作为工具结果，模型据此继续。
  - 首次提问时 `autoAnswerAllowed` 为真；用户选过一次继续之后，同一会话内再次调用时为假。

使用方通过附加能力对象查询：是否已报告失败、失败原因。失败原因的错误码常量为 `AGENT_REPORTED_FAILURE`。

### 9.4 关闭结束总结

出处：`$YIBIAO/client/electron/services/pi/piSummaryControl.cjs`，以及 `piSessionFactory.cjs` 中使用它的部分。

目的：Agent 干完活后通常还会再发一次模型请求输出一段总结。开启本项后，模型在最后一批工具调用上做个标记，这批工具全部成功就直接结束，省掉那次请求。

开启后（`ExtrasOptions.summary(false)`）做三件事：

1. **追加系统提示词**：出处中的 `PI_NO_SUMMARY_INSTRUCTIONS` 全文，逐字照搬。
2. **给工具加参数**：除 `ask-user`、`report-failure` 外的每个工具（原生的和自定义的），参数 Schema 里追加一个布尔属性 `task_complete`，说明文字为 `仅在当前阶段全部工作完成时设为 true；当前批次全部工具成功后结束本轮，不再生成总结。`。工具真正执行前把这个参数去掉，工具实现收不到它。
3. **工具执行后的钩子**：检查本次工具调用所属的那条助手消息，只要其中任一工具调用带 `task_complete === true`，就对这一批里**每个成功的**工具结果返回 `terminate: true`；失败的返回 `terminate: false`。配合第 6 章的“整批提前结束”规则，效果是：整批都成功才结束，任一失败则继续循环。要保留已有钩子的结果并在其基础上叠加。

可选：使用方提供一个判定函数 `isFinalToolCall(toolCall)`。提供后，第 2 步不再加参数，第 3 步改用这个函数判断“是否请求结束”。

实现位置：第 2 步需要在会话组装工具时包一层，这是对复刻部分的一处改动，做成一个内部的“工具定义变换”接入点，默认为空，登记到 `DIFF.md`。

### 9.5 固定工具列表

出处：`$YIBIAO/client/electron/services/pi/piSessionFactory.cjs`。

目的：模型服务按请求前缀做缓存，工具清单或系统提示词一变，缓存就失效。开启本项后，所有工具始终出现在请求里，系统提示词不变；“当前允许调用哪些”改由执行前拦截来控制。

开启后（`ExtrasOptions.fixedToolList(true)`）：

- 会话中注册的全部工具始终处于启用状态。
- 追加系统提示词（逐字）：`工具列表覆盖本任务的全部阶段。read、write、edit、bash、grep、find、ls 全程可用，优先按当前任务指导选择工具；业务工具仍按当前阶段使用。`
- 附加能力对象提供 `setAllowedTools(名称集合)`。原生工具 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` 始终允许，不受该集合影响。初始允许集合为全部工具。
- 监听 `tool_call` 事件：被调用的工具不在允许集合内时，返回 `block: true`，原因文本（逐字）：`当前阶段不能调用 <工具名>，请只使用当前阶段说明的工具。`
- 这个拦截要先于使用方自己注册的 `tool_call` 处理函数执行。

开启本项后，使用方应改用 `setAllowedTools` 切换阶段权限；若仍调用原生的 `setActiveToolsByName`，按原生语义生效（会改变工具清单，缓存失效），在 README 说明。

### 9.6 每条提示词的轮数上限

目的：防止模型一直调工具停不下来。这种情况下一直有活动，看门狗不会触发。

- 取值来源，优先级从高到低：创建会话时 `ExtrasOptions.maxTurnsPerPrompt(n)` → 设置项 `maxTurnsPerPrompt` → 出厂默认 `0`。`0` 表示不限制。
- 监听 `turn_start` 计数。每开始一次新的运行（一次 `prompt()` 引发的运行）计数清零；上下文压缩不清零。经由 `agent_before_settle` 返回 `continue` 而续接的请求是否属于同一次运行，按 8.4 读出的上游行为处理，并在 README 写明。
- 第 `n + 1` 轮开始时中止运行。
- 附加能力对象提供查询：是否因超限而停、上限值。错误码常量 `AGENT_TURN_LIMIT`，说明文本：`Agent 在一次提示后已连续执行 <n> 轮仍未结束，已停止本次运行`。

### 9.7 无进展看门狗

出处：`$YIBIAO/client/electron/services/pi/piRuntimeService.cjs` 中的 `startWatchdog`、`touchActivity`、`subscribeSession`、`waitForUserQuestion`。

目的：一段时间内既没有模型数据也没有工具活动，就认定卡死并中止。

- 开启：`ExtrasOptions.idleTimeout(时长)`。不设置即关闭。易标项目使用的值是 8 分钟，可作为 README 中的建议值。
- 只在运行进行期间计时（从 `agent_start` 到 `agent_settled`）。会话空闲时不计时。
- 下列事件发生时刷新“最近活动时间”：`agent_start`、`agent_end`、`turn_start`、`turn_end`、`message_start`、`message_update`、`provider_stream_event`、`after_provider_response`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、压缩开始与结束、自动重试开始与结束。
- 暂停计时：`ask-user` 或 `report-failure` 正在等待用户回答期间；任何界面提示进行期间（`ui_prompt_start` 到 `ui_prompt_end`）。恢复时把最近活动时间设为当前时间。
- 附加能力对象提供 `touch()`，使用方可手动报告活动。典型用法：工具内部启动了另一个会话，把子会话的活动传给父会话；模型请求在外部服务里排队时由使用方定期报告。
- 每 2 秒检查一次。超时后中止运行。
- 附加能力对象提供查询：是否因无进展而停。错误码常量 `AGENT_STALLED`，说明文本：`Pi Agent 长时间无进展，已停止本轮任务`。可选回调 `onStalled`。

### 9.8 受保护文件

出处：`$YIBIAO/client/electron/services/pi/piWorkspaceBaseline.cjs`。

目的：使用方写进工作区、不希望 Agent 改动的文件（如输入材料），在每次运行收尾前自动还原。

类 `ProtectedFiles`，构造参数：工作区目录、基线目录（必须在工作区之外，由使用方指定）。

- `protect(分组名, 文件列表)`：追加或刷新登记。文件不存在则不登记。
- `setGroup(分组名, 文件列表)`：用当前内容整体替换该分组。
- `release(分组名, 文件列表)`：解除登记。
- `files(分组名)`：列出该分组登记的相对路径。
- `restore()`：比对并还原，返回被还原的相对路径列表。

实现与出处一致：

- 登记键是工作区内的 POSIX 风格相对路径；越出工作区的路径报错 `受保护文件必须位于工作区内：<路径>`。
- 基线目录下：`manifest.json`（结构 `{"groups": {分组名: {相对路径: {"hash", "size", "mtime"}}}}`，先写临时文件再改名）和 `files/<sha256>`（原件副本，按内容哈希命名，多个登记共用）。保存时清理不再被引用的副本。
- 还原判定：文件存在且大小、修改时间都未变，视为未改；否则算哈希，哈希相同只更新记录的修改时间；其余情况（被改、被删）用副本覆盖回去。
- 登记信息随基线目录持久保存，重新构造对象后继续有效。
- 出处的 `saveRecord`、`loadRecord` 不移植。

作为扩展使用时（`ExtrasOptions.protectedFiles(对象)`）：监听 `agent_before_settle`，在运行结果为“完成”或“出错”时调用 `restore()`，不向会话追加任何内容，也不要求继续。还原结果通过对象上的 `lastRestored()` 和可选回调 `onRestored` 提供给使用方。这个处理函数要先于使用方自己注册的 `agent_before_settle` 处理函数执行，这样使用方做校验时看到的是还原后的文件。

### 9.9 会话记录导出为文本

出处：`$YIBIAO/client/electron/services/pi/piStallDiagnosis.cjs` 中的 `extractSessionRecord`。

提供一个静态工具方法：给定 `SessionManager` 和一个起始记录 ID（可空，表示从头），把当前分支上此后的记录整理成一段可读文本（助手文字、工具调用及参数摘要、工具结果摘要、用户消息）。摘录的格式、各部分的截断长度按出处实现。出处里与“阶段”有关的参数改为一个可选的标题字符串。

用途是让使用方把一段执行过程交给另一个 Agent 分析。pi4java 不提供分析本身。

---

## 10. 测试与验收

没有测试就无法判断翻译是否正确。测试是交付物的一部分，不是可选项。

### 10.1 假模型来源

`$PI/packages/ai/src/providers/faux.ts` 是上游专为测试准备的模型来源：按预先编排的序列返回响应，不联网。完整复刻它，并移植 `test/faux-provider.test.ts`。后面绝大多数测试都建立在它上面。

同时复刻上游的测试支架：`$PI/packages/coding-agent/test/suite/harness.ts`（新支架，优先用它），以及被范围内测试用到的 `test/utilities.ts`、`test/test-harness.ts` 中的部分。

### 10.2 移植上游测试

规则：**被测代码在复刻范围内的测试都要移植**。在 `TEST_MAP.md` 逐个文件登记“移植 / 不移植 / 部分移植”和原因。需要真实模型、真实 Key 或网络的用例不移植。

必须移植的最小集合：

| 包 | 测试 |
|---|---|
| `agent` | `agent-loop.test.ts`、`agent.test.ts`、`agent-tool-typebox.test.ts` |
| `ai` | `faux-provider`、`retry`、`overflow`、`context-overflow`、`context-estimate`、`streaming-json`、`streaming-tool-arguments`、`json-parse`、`validation`、`validation-probes`、`event-stream`、`error-body`、`provider-error-body-passthrough`、`provider-error-body-regression`、`provider-retry`、`pre-generation-error`、`unicode-surrogate`、`tool-call-id-normalization`、`tool-call-without-result`、`transcript-tool-changes`、`strict-tool-limits`、`clamp-max-tokens`、`abort`、`identity`、`models-runtime`、`models-entry`、`compat-schema`（OpenAI Chat Completions 部分），以及全部 `openai-completions-*.test.ts` |
| `coding-agent` | `test/suite/` 下除 MCP、`codemode`、虚拟模型以外的全部；`test/session-manager/` 全部；`agent-session-*.test.ts`（排队图片除外）；`compaction*.test.ts`、`branch-summarization.test.ts`、`branch-summary-extensions.test.ts`；`tools.test.ts`、`path-utils.test.ts`、`file-mutation-queue.test.ts`、`edit-*.test.ts`（去掉只测界面重绘的）、`diff.test.ts`、`grep-operations.test.ts`、`find-abort-before-spawn.test.ts`、`read-streaming.test.ts`、`truncate-surrogates.test.ts`；`bash-executor-truncation.test.ts`、`exec*.test.ts`、`shell-*.test.ts`、`powershell-*.test.ts`、`windows-shell-config.test.ts`；`settings-manager*.test.ts`、`default-tools-setting.test.ts`；`resource-loader.test.ts`、`skills.test.ts`、`sdk-skills.test.ts`、`prompt-templates.test.ts`、`frontmatter.test.ts`；`system-prompt.test.ts`、`system-prompt-updates.test.ts`、`tool-system-prompt-contributions.test.ts`；`extensions-runner.test.ts`、`extensions-input-event.test.ts`、`compaction-extensions.test.ts`、`nested-tool-calls.test.ts`；`usage-totals.test.ts`、`cache-stats.test.ts`；`sdk-session-manager.test.ts`、`sdk-stream-options.test.ts`、`session-*.test.ts`（去掉界面选择器的）、`custom-message.test.ts`、`block-images.test.ts`、`model-resolver.test.ts`（范围内的部分） |

上游测试里依赖范围外功能的个别用例，可以单独跳过并在 `TEST_MAP.md` 写明。不允许为了让测试通过而修改断言的期望值；期望值与实现不符时，先怀疑实现。

### 10.3 黄金样本测试

下面几类输出会直接进入模型请求，除了移植上游测试，还要各建一组黄金样本做逐字比对：

1. **原生工具的定义**：八个工具各自的名称、说明、参数 Schema（序列化成 JSON 后比对）。
2. **系统提示词**：固定时间、固定工作目录、几种工具组合下的完整文本。
3. **完整请求体**：用假模型来源以外的一个“记录请求”的桩实现，跑几个固定场景（单轮问答、带工具调用的多轮、压缩之后、带思考内容、不同兼容项组合），把发出的 `chat/completions` 请求体存成样本比对。

样本的来源：本机有 Node.js（22 及以上）时，在 `$PI` 里写一个小脚本，用上游代码生成这些输出，存到 pi4java 仓库的 `src/test/resources/golden/`，并把脚本一并提交到 `tools/golden/`。本机没有 Node.js 时，按源码手工推导样本，并在 `TEST_MAP.md` 标注“样本为手工推导，待用上游代码复核”。

### 10.4 会话文件互通测试

- 用 `$PI/packages/coding-agent/test/` 里现成的会话文件样本（`fixtures/` 和 `session-manager/` 测试用到的），验证 Java 能正确读取，并且“读入再写出”得到的每一行与原文件在 JSON 语义上相等。
- 构造一组覆盖全部记录类型的会话，用 Java 写出后，检查每一行的字段名、字段集合与上游类型定义一致。
- 覆盖旧版本文件的迁移。

### 10.5 附加能力的测试

第 9 章每一项都要有自己的测试，全部基于假模型来源：

- `json-validation`：四个阶段各自的失败路径、预置与自带 Schema、路径越界、Windows 大小写。
- `ask-user`：三种注册条件、两条参数检查、返回格式、等待期间看门狗暂停。
- `report-failure`：两种模式、三个选项各自的结果、第二次调用时 `autoAnswerAllowed` 为假。
- 关闭结束总结：整批成功则结束且没有后续模型请求；任一失败则继续；`ask-user` 不带该参数；工具实现收不到 `task_complete`；自定义判定函数。
- 固定工具列表：切换允许集合前后请求里的工具清单和系统提示词完全相同；被拦截时的文案；原生工具不受限。
- 轮数上限：三级取值优先级、清零时机、超限中止。
- 看门狗：超时中止、各类活动刷新、暂停与恢复、`touch()`、空闲时不计时（用可控时钟，不要真的等待）。
- 受保护文件：改、删、未改三种情况，分组操作，副本清理，重新构造后仍有效，作为扩展时先于使用方处理函数执行。

### 10.6 真实模型冒烟测试

提供一个默认不执行的测试（通过环境变量或 Maven profile 开启），从环境变量读取 `baseUrl`、API Key、模型名，对一个真实的 OpenAI 兼容服务跑一遍“读文件、改文件、执行命令”的最小任务。仓库里不得出现任何真实的 Key 或地址。

---

## 11. 里程碑

按顺序推进。每个里程碑结束时，该里程碑范围内的测试全部通过，`PORTING_MAP.md`、`TEST_MAP.md`、`DIFF.md` 同步更新。

| 里程碑 | 内容 | 完成标准 |
|---|---|---|
| M0 | 仓库骨架、父 `pom.xml`、各模块空壳、`LICENSE`、`NOTICE`；完成第 4 章的盘点 | 能构建；`PORTING_MAP.md`、`TEST_MAP.md` 初稿提交 |
| M1 | `pi4java-telemetry`、`pi4java-ai` | 5.1–5.3 完成；10.2 中 `ai` 的测试通过；能用假模型来源和桩 HTTP 服务跑通流式请求 |
| M2 | `pi4java-agent` | 第 6 章完成；`agent` 的测试通过 |
| M3 | 会话文件、设置、原生工具、命令执行 | 7.3、7.5、7.6 完成；相关测试和 10.4 通过；工具定义的黄金样本通过 |
| M4 | `AgentSession`、压缩、资源加载、系统提示词、会话创建入口、模型运行时 | 7.2、7.4、7.7、7.8 完成；`test/suite` 中不依赖扩展的测试通过；系统提示词和请求体的黄金样本通过 |
| M5 | 扩展机制、技能与提示词模板 | 第 8 章完成；扩展相关测试和收尾边界测试通过 |
| M6 | 内置附加能力 | 第 9 章完成；10.5 通过 |
| M7 | 收尾 | README（中英文）、Javadoc、示例代码、`DIFF.md` 定稿；10.6 手动跑通一次；发布配置（源码包、文档包、签名）就绪 |

---

## 12. 交付物清单

仓库根目录必须有：

- `README.md`、`README.en.md`：安装、最小示例、如何注册模型来源、如何注册工具和扩展、第 9 章各项的用法、运行环境要求（JDK 21、`rg`、`fd`、Shell）、与 Pi 的差异概述
- `PORTING_MAP.md`：上游文件到 Java 类的完整对照
- `TEST_MAP.md`：上游测试的移植情况
- `DIFF.md`：全部行为差异，每条写明位置、差异内容、原因
- `LICENSE`、`NOTICE`
- `tools/golden/`：生成黄金样本的脚本（如有）

README 的最小示例应当展示这条完整路径：注册一个 OpenAI 兼容的模型来源 → 创建会话 → 订阅事件 → 发提示词 → 读取结果。

---

## 13. 开发中的工作方式

- **先读后写**。翻译一个文件前，先把它和它直接依赖的文件通读一遍。不要边读边写、读到哪写到哪。
- **不确定就查源码，查不到就登记**。不要用“通常是这样”来填补空白。确实无法从源码判断的行为，在 `DIFF.md` 记为“待确认”，并给出当前实现的选择和理由。
- **不加功能**。发现上游有可以改进的地方，不要改；发现缺了本文没提到但看起来有用的功能，不要加。
- **不提前抽象**。上游是具体实现的地方，Java 里也用具体实现，不要为了“将来扩展”引入额外的接口层。
- **本文与源码冲突时**：属于“复刻什么、怎么取舍”的问题，以本文为准；属于“上游具体怎么实现”的问题，以源码为准，并在 `PORTING_MAP.md` 备注本文的不准确之处。
- **提交粒度**：一个上游文件（或一组紧密相关的文件）加上它的测试为一次提交，提交说明里写明对应的上游路径。

## 14. 已知风险点

开发时需要格外小心、优先验证的地方：

| 风险 | 说明 |
|---|---|
| 单线程假设 | 上游代码依赖事件循环的顺序性。按 3.3 的模型实现，并重点移植并发相关的测试（`agent-session-concurrent`、队列、中止） |
| 错误文案 | 自动重试、溢出判定都靠匹配文案。3.4 的格式必须对 |
| 请求体一致性 | 字段顺序不影响语义，但字段集合和取值必须一致。靠 10.3 的黄金样本把关 |
| 流式解析 | SSE 分块边界、工具参数的增量拼接、流中途报错。移植全部相关测试 |
| `edit` 的匹配规则 | 模糊匹配的细节差一点就会改错文件。完整移植 `edit-diff.ts` 的测试 |
| 进程管理 | 超时、中止时结束整个进程树；Windows 与类 Unix 的差异；输出编码 |
| JSON 输出格式 | `JSON.stringify` 的缩进格式和数字格式（3.5） |
| 收尾边界的语义 | 第 8.4 节。使用方的核心业务逻辑建立在它上面 |
| 会话文件互通 | 字段名、空值省略、版本迁移（10.4） |
