# 埋点统计部署手册

本目录维护通用匿名埋点统计服务，采用 `Cloudflare Workers + Analytics Engine + D1 + Cron Triggers + Workers Static Assets`。

公开仓库只保存源码，不保存 `ACCOUNT_ID`、`ADMIN_TOKEN`、`ANALYTICS_API_TOKEN` 等密钥。

## 一、使用说明

服务地址：

| 项目 | 地址 |
| --- | --- |
| API 地址 | `https://analytics.agnet.top` |
| 统计页面地址 | `https://static.analytics.agnet.top` |

目录结构：

```text
analytics/
  worker/      # 上报与查询 API Worker
  dashboard/   # 统计看板 Worker Static Assets
```

`worker/src/` 采用模块化结构：`index.js` 只负责路由分发，`routes/` 放接口处理，`services/` 放 Analytics Engine 与 KV 访问，`http.js`、`utils.js`、`constants.js` 放公共能力。

`dashboard/public/` 是无需构建的静态看板：`index.html` 负责页面骨架，`styles.css` 负责样式，`src/` 下使用原生 ES Module 拆分 API、渲染、标签页和各标签页逻辑。

核心接口：

| 接口 | 用途 | 鉴权 |
| --- | --- | --- |
| `GET /health` | 检查 API Worker | 无 |
| `POST /track` | 上报埋点 | 无 |
| `GET /notice` | 客户端读取最新公告 | 无 |
| `GET /resources` | 客户端读取全局资源列表，支持 `q` 搜索和 `days` 点击统计窗口 | 无 |
| `GET /resource-image` | 通过 Worker 代理读取 R2 资源图片 | 无 |
| `GET /api/projects` | 查询项目名，优先读取 D1 长期统计，必要时回退 Analytics Engine | `ADMIN_TOKEN` |
| `GET /api/overview` | 查询 D1 长期累计、固定窗口和范围分析概览 | `ADMIN_TOKEN` |
| `GET /api/summary` | 查询每日统计、页面排行、版本分布；`range=history` 时读取 D1 | `ADMIN_TOKEN` |
| `GET /api/traffic` | 查询访问分析；支持 `days=7/30/90` 或 `range=history` | `ADMIN_TOKEN` |
| `GET /api/config-usage` | 查询配置使用；支持 `days=7/30/90` 或 `range=history` | `ADMIN_TOKEN` |
| `GET /api/model-usage` | 查询模型使用，返回结构同 `/api/config-usage` | `ADMIN_TOKEN` |
| `GET /api/latest` | 查询最近事件 | `ADMIN_TOKEN` |
| `GET /api/github-repo-stats` | 查询 GitHub 仓库 stars、forks、open issues | `ADMIN_TOKEN` |
| `GET /api/notice` | 读取当前项目公告 | `ADMIN_TOKEN` |
| `POST /api/notice` | 发布或更新当前项目公告 | `ADMIN_TOKEN` |
| `DELETE /api/notice` | 停用当前项目公告 | `ADMIN_TOKEN` |
| `GET /api/resources` | 读取资源管理列表 | `ADMIN_TOKEN` |
| `POST /api/resources` | 新增或更新资源，支持图片上传 | `ADMIN_TOKEN` |
| `DELETE /api/resources` | 删除资源并清理关联 R2 图片 | `ADMIN_TOKEN` |

事件类型：

| event | 说明 | page 是否必填 |
| --- | --- | --- |
| `app_open` | 应用打开 | 否 |
| `page_view` | 页面访问 | 是 |
| `config_usage` | 配置使用快照 | 否 |
| `ai_request` | AI 接口请求 | 否 |
| `resource_click` | 客户端资源下载页点击资源 | 否 |

`ai_request` 统计请求类型、服务商、模型端点域名、模型名称和 token 用量（`prompt_tokens`、`completion_tokens`、`total_tokens`）。模型端点只上传 hostname，不携带协议、路径、端口、账号密码、查询参数或 hash；不采集 API Key、Prompt、响应内容或错误详情。

