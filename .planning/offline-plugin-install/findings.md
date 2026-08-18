# 发现与决策

## 需求
- 插件管理页增加“离线安装”按钮。
- 用户选择 ZIP 后自动安装；同 ID 插件直接覆盖升级。
- 不限制插件来源或 GitHub 仓库。

## 研究发现
- 现有插件服务已依赖 `adm-zip`，无需增加依赖。
- 插件安装目录为 `app.getPath('userData')/plugins/<pluginId>`。
- 市场安装已具备 ZIP 解压、manifest 读取、启用/禁用和模块缓存清理能力。
- Renderer 通过 `window.yibiao.plugins` 调用 preload，IPC 只转发到 `pluginService.cjs`。
- 插件页面已有统一 Toast、操作中禁用状态和插件列表刷新逻辑。
- preload 的 plugins bridge 和 YibiaoBridge.plugins 类型需要同步增加 installOffline。
- 项目现有文件选择统一使用 Electron dialog.showOpenDialog，取消时返回结构化结果。

## 技术决策
| 决策 | 理由 |
|------|------|
| 文件选择放在 Electron IPC，安装业务放在 pluginService | 保持 Renderer 不访问 Node 与文件系统 |
| ZIP 根目录必须直接包含 manifest.json | 与现有市场安装包结构一致，不增加旧结构兼容 |
| 按 manifest.id 覆盖插件目录 | 满足同 ID 自动升级，避免依赖来源或仓库 |
| 覆盖前如已启用则先停用，安装后恢复启用 | 避免旧模块和窗口继续运行 |
| 返回 installed/updated 与版本信息 | Renderer 可给出明确结果提示 |

## 遇到的问题
| 问题 | 解决方案 |
|------|---------|

## 资源
- client/开发说明.md
- client/electron/services/pluginService.cjs
- client/electron/ipc/pluginIpc.cjs
- client/electron/preload.cjs
- client/src/shared/types/ipc.ts
- client/src/features/plugins/pages/PluginsPage.tsx

- 插件列表会主动合并市场中不存在的本地插件，因此任意来源的离线插件安装后可直接显示在管理页。
- 离线安装接口已贯通服务层、IPC、preload、类型与页面；ZIP 根目录必须含 manifest.json 和 main.cjs。
