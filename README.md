# 易标投标工具箱 - AI智能标书写作助手

<p align="center">
  <strong>简体中文</strong> | <a href="./README.en.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-41+-47848f.svg" alt="Electron">
  <img src="https://img.shields.io/badge/React-19+-61dafb.svg" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-5.9+-3178c6.svg" alt="TypeScript">
  <img src="https://img.shields.io/badge/Vite-7+-646cff.svg" alt="Vite">
</p>


<p align="left">
  <strong>🚀 开箱即用的开源AI标书编写工具，专注 AI写标书、标书AI、AI标书生成和技术标编写</strong>
  <br>
  易标投标工具箱是一款面向招投标场景的智能标书制作工具，适合标书人员、售前工程师、项目经理和投标团队使用。项目围绕“上传招标文件到导出 Word 标书”的完整流程，提供招标文件解析、评分点提取、标书目录生成、技术方案正文生成、内容扩写改写、知识库素材复用、标书查重、废标项检查等能力，帮助用户更快完成结构完整、响应清晰、可继续编辑的投标方案、技术标和标书初稿。
  <br>
  如果你正在寻找 AI写标书 工具、标书AI 助手、AI标书 生成软件、投标文件生成工具或技术标编写助手，易标可以作为开源方案参考，用于提升标书制作效率，减少重复编写、人工整理评分点和检查废标风险的时间成本。
</p>

## 🌐 官方网站

**在线体验**: [https://yibiao.pro](https://yibiao.pro)

获取更多产品信息、在线体验和技术支持。

> **广告位 · 合作招募**
>
> **有没有支持图文API的中转站合作下呀~~~**
>
> 支持生图 / 图文模型 / OpenAI Like API，欢迎合作接入。


<h2 align="center">✨ 核心功能与优势</h2>

<p align="center">
  <strong>AI写标书 · 标书AI · AI标书生成 · 技术标编写 · 投标文件生成</strong><br>
  <sub>不止生成标书初稿，更强调开源可控、本地工作区、素材复用、图文表达和流程可恢复。</sub>
</p>

<table>
  <tr>
    <td width="33%" valign="top">
      <strong>🧩 开源可控</strong><br>
      开源 AI标书 项目，可自行部署、二次开发和适配团队流程。
    </td>
    <td width="33%" valign="top">
      <strong>💻 本地桌面工作区</strong><br>
      配置、缓存和生成结果保存在本机，适合 Windows 标书文件处理。
    </td>
    <td width="33%" valign="top">
      <strong>📄 多方式文档解析</strong><br>
      支持本地解析与 MinerU 解析配置，兼顾常规文档和复杂文件。
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <strong>📚 知识库复用</strong><br>
      沉淀企业资料、历史案例和方案素材，让标书AI更贴合业务。
    </td>
    <td width="33%" valign="top">
      <strong>🧩 图文与图表</strong><br>
      支持 Mermaid 预览、正文配图和图表转 Word，增强方案表达。
    </td>
    <td width="33%" valign="top">
      <strong>🔄 后台任务恢复</strong><br>
      解析、生成等耗时任务持续落盘，切换页面后仍可恢复进度。
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <strong>🛡️ 风险检查入口</strong><br>
      预留标书查重、废标项检查工作区，聚焦重复表达和响应完整性。
    </td>
    <td width="33%" valign="top">
      <strong>⚙️ 自定义AI配置</strong><br>
      支持文本模型、生图模型和文件解析方式配置，适配团队习惯。
    </td>
    <td width="33%" valign="top">
      <strong>✏️ 可编辑工作流</strong><br>
      目录、正文和扩写结果可持续调整，方便 AI写标书 后人工定稿。
    </td>
  </tr>
</table>



## 📦 下载与使用

### ⬇️ 下载方式

从 [GitHub Releases](https://github.com/yibiaoai/yibiao-simple/releases) 下载最新版本，运行安装包或可执行文件即可启动。

### 🎬 使用方式

<video src="./screenshots/知识库+正文生成.mp4" controls="controls" width="100%" poster="./screenshots/5.png">
  您的浏览器不支持视频播放，请查看 screenshots/知识库+正文生成.mp4。
</video>

[无法播放？点击查看演示视频](./screenshots/知识库+正文生成.mp4)

## 🛠️ 技术架构

当前产品主体是 `client/` 下的独立桌面客户端，不依赖旧 `frontend/`、`backend/` 结构。

- **桌面端**：Electron Main / Preload 提供本地文件、配置、导出和后台任务能力
- **界面层**：Vite + React + TypeScript，使用全局 CSS 和 Radix UI 基础组件
- **业务模块**：技术方案、知识库、标书查重、废标项检查、设置页
- **本地数据**：配置、工作区、生成缓存保存在 Electron `userData` 目录
- **打包发布**：使用 electron-builder 构建 Windows / macOS 客户端

### 🏗️ 项目结构

```
易标投标工具箱/
├── client/                    # 当前桌面客户端主体
│   ├── electron/              # Main、Preload、IPC、本地服务
│   ├── src/                   # Renderer 应用源码
│   │   ├── app/               # 路由、菜单、Provider
│   │   ├── features/          # 技术方案、知识库等业务模块
│   │   └── shared/            # 通用类型、AI、UI、工具函数
│   ├── assets/                # 图标与静态资源
│   └── package.json           # 客户端依赖和打包配置
├── analytics/                 # 独立埋点服务
├── tools/                     # 独立文档解析与 MinerU 验证工具
└── README.md                  # 项目文档
```

## 🤝 贡献指南

欢迎各种形式的贡献！

1. **🐛 问题反馈**: 在 [Issues](https://github.com/yibiaoai/yibiao-simple/issues) 中报告bug
2. **💡 功能建议**: 提出新功能需求和改进建议  
3. **🔧 代码贡献**: Fork项目，提交Pull Request
4. **📖 文档完善**: 帮助改进文档和使用说明


## 📄 许可证

本项目基于 [MIT License](LICENSE) 开源协议发布。

## 🙋‍♂️ 联系我们

- **官方网站**: [https://yibiao.pro](https://yibiao.pro)
- **问题反馈**: [GitHub Issues](https://github.com/yibiaoai/yibiao-simple/issues)
- **邮箱联系**: support@yibiao.pro

<p>
  <strong>企业微信</strong><br>
  <img src="./screenshots/企业微信.png" alt="企业微信二维码" width="180">
</p>

## Star History

<a href="https://www.star-history.com/?repos=FB208%2FOpenBidKit_Yibiao&type=timeline&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=FB208/OpenBidKit_Yibiao&type=timeline&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=FB208/OpenBidKit_Yibiao&type=timeline&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=FB208/OpenBidKit_Yibiao&type=timeline&legend=top-left" />
 </picture>
</a>

---

<p align="center">
  ⭐ 如果这个项目对您有帮助，请给我们一个Star支持！
</p>



<p align="center">
  Made with ❤️ by 易标团队 
</p>