`resource_click` 只上传 Worker 生成的短资源统计 key，不上传资源标题、标签、介绍、弹窗内容或下载链接。客户端资源下载页默认展示近 30 天点击量；Dashboard “资源管理”会按当前项目名和点击统计范围查询点击量，选择“历史总数”时读取 D1 每日汇总；查询失败时点击量按 0 展示，不影响资源列表读取和编辑。

上报写入顺序：`POST /track` 只规范化、校验并写入 Analytics Engine，接口成功返回 `{ "code": 0 }`。D1 长期统计不在上报热路径写入，由 Worker Cron 每天按 `Asia/Shanghai` 业务日汇总昨日 Analytics Engine 聚合结果后写入 `ANALYTICS_DB`。Analytics Engine 仍用于最近事件和 90 天内灵活分析。

统计页面使用：

1. 打开 `https://static.analytics.agnet.top`。
2. 生产看板 API 地址固定为 `https://analytics.agnet.top`；本地开发看板可手动填写开发地址。
3. 输入 Worker Secret 中配置的 `ADMIN_TOKEN`。Token 默认只保存到当前会话 `sessionStorage`；勾选“记住 Token”后才写入 `localStorage`。
4. 输入项目名，例如 `yibiao-client`。
5. 点击“刷新”。
6. 如需发布客户端公告，在“公告管理”中填写标题和 Markdown 内容后点击“发布公告”。
7. 访问分析、配置使用、模型使用和资源管理各自选择最近 7/30/90 天或历史总数；历史总数来自 D1，最近范围来自 Analytics Engine，两者可能因写入延迟、回填范围和数据源不同存在轻微差异。

## 二、首次部署

### 1. 启用 Analytics Engine

1. 登录 Cloudflare Dashboard。
2. 进入 `存储和数据库 -> Analytics Engine`。
3. 点击 `Enable`。

Dataset 不需要手动创建，第一次写入后会自动创建 `agnet_analytics`。

### 1.1 创建公告 KV

客户端公告保存到 Cloudflare KV，绑定名固定为 `NOTICE_STORE`。

KV namespace 只需要创建一次。自动创建要求执行脚本的环境具备 Cloudflare 凭据：

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 需要具备 Workers KV namespace、D1、R2 读写和 Worker 部署权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID，避免 Wrangler 在非交互环境选择账号 |

`analytics/worker` 部署前会检查 `wrangler.jsonc` 是否已经配置 `NOTICE_STORE`。已配置时直接部署；未配置时才运行 `setup:notice-kv`，创建或复用已有 KV namespace，并把 id 写入本次部署使用的 `wrangler.jsonc`。

本地首次启用时，也可以在登录 Wrangler 后手动运行：

```powershell
cd analytics\worker
npm run setup:notice-kv
```

脚本会优先查询并复用现有 namespace；不存在时才执行 `wrangler kv namespace create NOTICE_STORE`，并把 namespace id 写入 `analytics/worker/wrangler.jsonc` 的 `kv_namespaces`。

### 1.2 创建资源 D1 和 R2

资源下载页的数据保存到 Cloudflare D1，图片保存到 R2。绑定名固定为：

| 资源 | 名称 | Binding |
| --- | --- | --- |
| D1 数据库 | `openbidkit-resources` | `RESOURCE_DB` |
| R2 bucket | `openbidkit`（页面展示为 OpenBidKit） | `RESOURCE_BUCKET` |

`analytics/worker` 部署前会自动运行 `setup:resources`：创建或复用 D1/R2，写入 `wrangler.jsonc`，并执行 D1 migration。自动创建要求执行脚本的环境具备 D1、R2 和 Worker 部署权限。

本地首次启用时，也可以在登录 Wrangler 后手动运行：

```powershell
cd analytics\worker
npm run setup:resources
```

如果要通过环境变量直接指定已有 D1，可以设置 `RESOURCE_DB_ID`。R2 bucket 只按名称 `openbidkit` 复用或创建。

如果需要手动配置，也可以运行：

