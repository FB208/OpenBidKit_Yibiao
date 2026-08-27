# 埋点统计部署手册

本目录维护 `Cloudflare Workers + Analytics Engine + D1 + KV + R2 + Cron Triggers + Workers Static Assets` 埋点统计、Agent 异常日志、模型信息缓存和管理服务。公开仓库不保存 `ACCOUNT_ID`、`ADMIN_TOKEN`、`ANALYTICS_API_TOKEN` 等密钥。

## 地址

| 项目 | 地址 |
| --- | --- |
| API | `https://analytics.agnet.top` |
| Dashboard | `https://static.analytics.agnet.top` |

生产 API Worker 所在 Cloudflare 账户已启用 Workers Paid Plan。当前共配置 6 个 Cron Trigger：5 个埋点统计触发器和 1 个独立模型信息同步触发器。付费套餐在 Cloudflare 账户侧生效，`wrangler.jsonc` 不存在需要声明的套餐字段，不要再按免费计划 5 个 Cron 上限合并这些任务。

## 数据源

| 数据源 | Binding | 用途 |
| --- | --- | --- |
| Analytics Engine `agnet_analytics` | `ANALYTICS` | 详细事件、今天/7天/30天查询、最近事件、Cron 汇总来源 |
| D1 `openbidkit-analytics` | `ANALYTICS_DB` | 新版 `stats_*` 长期统计表 |
| D1 `openbidkit-resources` | `RESOURCE_DB` | 资源管理元数据 |
| R2 `openbidkit` | `RESOURCE_BUCKET` | 资源图片、插件当前版与上一版安装包 |
| R2 `openbidkit-agent-errors` | `AGENT_ERROR_BUCKET` | gzip Agent 完整失败诊断包，保留 7 天 |
| KV | `NOTICE_STORE` | IP 封禁列表、公告、授权配置、GitHub stats 缓存和模型信息精简索引 |

`openbidkit-analytics` 可以在改版时直接删除并由 `setup:analytics-storage` 重建；删除后异常日志元数据会丢失，R2 孤立对象仍由 7 天生命周期自动清理。不要删除 `openbidkit-resources`。

## 接口

