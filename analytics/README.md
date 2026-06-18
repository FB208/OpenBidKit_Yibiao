# 埋点统计部署手册

本目录维护 `Cloudflare Workers + Analytics Engine + D1 + Cron Triggers + Workers Static Assets` 埋点统计服务。公开仓库不保存 `ACCOUNT_ID`、`ADMIN_TOKEN`、`ANALYTICS_API_TOKEN` 等密钥。

## 地址

| 项目 | 地址 |
| --- | --- |
| API | `https://analytics.agnet.top` |
| Dashboard | `https://static.analytics.agnet.top` |

## 数据源

| 数据源 | Binding | 用途 |
| --- | --- | --- |
| Analytics Engine `agnet_analytics` | `ANALYTICS` | 详细事件、今天/7天/30天查询、最近事件、Cron 汇总来源 |
| D1 `openbidkit-analytics` | `ANALYTICS_DB` | 新版 `stats_*` 长期统计表 |
| D1 `openbidkit-resources` | `RESOURCE_DB` | 资源管理元数据 |
| R2 `openbidkit` | `RESOURCE_BUCKET` | 资源图片 |
| KV | `NOTICE_STORE` | 公告和 GitHub stats 缓存 |

`openbidkit-analytics` 可以在改版时直接删除并由 `setup:analytics-storage` 重建；不要删除 `openbidkit-resources`。

## 接口

| 接口 | 数据源 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `GET /health` | Worker | 无 | 健康检查 |
| `POST /track` | AE + D1 | 无 | 写 AE；从 Cloudflare 真实客户端 IP 请求头记录客户端 IP；仅对 `client_created_at` 距当前业务日期不超过 1 天的新客户端尝试实时写 `stats_clients` |
| `GET /api/projects` | D1 优先，AE 兜底 | `ADMIN_TOKEN` | 项目列表 |
| `GET /api/overview` | D1 + AE + KV | `ADMIN_TOKEN` | 概览总数、新增、今日活跃、每日统计 |
| `GET /api/clients` | D1 | `ADMIN_TOKEN` | 客户端统计列表 |
| `GET /api/client-detail` | AE | `ADMIN_TOKEN` | 单客户端 7天/30天/全部事件明细 |
| `GET /api/ip-stats` | D1 | `ADMIN_TOKEN` | 按最后访问 IP 汇总客户端数，分页返回 |
| `GET /api/traffic` | D1 或 AE | `ADMIN_TOKEN` | 访问分析，`range=history/today/7/30` |
| `GET /api/config-usage` | D1 或 AE | `ADMIN_TOKEN` | 配置使用，`range=history/today/7/30` |
| `GET /api/model-usage` | D1 或 AE | `ADMIN_TOKEN` | 模型使用，支持 `provider/endpointHost/model` 筛选 |
| `GET /api/latest` | AE | `ADMIN_TOKEN` | 最近事件，支持 `event` 筛选 |
| `GET /api/retention` | D1 | `ADMIN_TOKEN` | 留存概览，读取 Cron 生成的最新 30 天快照 |
| `GET /api/github-repo-stats` | GitHub + KV | `ADMIN_TOKEN` | GitHub stats |
| `GET /notice` | KV | 无 | 客户端公告 |
| `GET/POST/DELETE /api/notice` | KV | `ADMIN_TOKEN` | 公告后台管理 |
| `GET /resources` | `RESOURCE_DB` + AE | 无 | 客户端资源列表，点击量为 D1 累计 + AE 今天 |
| `GET/POST/DELETE /api/resources` | `RESOURCE_DB` + R2 + AE | `ADMIN_TOKEN` | 资源管理 |

旧 `/api/summary` 已删除。

## 统计口径

| 模块 | 口径 |
| --- | --- |
| 历史 | 读 D1，忽略 AE |
| 今天/7天/30天 | 读 AE，忽略 D1 |
| 活跃客户端 | 任意允许事件去重 `client_id` |
| 总客户端数 | D1 `stats_totals.total_clients` |
| 今日/7日新增 | D1 `stats_clients.first_seen_date` |
| 实时客户端入库 | `/track` 只尝试写当前业务日期或前 1 天创建的客户端，同一 Worker 实例内同一客户端只尝试一次；D1 写入失败不影响 `/track` 返回成功；老客户端活跃由 Cron 批量更新 |
| 最后访问 IP | Worker 优先记录 `CF-Connecting-IP`；如果它是 Pseudo IPv4 的 `240.0.0.0/4` 伪地址，则改用 `CF-Connecting-IPv6`；完全忽略 `CF-Pseudo-IPv4`。AE 写入 `blob13`，D1 `stats_clients.last_access_ip` 由新客户端实时入库和每日 Cron 更新 |
| 每日统计 | 今天读 AE，前 9 天读 D1 |
| 最近事件 | 只读 AE，不入 D1 |
| 留存 | Cron 写入 `stats_client_activity` 和固定 30 天 `stats_retention`，页面只读 D1 最新快照，忽略当天数据 |
| 资源点击量 | `RESOURCE_DB.resources.click_count` 保存历史累计，页面查询时加上 AE 今天点击量 |
| 版本客户端数 | D1 历史来自 `stats_clients.last_active_version` 当前分组重算；今天/7天/30天来自 AE 去重客户端数 |
| 模型 Total Tokens | `ai_request` 的 `double4` 按 `_sample_interval` 聚合，历史写入 `stats_models.total_tokens` |
| 配置使用 | 新版 `config_usage` 使用 `config_key/config_value` 键值对上报；D1 历史保留，AE 旧格式不再兼容 |

## 事件类型

| event | 用途 |
| --- | --- |
| `app_open` | 打开次数、留存 |
| `page_view` | 页面访问 |
| `config_usage` | 配置使用 |
| `ai_request` | 模型使用、AI 请求、Token |
| `resource_click` | 资源点击 |

`config_usage` 使用 `config_key/config_value` 键值对上报，每个配置项一条事件。Worker 从 Cloudflare 真实客户端 IP 请求头读取公网 IP 并写入 `blob13`，客户端不自报 IP；`CF-Pseudo-IPv4` 不参与统计。`ai_request` 只采集请求类型、服务商、endpoint host、模型名和 token 用量，不采集 API Key、Prompt、响应内容或错误详情。

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
| `GITHUB_API_TOKEN` | 可选，降低 GitHub API 限流概率 |

不要在 `wrangler.jsonc` 增加 `secrets.required`。

### 2. 创建或复用存储

正常部署不需要本地手动执行 setup。Cloudflare Workers Build 执行 `npm run deploy` 时，会由 `deploy-if-changed.mjs` 自动运行：

```powershell
npm run setup:notice-kv
npm run setup:resources
npm run setup:analytics-storage
```

本地手动执行仅用于调试，必须先在本机设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。

`setup:analytics-storage` 会：

| 动作 | 说明 |
| --- | --- |
| D1 | 创建或复用 `openbidkit-analytics`，binding 为 `ANALYTICS_DB` |
| Cron | 确认北京时间 01:00 到 03:00 每 30 分钟一个触发点的 5 个 Cron |
| Migration | 执行 `analytics-migrations/*.sql`，并自动补齐 `stats_versions.client_count`、`stats_models.total_tokens` |

如果刚删除过 `openbidkit-analytics`，脚本会重新创建并更新 `wrangler.jsonc` 的 `database_id`。

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