```powershell
cd analytics\worker
npx wrangler kv namespace create NOTICE_STORE
```

然后在 `analytics/worker/wrangler.jsonc` 中加入：

```jsonc
"kv_namespaces": [
  {
    "binding": "NOTICE_STORE",
    "id": "<上一步输出的 namespace id>"
  }
]
```

### 1.3 创建长期统计 D1 和 Cron

长期累计统计保存到独立 D1，Worker Cron 每天汇总前一日 Analytics Engine 聚合结果。绑定名固定为：

| 资源 | 名称 | Binding |
| --- | --- | --- |
| D1 数据库 | `openbidkit-analytics` | `ANALYTICS_DB` |
| Cron Trigger | 每天 UTC `18:15`，北京时间 `02:15` | `15 18 * * *` |

`analytics/worker` 部署前会自动运行 `setup:analytics-storage`：创建或复用 D1，写入 `wrangler.jsonc`，确认 Cron Trigger，并执行 `analytics-migrations/` 下的 D1 migration。自动创建要求执行脚本的环境具备 D1 和 Worker 部署权限。

本地首次启用时，也可以在登录 Wrangler 后手动运行：

```powershell
cd analytics\worker
npm run setup:analytics-storage
```

如果要通过环境变量直接指定已有 D1，可以设置 `ANALYTICS_DB_ID`。脚本不会创建或配置 Cloudflare Queue。

配置位置：

| Binding | 含义 | 写入位置 | 生效位置 |
| --- | --- | --- | --- |
| `ANALYTICS_DB` | 长期统计 D1 数据库绑定，Worker 通过 `env.ANALYTICS_DB` 读写 D1 | `analytics/worker/wrangler.jsonc` 的 `d1_databases` | Cloudflare Worker `Settings -> Bindings` |
| Cron Trigger | 每天北京时间凌晨汇总昨日统计 | `analytics/worker/wrangler.jsonc` 的 `triggers.crons` | Cloudflare Worker `Settings -> Triggers` |

`setup:analytics-storage` 会自动创建或复用 D1，并把类似下面的配置写入 `analytics/worker/wrangler.jsonc`：

```jsonc
"d1_databases": [
  {
    "binding": "ANALYTICS_DB",
    "database_name": "openbidkit-analytics",
    "database_id": "<D1 database id>"
  }
],
"triggers": {
  "crons": [
    "15 18 * * *"
  ]
}
```

### 2. 创建 Analytics API Token

1. 进入 Cloudflare `My Profile -> API Tokens`。
2. 点击 `Create Token`。
3. 选择 `Create Custom Token`。
4. 权限选择 `Account -> Account Analytics -> Read`。
5. Account Resources 选择当前账号。
6. 创建后复制 Token，后续配置为 Worker Secret `ANALYTICS_API_TOKEN`。

### 3. 部署 API Worker

在 Cloudflare 创建 Worker，并连接当前 GitHub 仓库。

配置：

| 项目 | 值 |
| --- | --- |
| Worker 名称 | `agnet-analytics-api` |
| Root directory | `analytics/worker` |
| Build command | `npm install` |
| Deploy command | `npm run deploy` |

`analytics/worker/wrangler.jsonc` 已包含：

| 配置 | 值 |
| --- | --- |
| 自定义域名 | `analytics.agnet.top` |
| Analytics Engine binding | `ANALYTICS` |
| Analytics Engine dataset | `agnet_analytics` |
| 公告 KV binding | `NOTICE_STORE`（首次部署时创建或复用） |
| 资源 D1 binding | `RESOURCE_DB`（首次部署时创建或复用，并自动执行 migration） |
| 资源 R2 binding | `RESOURCE_BUCKET`（bucket 名为 `openbidkit`） |
| 长期统计 D1 binding | `ANALYTICS_DB`（首次部署时创建或复用，并自动执行 migration） |
| 长期统计 Cron Trigger | `15 18 * * *`，北京时间每天 02:15 汇总昨日 |
| 变量保留 | `keep_vars: true`，避免部署覆盖后台配置 |