| 接口 | 数据源 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `GET /health` | Worker | 无 | 健康检查 |
| `POST /track` | AE + D1 | 无 | 写 AE；从 Cloudflare 真实客户端 IP 请求头记录客户端 IP；新客户端按 `client_created_at` 窗口实时入库，授权字段按快照覆盖既有 `stats_clients` |
| `GET /ip-blocks` | KV + Worker | 无 | 返回全局封禁 IP 列表和 Cloudflare 观测到的请求公网出口 IP，供客户端启动后静默检查 |
| `GET/POST/DELETE /api/ip-blocks` | KV | `ADMIN_TOKEN` | 读取、添加或删除全局精确 IPv4/IPv6 封禁记录；原因可选，封禁时间由 Worker 自动生成 |
| `GET/POST /agent-errors` | D1 + R2 | GET 无；POST 有效可信 license | GET 供客户端预检开关、版本和容量；POST 仅在预检条件仍满足时保存 gzip Agent 失败诊断包 |
| `GET /api/projects` | D1 优先，AE 兜底 | `ADMIN_TOKEN` | 项目列表 |
| `GET /api/overview` | D1 + AE + KV | `ADMIN_TOKEN` | 概览总数、文本 Token、生图次数、新增、今日活跃、每日统计 |
| `GET /api/clients` | D1 | `ADMIN_TOKEN` | 客户端统计列表 |
| `GET /api/client-detail` | AE | `ADMIN_TOKEN` | 单客户端 7天/30天/全部事件明细 |
| `GET /api/ip-stats` | D1 | `ADMIN_TOKEN` | 按最后访问 IP 汇总客户端数，分页返回 |
| `GET /api/traffic` | D1 或 AE | `ADMIN_TOKEN` | 访问分析，`range=history/today/7/30` |
| `GET /api/config-usage` | D1 或 AE | `ADMIN_TOKEN` | 配置使用，`range=history/today/7/30` |
| `GET /api/model-usage` | D1 或 AE | `ADMIN_TOKEN` | 模型使用，支持 `provider/endpointHost/model` 筛选 |
| `GET /api/agent-runtime` | D1 或 AE | `ADMIN_TOKEN` | Agent 总体、运行时、模型维度的成功率、失败率、重试率和重试后成功率，`range=history/today/7/30` |
| `GET/DELETE /api/agent-errors` | D1 + R2 | `ADMIN_TOKEN` | 分页读取异常元数据，或单条/批量删除日志 |
| `GET/POST /api/agent-errors/config` | D1 | `ADMIN_TOKEN` | 管理接收开关和精确版本号列表，查看 2 GiB 容量使用情况 |
| `GET /api/agent-errors/download` | D1 + R2 | `ADMIN_TOKEN` | 下载单份 `.json.gz` 完整诊断包 |
| `GET /api/latest` | AE | `ADMIN_TOKEN` | 最近事件，支持 `event` 筛选 |
| `GET /api/retention` | D1 | `ADMIN_TOKEN` | 留存概览，读取 Cron 生成的最新 30 天快照 |
| `GET /api/github-repo-stats` | GitHub + KV | `ADMIN_TOKEN` | GitHub stats |
| `GET /notice` | KV | 无 | 客户端公告 |
| `GET /model-info` | KV | 无 | 按 `modelName` 返回最终生效的思考强度、最大 context/output 和缓存时间，人工覆盖优先 |
| `GET/POST/DELETE /api/notice` | KV | `ADMIN_TOKEN` | 公告后台管理 |
| `GET/POST /api/model-info-cache` | KV + models.dev | `ADMIN_TOKEN` | 分页查看模型详细索引或手动同步，GET 支持 `q/scope/page/pageSize` |
| `POST/DELETE /api/model-info-cache/override` | KV | `ADMIN_TOKEN` | 保存单条模型人工覆盖，或按 `modelName` 恢复自动同步值 |
| `POST /license/activate` | KV + Worker Secret | 无 | 客户端免费授权签发，返回带签名 license |
| `GET/POST /api/license-config` | KV | `ADMIN_TOKEN` | 授权配置后台管理 |
| `GET /resources` | `RESOURCE_DB` + AE | 无 | 客户端资源列表，点击量为 D1 累计 + AE 今天 |
| `GET/POST/DELETE /api/resources` | `RESOURCE_DB` + R2 + AE | `ADMIN_TOKEN` | 资源管理 |
| `GET /plugins` | `RESOURCE_DB` + R2 | 无 | 插件市场列表，当前版作为升级目标，同时返回保留的上一版信息和地址 |
| `POST /plugins/download` | `RESOURCE_DB` | 无 | 累计插件成功下载次数 |
| `GET/POST/DELETE /api/plugins` | `RESOURCE_DB` + R2 | `ADMIN_TOKEN` | 插件管理；新增、更新和删除会同步维护 R2 安装包 |
| `POST /api/plugins/sync` | GitHub + `RESOURCE_DB` + R2 | `ADMIN_TOKEN` | 从 GitHub 正式 Release 同步全部插件，并清理 R2 历史版本和孤立对象 |

旧 `/api/summary` 已删除。

除 `/ip-blocks` 和 `/api/*` 管理接口外，Worker 会在路由处理前检查请求的 `CF-Connecting-IP`。命中封禁列表的公开读取或上传请求直接返回空 `204`，不会读取请求正文，也不会写入 AE、D1 或 R2；KV 读取异常时保持公开服务可用。客户端在正常启动后异步调用 `/ip-blocks`，只有返回成功、出口 IP 明确且与列表精确匹配时才结束进程，网络或响应异常不影响正常启动，开发调试模式执行相同检查。

## 统计口径

