# 埋点统计部署手册

本目录维护通用匿名埋点统计服务，采用 `Cloudflare Workers + Analytics Engine + Workers Static Assets`。

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

核心接口：

| 接口 | 用途 | 鉴权 |
| --- | --- | --- |
| `GET /health` | 检查 API Worker | 无 |
| `POST /track` | 上报埋点 | 无 |
| `GET /api/projects` | 查询最近 90 天出现过的项目名 | `ADMIN_TOKEN` |
| `GET /api/summary` | 查询每日统计、页面排行、版本分布 | `ADMIN_TOKEN` |
| `GET /api/latest` | 查询最近事件 | `ADMIN_TOKEN` |

事件类型：

| event | 说明 | page 是否必填 |
| --- | --- | --- |
| `app_open` | 应用打开 | 否 |
| `page_view` | 页面访问 | 是 |

统计页面使用：

1. 打开 `https://static.analytics.agnet.top`。
2. API 地址填写 `https://analytics.agnet.top`。
3. 输入 Worker Secret 中配置的 `ADMIN_TOKEN`。
4. 输入项目名，例如 `yibiao-client`。
5. 点击“刷新”。

## 二、首次部署

### 1. 启用 Analytics Engine

1. 登录 Cloudflare Dashboard。
2. 进入 `存储和数据库 -> Analytics Engine`。
3. 点击 `Enable`。

Dataset 不需要手动创建，第一次写入后会自动创建 `agnet_analytics`。

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
| 变量保留 | `keep_vars: true`，避免部署覆盖后台配置 |

部署后在 Worker 的 `Settings -> Variables and Secrets` 配置 Secret：

| Secret | 说明 |
| --- | --- |
| `ACCOUNT_ID` | Cloudflare Account ID |
| `ADMIN_TOKEN` | 统计看板查询密码 |
| `ANALYTICS_API_TOKEN` | 上一步创建的 API Token |

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

Analytics Engine 写入后可能需要等待几十秒才能查到。

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
| `invalid projectName` | 检查项目名格式 |
| `invalid event` | 仅支持 `app_open`、`page_view` |
| `missing page` | `page_view` 必须传 `page` |
| 查询为空 | 先上报测试数据，等待几十秒再查 |
| 自定义域名未生效 | 检查对应 Worker 的 `Settings -> Domains & Routes` 和 `wrangler.jsonc` |
| 绑定不存在 | 检查 API Worker 的 `Settings -> Bindings` 是否存在 `ANALYTICS` |