部署后在 Worker 的 `Settings -> Variables and Secrets` 配置 Secret：

| Secret | 说明 |
| --- | --- |
| `ACCOUNT_ID` | Cloudflare Account ID |
| `ADMIN_TOKEN` | 统计看板查询密码 |
| `ANALYTICS_API_TOKEN` | 上一步创建的 API Token |

可选 Secret：

| Secret | 说明 |
| --- | --- |
| `GITHUB_API_TOKEN` | GitHub 仓库统计接口使用；不配置时使用公开 API + HTML 兜底，配置后可降低 GitHub API 限流概率 |

注意：不要在 `wrangler.jsonc` 里声明 `secrets.required`。首次 GitHub 部署时 Secret 还没配置，Wrangler 会在部署前校验并失败。正确流程是先部署 Worker，再到 Cloudflare 后台配置这些 Secret，然后重新部署或直接访问验证。

确认绑定：

1. 进入 Worker `agnet-analytics-api`。
2. 打开 `Settings -> Bindings`。
3. 确认存在 `ANALYTICS -> Analytics Engine -> agnet_analytics`。
4. 如不存在，手动添加同名绑定。

验证：

```powershell
Invoke-RestMethod -Uri "https://analytics.agnet.top/health"
```

### 4. 部署统计看板 Worker

统计看板使用 Workers Static Assets，同样创建 Worker 并连接当前 GitHub 仓库。

配置：

| 项目 | 值 |
| --- | --- |
| Worker 名称 | `agnet-analytics-dashboard` |
| Root directory | `analytics/dashboard` |
| Build command | `npm install` |
| Deploy command | `npm run deploy` |

`analytics/dashboard/wrangler.jsonc` 已包含：

| 配置 | 值 |
| --- | --- |
| 自定义域名 | `static.analytics.agnet.top` |
| 静态资源目录 | `./public` |

部署后访问：

```text
https://static.analytics.agnet.top
```

### 5. 测试上报和查询

上报应用打开：

```powershell
Invoke-RestMethod `
  -Uri "https://analytics.agnet.top/track" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"projectName":"yibiao-client","event":"app_open","version":"0.1.0","platform":"win32","arch":"x64","client_id":"test-client"}'
```

上报页面访问：

```powershell
Invoke-RestMethod `
  -Uri "https://analytics.agnet.top/track" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"projectName":"yibiao-client","event":"page_view","page":"knowledge-base","version":"0.1.0","platform":"win32","arch":"x64","client_id":"test-client"}'
```

查询统计：

```powershell
Invoke-RestMethod `
  -Uri "https://analytics.agnet.top/api/summary?projectName=yibiao-client&days=30" `
  -Method Get `
  -Headers @{ Authorization = "Bearer <ADMIN_TOKEN>" }