| 模块 | 口径 |
| --- | --- |
| 历史 | 读 D1，忽略 AE |
| 今天/7天/30天 | 读 AE，忽略 D1 |
| 活跃客户端 | 任意允许事件去重 `client_id` |
| 总客户端数 | D1 `stats_totals.total_clients` |
| 今日/7日新增 | D1 `stats_clients.first_seen_date` |
| 实时客户端入库 | `/track` 只对当前业务日期或前 1 天创建的客户端尝试实时插入并增加总客户端数；授权字段会按客户端授权快照覆盖既有 `stats_clients`；D1 写入失败不影响 `/track` 返回成功；老客户端活跃由 Cron 批量更新 |
| 最后访问 IP | Worker 优先记录 `CF-Connecting-IP`；如果它是 Pseudo IPv4 的 `240.0.0.0/4` 伪地址，则改用 `CF-Connecting-IPv6`；完全忽略 `CF-Pseudo-IPv4`。AE 写入 `blob13`，D1 `stats_clients.last_access_ip` 由新客户端实时入库和每日 Cron 更新 |
| 每日统计 | 今天读 AE，前 9 天读 D1 |
| 最近事件 | 只读 AE，不入 D1 |
| 留存 | Cron 写入 `stats_client_activity` 和固定 30 天 `stats_retention`，页面只读 D1 最新快照，忽略当天数据 |
| 资源点击量 | `RESOURCE_DB.resources.click_count` 保存历史累计，页面查询时加上 AE 今天点击量 |
| 版本客户端数 | D1 历史来自 `stats_clients.last_active_version` 当前分组重算；今天/7天/30天来自 AE 去重客户端数 |
| 模型 Total Tokens | `ai_request` 的 `double4` 按 `_sample_interval` 聚合，历史写入 `stats_models.total_tokens` |
| 概览 AI 指标 | 北京时间 02:30 模型汇总完成后，从 D1 `stats_models` 覆盖刷新 `stats_totals.total_text_tokens` 和 `stats_totals.total_generated_images`；生成图片数沿用生图模型请求次数口径 |
| Agent 执行统计 | 新版 `agent_runtime` 使用 `blob9` v4 复合值聚合运行时、最终状态、Pi 原生模型重试次数、文本模型服务商、endpoint host 和模型名；v3 历史结果修复次数保留在独立列，不与模型重试混算；历史读 D1，今天/7天/30天读 AE |
| 配置使用 | 新版 `config_usage` 使用 `config_key/config_value` 键值对上报；D1 历史保留，AE 旧格式不再兼容 |
| 授权状态 | 客户端上报 `license_status/license_plan/license_expires_at/source_trusted/untrusted_reason`；AE 写入 `blob14-blob18`，D1 `stats_clients` 保存最新状态 |

## 事件类型

| event | 用途 |
| --- | --- |
| `app_open` | 打开次数、留存 |
| `page_view` | 页面访问 |
| `config_usage` | 配置使用 |
| `ai_request` | 模型使用、AI 请求、Token |
| `resource_click` | 资源点击 |
| `agent_runtime` | Agent 执行成功率、失败率、重试率和重试后成功率 |

`config_usage` 使用 `config_key/config_value` 键值对上报，每个配置项一条事件。Worker 从 Cloudflare 真实客户端 IP 请求头读取公网 IP 并写入 `blob13`，客户端不自报 IP；`CF-Pseudo-IPv4` 不参与统计。授权状态写入 `blob14-blob18`，只包含状态、授权类型、有效期日期和可信来源标记，不上传设备原始指纹。`ai_request` 只采集请求类型、服务商、endpoint host、模型名和 token 用量，不采集 API Key、Prompt、响应内容或错误详情。`agent_runtime` 额外接收运行时注册表 ID 和 `agent_runtime_model_retry_count`，新版统计编码到 `blob9=v4|<runtime>|<success|failed>|m<model-retry-count>|<provider>|<host>|<model>`；旧版 v3 的 `r<0-3>` 继续表示结果修复次数并独立汇总，不采集 API Key、任务内容、错误详情、Prompt、输出或本地路径。

