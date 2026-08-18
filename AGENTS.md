# AGENTS.md

## 范围
- 当前有效产品代码在 `client/`。
- `analytics/` 是独立 Cloudflare Worker API 与 Dashboard：除埋点采集、聚合和查看外，也承载客户端公告、资源、插件、模型信息、许可证和 Agent 失败诊断等在线服务；修改上述在线服务协议时同步检查两端。

## Client
- 开发 `client/` 前以及初次对话时，必须先完整阅读 `client/开发说明.md`，保持框架风格一致性。
- 没有 root `package.json`；客户端命令都先 `cd client`。
- 安装/验证：`npm ci` 后 `npm run build`。`npm run build` 等价 `tsc --noEmit && vite build`，仓库未配置统一 lint/test 脚本。
- 开发启动：`npm run dev`，固定 Vite `127.0.0.1:5173 --strictPort` 后再启动 Electron。
- 打包：`npm run dist:win` / `npm run dist:mac`，配置在 `client/package.json` 的 `build` 字段，产物在 `client/release/`。
- Electron Main 和 preload 是 CommonJS：`client/electron/**/*.cjs`；Renderer 是 ESM TypeScript：`client/src/**/*.ts(x)`。
- Renderer 不直接访问 Node、`fs`、`path`、`ipcRenderer`，只通过 `window.yibiao`；改 preload API 时同步 `client/src/shared/types/ipc.ts`。
- 新业务 IPC 默认只注册/转发，业务逻辑放 `electron/services/*.cjs`；数据库生命周期装配和现有插件编排是例外，不作为普通功能模板。
- Main 侧文件读写显式使用 UTF-8，并把 Windows 中文路径当默认场景处理。

## Client 架构
- 主窗口 Renderer 入口：`client/src/main.tsx` -> `AppProviders` -> `WorkspaceDatabaseGate` -> `App` -> `AppShell` / `src/app/AppRouter.tsx`；开发者独立窗口由 `main.tsx` 的 `?window=...` 分支挂载。
- 新增菜单页面要同步 `src/shared/types/navigation.ts`、`src/app/menuConfig.ts`、`src/app/AppRouter.tsx`、`src/components/Sidebar.tsx` 的图标映射，以及 `analytics/dashboard/public/src/pages/traffic.js` 的埋点路由中文名；页面操作条按需复用 `FloatingToolbar`。
- 功能代码放 `src/features/<feature>/`；跨功能运行时代码放 `src/shared/`，且不引用 feature。现有 bridge/type barrel 组合 feature 类型是边界例外，不扩展成组件或服务依赖。
- Renderer 可复用 Prompt 放 `src/shared/prompts/`，feature 或 Main 后台任务专用 Prompt 与对应 service/task 放在一起；不要在产品组件内硬编码大段 Prompt。
- UI 使用全局 CSS + Radix 基础组件，不使用 Tailwind；用户可见文案用中文。
- 成功、失败和普通提示走 `shared/ui/ToastProvider` 的 `success` / `error` / `info`，不要用 `alert`；确认或长文案使用 `AppDialog`。
- 页面根容器保持 `height: 100%`/`min-height: 0`，长内容在页面内部滚动；不要依赖 `body` 全局滚动或为 `FloatingToolbar` 额外留大空白。