```

D1 长期统计由 Cron 每天汇总昨日数据，Analytics Engine 写入后也可能需要等待几十秒才能查到；历史总数和最近范围存在一天级汇总延迟属于预期。

### 5.1 回填 Analytics Engine 最近历史到 D1

长期统计 D1 上线前的历史数据不会自动出现，需要从 Analytics Engine 可查询窗口回填。回填最多覆盖 Analytics Engine 当前仍保留的数据，通常约最近 90 天；超过保留期的数据无法恢复。

回填脚本：`analytics/scripts/backfill-analytics-rollups.mjs`。脚本会按 `Asia/Shanghai` 业务日逐日查询 Analytics Engine 聚合结果，并写入 `ANALYTICS_DB` 的每日汇总表和匿名 hash 去重索引，写入口径统一使用 `source = 'rollup'`，与 Cron 汇总结果保持一致。重复执行同一天会先重建该日汇总表行；匿名客户端/维度索引是累计索引，不保存原始 `client_id`。

生产回填示例：

```powershell
cd analytics\worker
$env:ACCOUNT_ID = "<Cloudflare Account ID>"
$env:ANALYTICS_API_TOKEN = "<Analytics Engine Read Token>"
npm run backfill:analytics -- --project yibiao-client --start 2026-03-15 --end 2026-06-12 --remote
```

参数说明：

| 参数 | 说明 |
| --- | --- |
| `--project` | 回填的项目名，例如 `yibiao-client` |
| `--start` | 回填起始业务日期，`Asia/Shanghai`，格式 `YYYY-MM-DD` |
| `--end` | 回填结束业务日期，`Asia/Shanghai`，格式 `YYYY-MM-DD`。默认不要包含今天，避免当天 Analytics Engine 数据仍在变化 |
| `--remote` | 写入 Cloudflare 远程 D1，即生产 `ANALYTICS_DB` |
| `--local` | 写入本地 Wrangler D1，用于开发验证 |
| `--dry-run` | 只打印回填计划，不查询 Analytics Engine，不写 D1 |

推荐先执行 dry-run 确认范围：

```powershell
cd analytics\worker
npm run backfill:analytics -- --project yibiao-client --start 2026-03-15 --end 2026-06-12 --dry-run
```

不要默认回填今天。如果确实要回填当天，必须确认当天 Analytics Engine 数据已经稳定，并显式加 `--allow-current-day`。

概览指标口径：

| 指标 | 说明 |
| --- | --- |
| 总客户端数 | D1 中历史上报过任意事件的去重客户端数，不等于每日客户端数相加 |
| 累计打开量 / 累计页面访问量 / 累计 AI 请求 / 累计资源点击 | D1 每日汇总按 `source = 'rollup'` 汇总 |
| 今日打开客户端 | D1 中今天上报过 `app_open` 的去重客户端数；Cron 默认只汇总到昨日，未手动汇总今天时使用旧行兜底或为 0 |
| 近 7/30 天打开客户端 | D1 中最近 7/30 天上报过 `app_open` 的去重客户端数 |
| 新增客户端 | 所选时间范围内创建、并且期间有过任意事件上报的去重客户端数 |
| 老客户端活跃 | 所选时间范围内活跃客户端数减去新增客户端数 |
| 每日统计中的打开客户端数 | 当天有 `app_open` 上报的去重客户端数；未回填新表的旧行用 `min(active_clients, app_open_count)` 兜底 |
| 访问分析历史总数 | D1 每日页面/版本汇总 + 匿名维度客户端索引；最近 7/30/90 天仍从 Analytics Engine 查询 |
| 配置使用历史总数 | D1 每日配置汇总 + 匿名维度客户端索引；最近 7/30/90 天仍从 Analytics Engine 查询 |
| 模型使用历史总数 | D1 每日模型汇总 + 匿名维度客户端索引，包含 token 用量；最近 7/30/90 天仍从 Analytics Engine 查询 |
| 留存概览中的当日回访客户端 | 创建后 D1/D3/D7 当天再次打开 App 的客户端数 |

配置使用只采集模型服务商、模型端点域名、模型名称、token 用量、开关、数字和枚举类配置，不采集 `api_key`、完整 `base_url`、`mineru_token`、Prompt、响应内容、错误详情等敏感数据。

发布公告：

```powershell
Invoke-RestMethod `
  -Uri "https://analytics.agnet.top/api/notice" `
  -Method Post `
  -ContentType "application/json" `
  -Headers @{ Authorization = "Bearer <ADMIN_TOKEN>" } `
  -Body '{"projectName":"yibiao-client","title":"公告标题","content":"## Markdown 公告内容","enabled":true}'
```

客户端读取公告：

```powershell
Invoke-RestMethod -Uri "https://analytics.agnet.top/notice?projectName=yibiao-client"
```

### 6. 查看 Worker 错误日志

本地登录 Cloudflare 后，可实时查看 API Worker 日志：

```powershell
cd analytics\worker
npx wrangler tail agnet-analytics-api --format pretty
```

如果尚未登录，先执行：

```powershell
cd analytics\worker
npx wrangler login
```

查询接口失败时，Worker 会输出类似 `[analytics] summary query failed ...` 的错误日志。

## 三、接入新项目