`GET /api/agent-runtime` 的 `agentRuntime` 保留总体计数，`retryRate/retrySuccessRate` 按 v4 模型口径任务计算；`runtimes[]` 和 `models[]` 同时返回 `modelRunCount`、模型重试统计及独立的历史结果修复统计。

插件仍以 GitHub 最新正式 Release 为发布上游。Worker 同步时先在 D1 登记发布对象，再把 ZIP 写入 `plugins/.staging/` 临时对象并校验，然后发布到 `openbidkit` R2 的 `plugins/<插件ID>/<插件ID>-v<版本>.zip`；正式对象确认完整后才更新市场下载地址。同版本重复同步会直接复用完整的已发布对象，不覆盖线上包。新版本切换成功后，数据库记录当前版和上一版，R2 每个插件只保留这两个正式版本；全量同步结束会再次清理更早版本、已删除插件和遗留临时对象。插件发布、删除和全局清理通过 D1 租约锁跨 Worker 串行执行，清理前还会逐个检查 30 分钟有效的发布标记，避免删除并发发布中的临时键或正式键。客户端只接收 `https://openbidkit-oss.agnet.top` 下载地址，市场升级目标始终是最新版，上一版仅用于保障在途下载。

首次部署该分发逻辑后，需要在 Dashboard 的“插件管理”中执行一次“同步全部插件”，把现有 GitHub 下载地址迁移为 R2 地址；迁移完成前，公共插件接口不会向客户端下发尚未镜像的插件。

Agent 异常日志与 `agent_runtime` 埋点完全分离。接收默认关闭；开启后仍必须配置至少一个精确版本号，空列表表示不接收。Worker 在读取正文前检查开关、版本和剩余容量；日志压缩后总占用上限为 2 GiB，达到上限直接丢弃。正文只保存到 `AGENT_ERROR_BUCKET`，D1 只保存元数据和容量计数；日志到期、单条删除或批量删除都会释放容量。上传必须携带 Worker 已签发、来源可信且未过期的 license。

## 首次部署

### 1. Cloudflare 凭据

自动创建 KV/D1/R2 需要在 Cloudflare Workers Build 的构建环境变量中配置：

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 具备 Workers KV、D1、R2 和 Worker 部署权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |

这两个变量不是 GitHub Secrets，也不是 Worker 运行时 Secret；本地手动执行 setup 时，才需要在本机终端临时设置它们。

Worker 运行时还需要在 Cloudflare 后台配置 Secret：

| Secret | 说明 |
| --- | --- |
| `ACCOUNT_ID` | Cloudflare Account ID |
| `ADMIN_TOKEN` | Dashboard 管理 Token |
| `ANALYTICS_API_TOKEN` | Analytics Engine SQL Read Token |
| `OPENBIDKIT_PET_READ_TOKEN` | 插件同步专用 GitHub Fine-grained Token，仅授予 `openbidkit-pet` 仓库 `Contents: Read-only` 权限 |
| `OPENBIDKIT_YIBIAO_METADATA_READ_TOKEN` | 可选，仓库统计专用 GitHub Fine-grained Token，仅选择 `OpenBidKit_Yibiao` 仓库并保留自动授予的 `Metadata: Read-only` 权限 |
| `LICENSE_PRIVATE_KEY_JWK` | ECDSA P-256 私钥 JWK，用于签发客户端 license |
| `LICENSE_KEY_ID` | 可选，授权签名 key id，默认 `official-build-key-2026-01` |

不要在 `wrangler.jsonc` 增加 `secrets.required`。

授权密钥使用 ECDSA P-256 JWK。可在本地用 Node 生成一次密钥对，把私钥 JSON 配置到 GitHub Actions Secret `YIBIAO_LICENSE_PRIVATE_KEY_JWK` 和 Worker Secret `LICENSE_PRIVATE_KEY_JWK`：

```powershell
node -e "const { webcrypto } = require('node:crypto'); (async () => { const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']); console.log(JSON.stringify(await webcrypto.subtle.exportKey('jwk', key.privateKey))); })();"
```

公钥由客户端发布脚本从私钥 JWK 自动导出并打入安装包，不需要作为 Secret 保存。

