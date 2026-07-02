# AGENTS.md

## 范围
- 当前有效产品代码在 `client/`；
- `analytics/` 是独立 Cloudflare Workers 埋点服务，用于统计、分析、查看`client/`中提交的埋点信息。

## Client
- 开发Client前，必须先阅读`client/开发说明.md`，保持框架风格一致性。
- 没有 root `package.json`；客户端命令都先 `cd client`。
- 安装/验证：`npm ci` 后 `npm run build`。`npm run build` 等价 `tsc --noEmit && vite build`，仓库未配置 lint/test 脚本。
- 开发启动：`npm run dev`，固定 Vite `127.0.0.1:5173 --strictPort` 后再启动 Electron。
- 打包：`npm run dist:win` / `npm run dist:mac`，配置在 `client/package.json` 的 `build` 字段，产物在 `client/release/`。
- Electron Main 和 preload 是 CommonJS：`client/electron/**/*.cjs`；Renderer 是 ESM TypeScript：`client/src/**/*.ts(x)`。
- Renderer 不直接访问 Node、`fs`、`path`、`ipcRenderer`，只通过 `window.yibiao`；改 preload API 时同步 `client/src/shared/types/ipc.ts`。
- `electron/ipc/*.cjs` 只注册/转发 IPC，业务逻辑放 `electron/services/*.cjs`。
- Main 侧文件读写显式使用 UTF-8，并把 Windows 中文路径当默认场景处理。
- `client/开发说明.md`很重要，初次对话时一定要读取

## Client 架构
- Renderer 入口：`client/src/main.tsx` -> `AppProviders` -> `App` -> `src/app/AppRouter.tsx`。
- 新增主菜单页面要同时改 `src/shared/types/navigation.ts`、`src/app/menuConfig.ts`、`src/app/AppRouter.tsx`；需要全局工具条再改 `src/app/toolbarConfig.tsx`。
- 功能代码放 `src/features/<feature>/`；跨功能代码放 `src/shared/`，且 `shared/` 不引用 feature。
- Prompt 统一在 `src/shared/prompts/`；不要在组件内硬编码大段 prompt。
- UI 使用全局 CSS + Radix 基础组件，不使用 Tailwind；用户可见文案用中文。
- 成功、失败、警告提示走 `shared/ui/ToastProvider`，不要用 `alert`。
- 页面根容器保持 `height: 100%`/`min-height: 0`，长内容在页面内部滚动；不要依赖 `body` 全局滚动或为 `FloatingToolbar` 额外留大空白。

## 数据与流程
- 配置存到 Electron `userData/user_config.json`；工作区存到 `userData/workspace/`；技术方案权威缓存是 `userData/workspace/technical_plan.json`。
- Renderer 只用 `localStorage` 存轻量 UI 偏好；大文本、草稿、API Key、流程状态都走 Main 侧存储/IPC。
- 技术方案 Step01 只导入/展示 Markdown；Step02/Step03/Step04 的耗时任务都在 Electron Main 后台任务中跑，并持续写入 `workspaceStore`。
- 正文展示和导出以 `outlineData.outline[*].content` 为权威来源；目录重新生成、编辑、添加或删除后必须清空旧正文内容和生成缓存。
- Mermaid 图以 Markdown `mermaid` 代码块保存；Renderer 本地渲染预览，Word 导出由 Main 转图片并通过 `window.yibiao.export.onWordExportProgress()` 报进度。
- AI 生成 Markdown 默认不启用 `rehypeRaw`；只有明确需要渲染可信 HTML 时才局部开启并说明原因。

## 聚焦验证
- 改 Renderer/TypeScript：`cd client; npm run build`。
- 改 Electron Main/preload：先在 `client/` 下运行 `node --check electron\preload.cjs` 或对应 `.cjs` 文件，再跑 `npm run build`；涉及窗口/IPC 还要 `npm run dev` 手动打开验证。
- 改依赖：`cd client; npm audit`。
- `npm run build` 可能只有既有 chunk 体积警告；不要把它当失败，除非命令退出非 0。

## 发布
- `.github/workflows/release.yml` 只在推送 `v*` tag 或手动输入 `tag_name` 时发布客户端。
- Release CI 使用 Node 22，在 `client/` 下 `npm ci`，从 tag 同步 `package.json` 版本，再用 `electron-builder --publish never` 构建并由 `gh release upload` 上传产物。
- 当前未接入代码签名；Windows/macOS 未签名提示是已知发布约束，不要在普通功能改动里临时绕过。

## Analytics
- Worker：`cd analytics\worker; npm install; npm run dev` 或 `npm run deploy`。
- Dashboard：`cd analytics\dashboard; npm install; npm run dev` 或 `npm run deploy`。
- `analytics/scripts/deploy-if-changed.mjs` 在 Cloudflare Workers CI 下只部署对应目录变化；强制部署用 `FORCE_DEPLOY=1 npm run deploy`。
- 不把 `ACCOUNT_ID`、`ADMIN_TOKEN`、`ANALYTICS_API_TOKEN` 等密钥写入仓库；Worker 配置保留 `keep_vars: true`，不要在 `wrangler.jsonc` 增加 `secrets.required`。
- 禁止删除、绕过或弱化任何埋点、统计、Analytics Dashboard 展示和 Worker 聚合逻辑；如确需调整，必须等价保留统计能力并说明影响。

## 必须遵守的要求
- 尽量保持整体编码风格的统一。
- 前端组件和样式尽量封装和复用，保持样式风格统一。
- 当用户提出功能异常时，不要猜原因，而是真实的去排查代码，增加调试日志，精准定位问题再去想办法解决。
- 任何好的想法，应该在设计阶段，即Plan模式下提出，如果进入到build阶段，只按照原定方案执行，禁止增加任何多余内容，如需增加需要向用户确认。
- 这是一个开源客户端项目，前端后端等所有数据传输层都在用户本地客户端上，所以所有数据传输直接都是相互信任的，不要加多余的数据校验，如果需要任何校验，只在用户输入层进行校验，进入软件传输之后，任何层级间不用校验。
- 这是一个开源客户端项目，前端后端等所有数据传输层都在用户本地客户端上，我们默认客户不会自己攻击自己，不会恶意使用程序，所以不需要加过多安全性兜底
- 严格遵守用户命令，你有任何好的想法都应该在plan阶段跟用户确认，而不是在build阶段自行添加