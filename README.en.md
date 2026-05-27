<img src="./screenshots/banner.webp" alt="Yibiao usage demo video" width="100%">

# Yibiao Bid Toolbox - AI Bid Proposal Writing Assistant

<p align="center">
  <a href="./README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-41+-47848f.svg" alt="Electron">
  <img src="https://img.shields.io/badge/React-19+-61dafb.svg" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-5.9+-3178c6.svg" alt="TypeScript">
  <img src="https://img.shields.io/badge/Vite-7+-646cff.svg" alt="Vite">
  <a href="https://deepwiki.com/FB208/OpenBidKit_Yibiao"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
</p>

<p align="left">
  <strong>🚀 Out-of-the-box, open-source, and free AI bid proposal writing tool</strong>
  <br>
  Yibiao Bid Toolbox is an intelligent bid document creation tool for tendering and bidding scenarios. It is fully open source and includes AI-generated technical proposals, image-and-text generation, commercial bid support, enterprise knowledge base management, duplicate checking, rejection-risk checks, tender information, and more features under development.
  <br>
  It supports all OpenAI-like AI APIs. DeepSeek, LongCat, and Volcano Ark are deeply adapted, and local models can also be connected through Ollama, LM Studio, and similar tools.
  <br>
  <br>
  <strong>❓ What problem does it solve?</strong>
  <br>
  There are many paid AI bid-writing tools today, but they are extremely expensive. A single proposal can cost tens of yuan, and unless a company reimburses it, small-business workers can hardly afford them. Free tools often have very poor quality. OpenBidKit aims to become the OpenClaw of the bidding field by providing an out-of-the-box, high-quality proposal writing tool. In our tests, generating a 200,000-word bid proposal with DeepSeek V4 Flash costs only about 0.8-1 yuan. We are also working hard to support the completely free LongCat Flash Lite, so proposal writers no longer need to buy their own feed.
</p>

## 🌐 Official Website

**Online Experience**: [https://yibiao.pro](https://yibiao.pro)

Visit the website for more product information, online demos, and technical support.

> **Ad Slot · Jlaude API**
>
> Focused on the full GPT series, lower cost than DeepSeek V4 PRO, stable and fast for 7 months. Native chat in Yanwuchang plus unlimited-canvas image generation, all in one place, practical and affordable.
>
> Direct link: https://jlaudeapi.com

<h2 align="center">✨ Features & Advantages</h2>

<p align="center">
  <strong>AI Proposal Writing · Bid AI · AI Bid Generation · Technical Proposal Drafting · Tender Response Generation</strong><br>
  <sub>More than proposal draft generation: open-source control, local workspace, reusable knowledge, visual expression, and recoverable workflows.</sub>
</p>

<table>
  <tr>
    <td width="33%" valign="top">
      <strong>🧩 Open Source & Controllable</strong><br>
      An open-source AI bid proposal project that can be self-hosted, customized, and adapted to team workflows.
    </td>
    <td width="33%" valign="top">
      <strong>💻 Local Desktop Workspace</strong><br>
      Configurations, caches, and generated results are stored locally, suitable for Windows bid-document workflows.
    </td>
    <td width="33%" valign="top">
      <strong>📄 Multiple Parsing Options</strong><br>
      Supports local parsing and MinerU parser configuration for both regular documents and more complex files.
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <strong>📚 Knowledge Base Reuse</strong><br>
      Store company materials, historical cases, and proposal assets so bid AI output better matches your business context.
    </td>
    <td width="33%" valign="top">
      <strong>🧩 Images & Diagrams</strong><br>
      Supports Mermaid preview, generated illustrations, and diagram conversion for Word export.
    </td>
    <td width="33%" valign="top">
      <strong>🔄 Background Task Recovery</strong><br>
      Long-running parsing and generation tasks are persisted, so progress can be restored after switching pages.
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <strong>🛡️ Risk Check Workspaces</strong><br>
      Duplicate-check and rejection-risk checklist workspaces are reserved for repeated wording and response-completeness checks.
    </td>
    <td width="33%" valign="top">
      <strong>⚙️ Custom AI Configuration</strong><br>
      Configure text models, image models, and file parsing providers to fit your team's preferred stack.
    </td>
    <td width="33%" valign="top">
      <strong>✏️ Editable Workflow</strong><br>
      Outlines, generated content, and expansion results remain editable for human review and final polishing.
    </td>
  </tr>
</table>

## 📦 Download & Usage

### ⬇️ Download

Download the latest release from [GitHub Releases](https://github.com/yibiaoai/yibiao-simple/releases), then run the installer or executable file.

### 🎬 Usage Demo

<a href="https://www.bilibili.com/video/BV1sC5i6SE74">
  <img src="./screenshots/new_home.png" alt="Yibiao usage demo video" width="100%">
</a>

[Watch the usage demo on Bilibili](https://www.bilibili.com/video/BV1sC5i6SE74)

## 🛠️ Technical Architecture

The current product is an independent desktop client under `client/`. It does not depend on the legacy `frontend/` or `backend/` structure.

- **Desktop**: Electron Main / Preload provides local file access, configuration, export, and background task capabilities.
- **Renderer**: Vite + React + TypeScript, with global CSS and Radix UI primitives.
- **Features**: Technical proposal, knowledge base, duplicate-check workspace, rejection-risk checklist workspace, and settings.
- **Local Data**: Configuration, workspace data, and generated caches are stored under Electron `userData`.
- **Packaging**: Built for Windows / macOS with electron-builder.

### 🏗️ Project Structure

```
Yibiao Bid Toolbox/
├── client/                    # Current desktop client
│   ├── electron/              # Main, Preload, IPC, and local services
│   ├── src/                   # Renderer source code
│   │   ├── app/               # Routing, menu, and providers
│   │   ├── features/          # Technical proposal, knowledge base, and other modules
│   │   └── shared/            # Shared types, AI helpers, UI, and utilities
│   ├── assets/                # Icons and static assets
│   └── package.json           # Client dependencies and packaging config
├── analytics/                 # Independent analytics service
├── tools/                     # Independent document parsing and MinerU validation tools
└── README.md                  # Chinese README
```

## 🤝 Contributing

Contributions are welcome.

1. **🐛 Bug Reports**: Report bugs in [Issues](https://github.com/yibiaoai/yibiao-simple/issues).
2. **💡 Feature Requests**: Suggest new features and improvements.
3. **🔧 Code Contributions**: Fork the repository and submit a pull request.
4. **📖 Documentation**: Help improve documentation and usage guides.

## 📄 License

This project is released under the [GNU Affero General Public License v3.0](LICENSE).

You may use, modify, distribute, and commercialize this project, but modified versions, redistributed copies, and network-accessible services must comply with the AGPL-3.0 source-sharing obligations and preserve the [NOTICE](NOTICE) attribution notice, original repository link, and author information.

## 🙋‍♂️ Contact

<table>
  <tr>
    <td width="50%" valign="top">

- **Official Website**: [https://yibiao.pro](https://yibiao.pro)
- **Feedback**: [GitHub Issues](https://github.com/yibiaoai/yibiao-simple/issues)
- **Email**: support@yibiao.pro

    </td>
    <td width="33%" valign="top">
      <p>
        <img src="./screenshots/企业微信.png" alt="WeCom QR code" width="180">
      </p>
    </td>
  </tr>
</table>

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
  ⭐ If this project helps you, please give it a Star.
</p>

<p align="center">
  Made with ❤️ by the Yibiao Team
</p>

`AI Proposal Writing` `Bid AI` `AI Bid Generation` `Free Bid Proposal Tool`