### 2. 创建或复用存储

正常部署不需要本地手动执行 setup。Cloudflare Workers Build 执行 `npm run deploy` 时，会由 `deploy-if-changed.mjs` 自动运行：

```powershell
npm run setup:notice-kv
npm run setup:resources
npm run setup:agent-errors
npm run setup:analytics-storage
```

本地手动执行仅用于调试，必须先在本机设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。

`setup:analytics-storage` 会：

| 动作 | 说明 |
| --- | --- |
| D1 | 创建或复用 `openbidkit-analytics`，binding 为 `ANALYTICS_DB` |
| R2 | 复用 `openbidkit` 的 `RESOURCE_BUCKET` 保存资源图片、插件当前版与上一版安装包；创建或复用 `openbidkit-agent-errors`，binding 为 `AGENT_ERROR_BUCKET`，配置 7 天删除生命周期 |
| Cron | 生产账户使用 Workers Paid Plan；确认北京时间 01:00 到 03:00 的 5 个统计 Cron，以及北京时间 04:00 的独立模型信息同步 Cron |
| Migration | 通过 Wrangler D1 migrations 执行 `analytics-migrations/*.sql` 并记录已应用版本；Agent 运行时迁移会重建 `stats_agent_runtime` 联合主键并将既有汇总归为 `opencode`；同时自动补齐 `stats_clients` 授权字段、`stats_versions.client_count`、`stats_models.total_tokens` 和概览 AI 指标字段 |

如果刚删除过 `openbidkit-analytics`，脚本会重新创建并更新 `wrangler.jsonc` 的 `database_id`。

模型信息同步使用独立 Cron `0 20 * * *`（北京时间每天 04:00），从 `models.dev/api.json` 提取按模型 ID 聚合的精简索引。思考强度取同名模型明确档位的交集，`context` 和 `output` 分别取同名记录最大值；同步失败不会覆盖最后一次成功索引。Dashboard 的“模型信息缓存”页面支持查看详细索引、手动同步和人工修改。人工修改按完整模型记录独立保存在 KV 中，公共查询优先使用人工值，定时或手动同步不会覆盖；点击“恢复默认”后立即删除人工覆盖并重新使用最近一次自动同步值。

### 3. 部署 Worker

API Worker 配置：

| 项目 | 值 |
| --- | --- |
| Worker 名称 | `agnet-analytics-api` |
| Root directory | `analytics/worker` |
| Build command | `npm install` |
| Deploy command | `npm run deploy` |

Dashboard Worker 配置：

| 项目 | 值 |
| --- | --- |
| Worker 名称 | `agnet-analytics-dashboard` |
| Root directory | `analytics/dashboard` |
| Build command | `npm install` |
| Deploy command | `npm run deploy` |

## 验证

健康检查：

```powershell
Invoke-RestMethod -Uri "https://analytics.agnet.top/health"
```

上报测试：

```powershell
Invoke-RestMethod `
  -Uri "https://analytics.agnet.top/track" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"projectName":"yibiao-client","event":"app_open","version":"0.1.0","platform":"win32","arch":"x64","client_id":"test-client","client_created_at":"2026-06-13"}'
```

如果要验证 `/track` 实时写入 D1 客户端表，`client_created_at` 需要使用当前业务日期或前 1 天日期；否则只写 AE，客户端会由后续 Cron 汇总补入 D1。

查询概览：

```powershell
Invoke-RestMethod `
  -Uri "https://analytics.agnet.top/api/overview?projectName=yibiao-client" `
  -Method Get `
  -Headers @{ Authorization = "Bearer <ADMIN_TOKEN>" }
```

## 历史回填

新版历史回填脚本会按 Cron 同一套逻辑，把 Analytics Engine 中 `yibiao-client` 在脚本执行当天北京时间之前的所有历史日期汇总到 D1 `stats_*` 表；回填会补齐留存所需的 30 天 `app_open` 活动窗口并生成 `stats_retention` 快照；资源点击量会按历史总量写入 `openbidkit-resources.resources.click_count`，不会按天重复累加。