不需要修改 Worker 配置。任意合法 `projectName` 都可以直接上报和查询。

项目名规则：

1. 只使用英文字母、数字、点、下划线、中划线。
2. 长度不超过 80。
3. 不要使用中文、空格、引号。

前端封装示例：

```ts
const ANALYTICS_ENDPOINT = 'https://analytics.agnet.top/track';
const PROJECT_NAME = 'my-other-app';

export async function track(event: 'app_open' | 'page_view', data: Record<string, string> = {}) {
  try {
    const enabled = localStorage.getItem('telemetry_enabled') !== 'false';
    if (!enabled) return;

    await fetch(ANALYTICS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectName: PROJECT_NAME,
        event,
        page: data.page || '',
        version: data.version || '',
        platform: data.platform || '',
        arch: data.arch || '',
        client_id: getOrCreateAnonymousClientId(),
      }),
    });
  } catch {
    // 埋点失败不能影响业务。
  }
}

function getOrCreateAnonymousClientId() {
  const key = 'analytics_client_id';
  const existing = localStorage.getItem(key);
  if (existing) return existing;

  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}
```

页面访问示例：

```ts
track('page_view', {
  page: 'settings',
  version: appVersion,
  platform: window.yibiao?.platform || '',
  arch: 'x64',
});
```

## 四、排查

| 问题 | 处理 |
| --- | --- |
| `unauthorized` | 检查统计页面输入的 `ADMIN_TOKEN` 是否与 Worker Secret 一致 |
| `NOTICE_STORE is not configured` | 先确认 Worker 的 `Settings -> Bindings` 存在 `NOTICE_STORE`，或本地运行 `cd analytics\worker; npm run setup:notice-kv` 后提交更新后的 `wrangler.jsonc` 并重新部署 Worker |
| 公告无法发布或读取 | 访问 `https://analytics.agnet.top/health`，确认 `noticeStoreConfigured` 为 `true` 后再测试公告发布 |
| `invalid projectName` | 检查项目名格式 |
| `invalid event` | 仅支持 `app_open`、`page_view`、`config_usage`、`ai_request`、`resource_click` |
| `missing page` | `page_view` 必须传 `page` |
| 查询为空 | 先上报测试数据，等待几十秒再查 |
| 自定义域名未生效 | 检查对应 Worker 的 `Settings -> Domains & Routes` 和 `wrangler.jsonc` |
| 绑定不存在 | 检查 API Worker 的 `Settings -> Bindings` 是否存在 `ANALYTICS` 和 `ANALYTICS_DB` |
| 历史总数没有当天数据 | Cron 默认北京时间 02:15 汇总昨日数据，今天的数据仍以 Analytics Engine 最近范围查询为准 |

### 6.1 下线旧 Queue

如果线上曾部署过旧 Queue 方案，不要先在 Cloudflare 后台删除 Queue binding，否则旧线上 `/track` 会因为缺少 `ANALYTICS_ROLLUP_QUEUE` 失败。安全顺序是：

1. 先部署当前去 Queue 的 Worker，确认 `/track` 成功返回 `{ "code": 0 }`。
2. 确认 `wrangler.jsonc` 和 Worker 绑定中不再需要 `ANALYTICS_ROLLUP_QUEUE`。
3. 再到 Cloudflare 删除 `openbidkit-analytics-rollup` Queue 和关联 consumer。

## 五、自动部署触发规则

Cloudflare Workers Builds 会在生产分支推送时触发构建。仓库里已将两个项目的 `deploy` 命令改为按目录校验：

| Worker | 监听目录 |
| --- | --- |
| `agnet-analytics-api` | `analytics/worker` |
| `agnet-analytics-dashboard` | `analytics/dashboard` |

如果本次提交没有修改对应目录，构建会成功结束，但不会执行 `wrangler deploy`。

如果需要强制重新部署，在 Cloudflare 的 Deploy command 临时改为：

```text
FORCE_DEPLOY=1 npm run deploy
```

重试成功后再改回：

```text
npm run deploy
```