## 数据与流程
- 配置存到 Electron `userData/user_config.json`；业务工作区存到 `userData/workspace/`；结构化业务状态的权威存储是 `userData/workspace/yibiao.sqlite`。运行时 schema/migration 以 `electron/services/sqliteDatabase.cjs` 为准，改表时同步根目录 `sql/workspace_schema.sql`；技术方案旧 `technical_plan.json` 仅是启动清理对象，不得继续读写。
- Renderer 只用 `localStorage` 存轻量 UI 偏好；草稿、API Key、流程状态以及业务正文都走 Main 侧存储/IPC。
- 技术方案除文件导入/展示外，标书分析、目录、全局事实和正文等耗时流程都在 Electron Main 后台任务中运行，并持续写入对应 SQLite Store；页面卸载不应取消任务。
- 技术方案目录与正文以 `technical_plan_outline_nodes`（Renderer 对应 `outlineData.outline[*].content`）为权威。`saveOutline()` 的 `reason` 是持久化协议：`replace` 清空全部旧正文，`edit` / `delete` / `add-*` 只使受影响节点失效，`sort` 重映射并保留正文和相关状态；不要在 Renderer 复制清理规则。
- Mermaid 图以 Markdown `mermaid` 代码块保存；Renderer 本地渲染预览，Word 导出由 Main 本地转图片（不依赖外网）并通过 `window.yibiao.export.onWordExportProgress()` 报进度。
- `MarkdownRenderer` 当前默认允许原始 HTML；AI、Agent、远程公告等非本地可信内容必须显式传 `allowRawHtml={false}`，只有明确需要保留本地解析 HTML 时才开启。

## 聚焦验证
- 改 Renderer/TypeScript：`cd client; npm run build`。
- 改 Electron Main/preload：先在 `client/` 下运行 `node --check electron\preload.cjs` 或对应 `.cjs` 文件，再跑 `npm run build`；涉及窗口/IPC 还要 `npm run dev` 手动打开验证。
- 改 SQLite Store、migration 或 native 模块：增加 `npm run smoke:electron-native`；有对应 `*.test.cjs` 时用 `node --test <test-file>` 定向执行。
- 改依赖：`cd client; npm audit`。
- `npm run build` 可能只有既有 chunk 体积警告；不要把它当失败，除非命令退出非 0。

## 发布
- `.github/workflows/release.yml` 只在推送 `v*` tag 或手动输入 `tag_name` 时发布客户端。
- Release CI 使用 Node 22，在 `client/` 下 `npm ci`，从 tag 同步 `package.json` 版本，再用 `electron-builder --publish never` 构建并由 `gh release upload` 上传产物。
- 正式发布会用私钥生成构建证明，但尚未接入 Windows/macOS 操作系统代码签名；未签名提示是已知发布约束，不要在普通功能改动里临时绕过。

## Analytics
- Worker：`cd analytics\worker; npm install; npm run dev` 或 `npm run deploy`。
- Dashboard：`cd analytics\dashboard; npm install; npm run dev` 或 `npm run deploy`。
- `analytics/scripts/deploy-if-changed.mjs` 在 Cloudflare Workers CI 下只部署对应目录变化；强制部署用 `FORCE_DEPLOY=1 npm run deploy`。
- 生产 API Worker 所在 Cloudflare 账户已启用 Workers Paid Plan；当前允许使用 5 个统计 Cron 和独立的模型信息同步 Cron，不要再按免费计划 5 个 Cron 上限要求合并任务。
- 不把 `ACCOUNT_ID`、`ADMIN_TOKEN`、`ANALYTICS_API_TOKEN` 等密钥写入仓库；Worker 配置保留 `keep_vars: true`，不要在 `wrangler.jsonc` 增加 `secrets.required`。
- 禁止删除、绕过或弱化任何埋点、统计、Analytics Dashboard 展示和 Worker 聚合逻辑；如确需调整，必须等价保留统计能力并说明影响。

## 必须遵守的要求
- 尽量保持整体编码风格统一；前端组件和样式优先封装、复用现有实现。
- 当用户提出功能异常时，不要猜原因；先真实排查代码和复现链路，按需增加诊断日志，精准定位后再修复。
- 这是一个开源客户端项目，前端后端等所有数据传输层都在用户本地客户端上，Electron Renderer、preload、Main 和内部 IPC 属于用户本机可信边界，不在层级间重复堆叠参数校验，只在用户输入层进行校验，进入软件传输之后，任何层级间不用校验。
- 这是一个开源客户端项目，前端后端等所有数据传输层都在用户本地客户端上，客户不会自己攻击自己，不会恶意使用程序，所以不需要加过多安全性兜底。
- 严格遵守用户命令。额外想法只在 Plan 阶段提出；进入 Build 阶段后仅执行确认方案，如需增加范围必须先向用户确认。