本地执行前，在 `analytics/scripts/.env` 中配置：

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` 或 `ACCOUNT_ID` | Cloudflare Account ID |
| `CLOUDFLARE_API_TOKEN` | 具备 D1 Query 权限的 Cloudflare API Token |
| `ANALYTICS_API_TOKEN` | Analytics Engine SQL Read Token |
| `ANALYTICS_DB_ID` | 可选；不填则按 D1 名称 `openbidkit-analytics` 自动查找 |
| `RESOURCE_DB_ID` | 可选；不填则按 D1 名称 `openbidkit-resources` 自动查找，用于回填资源累计点击量 |

执行回填：

```powershell
cd analytics\worker
npm run backfill:analytics-stats
```

只补指定日期时使用 `BACKFILL_DATE` 环境变量：

```powershell
cd analytics\worker
$env:BACKFILL_DATE="2026-06-17"
npm run backfill:analytics-stats
Remove-Item Env:\BACKFILL_DATE
```

如果只需要补齐新增的 `stats_versions.client_count` 和 `stats_models.total_tokens` 两个字段，执行：

```powershell
cd analytics\worker
npm run backfill:analytics-stat-fields
```

只根据 D1 已有模型历史统计回填概览 Token 消耗量和生成图片数时，执行独立脚本：

```powershell
cd analytics\worker
npm run backfill:overview-ai-totals
```

注意事项：

| 项 | 说明 |
| --- | --- |
| 项目 | 固定回填 `yibiao-client` |
| 日期 | 默认自动发现 AE 中北京时间今天之前的所有有数据日期；设置 `BACKFILL_DATE=YYYY-MM-DD` 时只处理指定日期 |
| 今天 | 脚本不回填今天，今天/7天/30天仍直接读 AE |
| 留存 | 回填会先补齐回填窗口前 30 天到最后回填日的 `stats_client_activity`，再生成对应 `stats_retention` 快照 |
| 重复保护 | `stats_rollup_runs.status = success` 的日期会跳过 |
| 异常状态 | 已存在 `running/failed` 且没有 `stats_daily` 时会清理状态并重试；如果已有 `stats_daily` 会停止，避免重复累加污染 D1 |
| 临时错误 | AE/D1 对 `429/500/502/503/504` 会自动重试，并打印 HTTP 状态、返回内容和 SQL 片段 |
| 参数 | 脚本不接受命令行参数；指定单日使用环境变量 `BACKFILL_DATE` |
| 补字段脚本 | 只补 `stats_versions.client_count` 和 `stats_models.total_tokens`，不回填资源点击量，不重跑每日统计 |

## 排查

| 问题 | 处理 |
| --- | --- |
| `unauthorized` | 检查 Dashboard 输入的 `ADMIN_TOKEN` |
| `ANALYTICS_DB is not configured` | 确认 Cloudflare Workers Build 已配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，重新触发 API Worker 部署；本地调试时才手动运行 setup |
| 查询为空 | 先确认 `/track` 成功，再等待 AE 写入或第二天 Cron 汇总 |
| 历史总数为空 | 新版 D1 刚重建时没有历史数据，需等待 Cron 或后续回填 |
| 今日/7天/30天为空 | 检查 `ACCOUNT_ID` 和 `ANALYTICS_API_TOKEN` |
| 资源数据异常 | 不要删除 `openbidkit-resources`、`RESOURCE_DB`、`RESOURCE_BUCKET` |

查看 Worker 日志：

```powershell
cd analytics\worker
npx wrangler tail agnet-analytics-api --format pretty
```

## 自动部署触发规则

Cloudflare Workers Builds 会在生产分支推送时触发构建。部署脚本按目录判断是否需要部署：

| Worker | 监听目录 |
| --- | --- |
| `agnet-analytics-api` | `analytics/worker` |
| `agnet-analytics-dashboard` | `analytics/dashboard` |

强制部署可临时设置：

```text
FORCE_DEPLOY=1 npm run deploy
```
