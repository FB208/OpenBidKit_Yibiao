# 易标项目集成 OpenCode Server + aiservice Proxy 改造方案

生成日期：2026-06-19  
适用项目：`FB208/OpenBidKit_Yibiao` / `client` Electron 桌面端  
推荐方案：**内置 OpenCode Server Sidecar + 本地 OpenAI-compatible Proxy + 复用现有 configStore，正式接入共享 token 统计与开发日志，第一版同时支持 Windows 与 macOS**

本版修订重点：

- **正式框架代码**：长期保留，只负责 OpenCode Server 隔离启动、OpenCode 专用 AI proxy、HTTP 调用、IPC 暴露。
- **开发者测试页代码**：只放在开发者模式菜单下，用来完整验证链路，不参与现有业务流程，测试完成后可以整体删除。
- **业务接入代码**：暂不改造现有技术方案、废标项检查、查重等流程。等测试页跑通后，再单独接入具体业务。
- **本次修订范围**：在 v3 基础上补充 GitHub Actions 按平台下载并注入 OpenCode binary；第一版明确支持 Windows x64、macOS x64、macOS arm64；补齐 macOS 打包、权限、使用说明与验证步骤。其余安全限制不新增。

---

## 0. 结论

不建议复制并深度改造 OpenCode core。推荐把 OpenCode 当作一个隔离运行的 agent runtime：

```text
Electron Main
  ├─ configStore：继续读取 userData/user_config.json
  ├─ aiService：继续服务现有业务 AI 请求，不作为 OpenCode 请求唯一出口
  ├─ textTokenStatsStore：共享 token 统计源，现有 aiService 与 OpenCode proxy 共用
  ├─ aiServiceOpenAiProxy：本地 127.0.0.1 OpenAI-compatible 代理，内置 OpenCode 专用请求、队列、日志、共享 token 统计和限流重试
  ├─ OpenCode Server：内置二进制，随机端口，临时 HOME，临时配置
  └─ agentService：创建任务 workspace，调用 OpenCode HTTP API，返回结果/diff
```

核心原则：

1. 真实 AI Key 只留在你们自己的 `configStore` 中。
2. OpenCode 只看到一个临时本地 proxy token，不看到真实服务商 Key。
3. OpenCode Server 使用内置 binary、随机端口、临时 HOME/USERPROFILE/XDG 目录、`--pure` 和运行时 inline 配置，避免读取用户系统 OpenCode 配置或 workspace 内覆盖配置。
4. OpenCode 只做自主规划、读写沙箱 workspace、产出结果。
5. 开发者测试页只验证这套链路，不直接接入现有业务流程。
6. 第一版发布范围明确为 Windows x64、macOS x64、macOS arm64；GitHub Actions 每个构建 job 只下载并打包当前 job 对应平台的 OpenCode binary。

---

## 1. 代码边界：哪些保留，哪些可删

### 1.1 正式框架代码：后续长期保留

这些代码是 OpenCode agent runtime 的基础能力，后续业务接入也会复用：

| 文件 | 性质 | 是否长期保留 | 职责 |
|---|---|---:|---|
| `client/vendor/opencode/**` | 正式框架 | 是 | Actions 构建时只放当前平台 OpenCode binary，不调用用户 PATH |
| `client/scripts/prepare-opencode-binary.cjs` | 正式框架 | 是 | 根据构建平台下载并准备 OpenCode binary |
| `client/scripts/verify-opencode-binary.cjs` | 正式框架 | 是 | 验证当前构建只包含当前平台 binary |
| `client/scripts/verify-packaged-opencode-binary.cjs` | 正式框架 | 是 | 验证打包产物内的 OpenCode binary 可执行 |
| `.github/workflows/release.yml` 改动 | 正式框架 | 是 | Windows/macOS 构建时分别注入对应 OpenCode binary |
| `client/electron/utils/paths.cjs` 改动 | 正式框架 | 是 | 提供 agent runtime/cache/binary 路径 |
| `client/electron/services/opencode/aiServiceOpenAiProxy.cjs` | 正式框架 | 是 | 本地 `/v1/chat/completions` 代理；内置 OpenCode 专用上游请求、队列、统计、日志和限流重试 |
| `client/electron/services/opencode/opencodeConfigFactory.cjs` | 正式框架 | 是 | 生成临时 `opencode.json` |
| `client/electron/services/opencode/opencodeServerRunner.cjs` | 正式框架 | 是 | 隔离启动 OpenCode Server |
| `client/electron/services/opencode/opencodeHttpClient.cjs` | 正式框架 | 是 | 调用 OpenCode HTTP API |
| `client/electron/services/agentService.cjs` | 正式框架 | 是 | 统一 agent 任务入口 |
| `client/electron/ipc/agentIpc.cjs` | 正式框架 | 是 | 暴露 `agent:run` IPC |
| `client/electron/ipc/index.cjs` 改动 | 正式框架 | 是 | 创建并注册 `agentService` |
| `client/electron/preload.cjs` 改动 | 正式框架 | 是 | 暴露 `window.yibiao.agent.run()` |
| `client/src/shared/types/ipc.ts` 改动 | 正式框架 | 是 | 补齐 `window.yibiao.agent.run()` bridge 类型 |
| `client/package.json` 改动 | 正式框架 | 是 | 打包 OpenCode binary |

### 1.2 开发者测试代码：只用于验证，可整体删除

这些代码只用于开发者模式下的完整 smoke test。删除后不影响正式框架，只是没有 UI 测试入口。

| 文件 | 性质 | 是否可删 | 职责 |
|---|---|---:|---|
| `client/src/features/developer/pages/OpenCodeAgentTestPage.tsx` | 测试页 | 是 | 一键完整测试 OpenCode agent 链路 |
| `client/src/app/menuConfig.ts` 中新增的 `developer-opencode-agent-test` 菜单项 | 测试入口 | 是 | 只在开发者模式下显示 |
| `client/src/app/AppRouter.tsx` 中新增的测试页 route | 测试入口 | 是 | 渲染测试页 |
| `client/src/shared/types/navigation.ts` 中新增的 `developer-opencode-agent-test` section id | 测试入口 | 是 | 让菜单和路由类型通过 |
| `client/src/components/Sidebar.tsx` 中新增的图标映射 | 测试入口 | 是 | 让 `Record<SectionId, Icon>` 类型通过 |
| `analytics/dashboard/public/src/pages/traffic.js` 中新增的页面中文名 | 测试入口 | 是 | 保持新增菜单页的埋点看板映射完整 |

### 1.3 明确不在本次改造中动的代码

本次不要修改这些业务流程：

```text
client/electron/services/taskService.cjs
client/electron/services/technicalPlan*.cjs
client/electron/services/rejectionCheck*.cjs
client/electron/services/duplicateCheck*.cjs
client/src/features/technical-plan/**
client/src/features/rejection-check/**
client/src/features/duplicate-check/**
```

测试页跑通之前，不要把 agent 结果混入现有业务状态、数据库或 UI。

---

## 2. 改造后正式调用链

正式框架调用链如下：

```text
Renderer 或未来业务服务
  ↓ window.yibiao.agent.run(payload)

Electron IPC
  ↓ agent:run

agentService
  ↓ 创建任务 workspace
  ↓ 启动 aiServiceOpenAiProxy
  ↓ 生成临时 opencode.json
  ↓ 启动隔离 OpenCode Server
  ↓ 调用 /session + /session/:id/message

OpenCode Server
  ↓ provider: yibiao/default
  ↓ OpenAI-compatible request

http://127.0.0.1:<proxyPort>/v1/chat/completions
  ↓ Bearer <临时 proxy token>

aiServiceOpenAiProxy
  ↓ configStore.load()
  ↓ OpenCode 专用 AI 请求适配、队列、限流重试、开发日志、共享 token 统计
  ↓ 真实 base_url/api_key/model_name
  ↓ 真实 AI 服务商
```

开发者测试页只是正式调用链的一个 UI 调用方，不包含任何业务逻辑。

---

## 3. 目录结构调整

新增目录建议：

```text
client/
  vendor/
    opencode/
      VERSION                         # 固定 OpenCode 版本，例如 v1.17.8
      manifest.json                   # Actions/本地脚本生成
      <platform>-<arch>/              # Actions/本地脚本生成；一次构建只存在当前平台目录
        opencode.exe                  # Windows
        opencode                      # macOS

  scripts/
    prepare-opencode-binary.cjs       # 正式框架：按平台下载 OpenCode binary
    verify-opencode-binary.cjs        # 正式框架：校验 vendor 中只包含当前平台 binary
    verify-packaged-opencode-binary.cjs # 正式框架：校验打包后的 resources/opencode

  electron/
    ipc/
      agentIpc.cjs

    services/
      textTokenStatsStore.cjs
      agentService.cjs
      opencode/
        aiServiceOpenAiProxy.cjs
        opencodeConfigFactory.cjs
        opencodeHttpClient.cjs
        opencodeServerRunner.cjs

  src/
    features/
      developer/
        pages/
          OpenCodeAgentTestPage.tsx   # 仅测试，可删
```

第一版平台要求：

```text
Windows x64：必须支持，构建时只注入 win32-x64/opencode.exe
macOS Intel：必须支持，构建时只注入 darwin-x64/opencode
macOS Apple Silicon：必须支持，构建时只注入 darwin-arm64/opencode
Linux：本版不作为发布目标，可保留代码兼容但不写入第一版验收
```

不要把全部平台 binary 一起放进每个安装包。仓库只保留下载脚本和版本文件；GitHub Actions 构建哪个系统/架构，就下载并放入对应版本的 OpenCode binary。

---

## 4. 第一步：内置 OpenCode binary，不调用用户 PATH

### 4.1 固定 OpenCode 版本

新增文件：`client/vendor/opencode/VERSION`

内容示例：

```text
v1.17.8
```

后续升级 OpenCode 时，只改这个文件或 GitHub Actions 变量 `OPENCODE_VERSION`，不要混用多个版本。升级必须单独跑 Windows、macOS x64、macOS arm64 三个平台的开发者测试页。

OpenCode 官方 release 目前提供 CLI 压缩包，例如 `opencode-darwin-arm64.zip`、`opencode-darwin-x64.zip`。Windows 资产名可能随版本变化，所以下载脚本必须使用多组候选正则，并支持 `OPENCODE_ASSET_URL` 兜底覆盖。

### 4.2 新增下载脚本：`client/scripts/prepare-opencode-binary.cjs`

这个脚本在本地开发和 GitHub Actions 中共用。它会：

1. 读取目标 `platform/arch`。
2. 读取 `OPENCODE_VERSION` 或 `vendor/opencode/VERSION`。
3. 从 OpenCode GitHub Release 找到当前平台资产。
4. 清空 `vendor/opencode` 中旧的 binary，只保留当前平台目录。
5. 解压并复制为固定路径：`vendor/opencode/<platform>-<arch>/opencode(.exe)`。
6. macOS/Linux 自动 `chmod 755`。
7. macOS 自动尝试清理 quarantine xattr。
8. 写入 `manifest.json`。
9. 执行 `opencode --version` 或 `opencode --help` 做最小可执行校验。

```js
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const REPO = 'anomalyco/opencode';
const ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(ROOT, 'vendor', 'opencode');
const VERSION_FILE = path.join(VENDOR_ROOT, 'VERSION');

const ASSET_PATTERNS = {
  'win32-x64': [/opencode-(windows|win32|win)-x64.*\.zip$/i, /opencode.*(windows|win32|win).*x64.*\.zip$/i, /opencode.*(windows|win32|win).*amd64.*\.zip$/i],
  'darwin-arm64': [/^opencode-darwin-arm64\.zip$/i, /opencode.*darwin.*arm64.*\.zip$/i, /opencode.*mac.*arm64.*\.zip$/i],
  'darwin-x64': [/^opencode-darwin-x64\.zip$/i, /opencode.*darwin.*x64.*\.zip$/i, /opencode.*mac.*x64.*\.zip$/i],
};

function readArg(name, fallback = '') {
  const prefix = `${name}=`;
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

function readVersion() {
  const envVersion = String(process.env.OPENCODE_VERSION || '').trim();
  if (envVersion) return envVersion;
  if (fs.existsSync(VERSION_FILE)) return fs.readFileSync(VERSION_FILE, 'utf-8').trim();
  throw new Error('缺少 OpenCode 版本：请设置 OPENCODE_VERSION 或创建 client/vendor/opencode/VERSION');
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'yibiao-opencode-binary-preparer', Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    https.get(url, { headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API 请求失败 ${res.statusCode}: ${body.slice(0, 500)}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const file = fs.createWriteStream(targetPath);
    const request = (currentUrl, redirectCount = 0) => {
      https.get(currentUrl, { headers: { 'User-Agent': 'yibiao-opencode-binary-preparer' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectCount > 5) return reject(new Error('下载 OpenCode binary 重定向过多'));
          request(new URL(res.headers.location, currentUrl).toString(), redirectCount + 1);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`下载 OpenCode binary 失败：HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    };
    file.on('error', reject);
    request(url);
  });
}

function findAsset(release, key) {
  if (process.env.OPENCODE_ASSET_URL) {
    return { name: path.basename(new URL(process.env.OPENCODE_ASSET_URL).pathname), browser_download_url: process.env.OPENCODE_ASSET_URL };
  }
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const patterns = ASSET_PATTERNS[key];
  for (const pattern of patterns || []) {
    const matched = assets.find((asset) => pattern.test(asset.name));
    if (matched) return matched;
  }
  throw new Error(`没有找到 ${key} 对应的 OpenCode release asset。可用资产：\n${assets.map((asset) => asset.name).join('\n')}`);
}

function walkFiles(dir) {
  return fs.readdirSync(dir).flatMap((name) => {
    const filePath = path.join(dir, name);
    return fs.statSync(filePath).isDirectory() ? walkFiles(filePath) : [filePath];
  });
}

function findBinary(extractDir, platform) {
  const files = walkFiles(extractDir);
  const expectedName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  const direct = files.find((file) => path.basename(file).toLowerCase() === expectedName.toLowerCase());
  if (direct) return direct;
  const fallback = files.find((file) => {
    const base = path.basename(file).toLowerCase();
    return platform === 'win32' ? base.includes('opencode') && base.endsWith('.exe') : base.includes('opencode') && !base.includes('.');
  });
  if (fallback) return fallback;
  throw new Error('解压后没有找到 OpenCode 可执行文件');
}

function verifyExecutable(target) {
  try { execFileSync(target, ['--version'], { stdio: 'pipe', timeout: 15000 }); return; } catch {}
  execFileSync(target, ['--help'], { stdio: 'pipe', timeout: 15000 });
}

async function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const key = `${platform}-${arch}`;
  const version = readVersion();
  const binaryName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  if (!ASSET_PATTERNS[key]) throw new Error(`第一版只支持 win32-x64、darwin-x64、darwin-arm64，当前为 ${key}`);

  const release = await requestJson(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(version)}`);
  const asset = findAsset(release, key);
  const tmpRoot = path.join(ROOT, '.tmp-opencode-download', key);
  const zipPath = path.join(tmpRoot, asset.name);
  const extractDir = path.join(tmpRoot, 'extract');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  await downloadFile(asset.browser_download_url, zipPath);
  new AdmZip(zipPath).extractAllTo(extractDir, true);

  fs.rmSync(VENDOR_ROOT, { recursive: true, force: true });
  const targetBinary = path.join(VENDOR_ROOT, key, binaryName);
  fs.mkdirSync(path.dirname(targetBinary), { recursive: true });
  fs.copyFileSync(findBinary(extractDir, platform), targetBinary);
  if (platform !== 'win32') {
    fs.chmodSync(targetBinary, 0o755);
    try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', targetBinary], { stdio: 'ignore' }); } catch {}
  }
  fs.writeFileSync(VERSION_FILE, `${version}\n`, 'utf-8');
  fs.writeFileSync(path.join(VENDOR_ROOT, 'manifest.json'), JSON.stringify({ version, platform, arch, key, asset: asset.name, prepared_at: new Date().toISOString() }, null, 2), 'utf-8');
  verifyExecutable(targetBinary);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`Prepared ${targetBinary}`);
}

main().catch((error) => { console.error(error?.stack || error?.message || String(error)); process.exit(1); });
```

### 4.3 新增校验脚本：`client/scripts/verify-opencode-binary.cjs`

```js
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(ROOT, 'vendor', 'opencode');

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const key = `${platform}-${arch}`;
  const binaryName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  const binaryPath = path.join(VENDOR_ROOT, key, binaryName);
  if (!fs.existsSync(binaryPath)) throw new Error(`缺少 OpenCode binary：${binaryPath}`);
  if (platform !== 'win32') fs.accessSync(binaryPath, fs.constants.X_OK);
  const platformDirs = fs.readdirSync(VENDOR_ROOT, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name);
  if (platformDirs.length !== 1 || platformDirs[0] !== key) throw new Error(`本次构建只能包含 ${key}，实际包含：${platformDirs.join(', ') || '(empty)'}`);
  try { execFileSync(binaryPath, ['--version'], { stdio: 'pipe', timeout: 15000 }); } catch { execFileSync(binaryPath, ['--help'], { stdio: 'pipe', timeout: 15000 }); }
  console.log(`OpenCode binary verified: ${binaryPath}`);
}

try { main(); } catch (error) { console.error(error?.stack || error?.message || String(error)); process.exit(1); }
```

### 4.4 新增打包产物校验脚本：`client/scripts/verify-packaged-opencode-binary.cjs`

```js
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function walkDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((name) => {
    const filePath = path.join(root, name);
    if (!fs.statSync(filePath).isDirectory()) return [];
    return [filePath, ...walkDirs(filePath)];
  });
}

function findResourceRoot(releaseDir, platform) {
  if (platform === 'darwin') {
    const appDir = walkDirs(releaseDir).find((dir) => dir.endsWith('.app'));
    if (!appDir) throw new Error(`没有找到 macOS .app：${releaseDir}`);
    return path.join(appDir, 'Contents', 'Resources');
  }
  if (platform === 'win32') {
    const unpackedDir = walkDirs(releaseDir).find((dir) => path.basename(dir).toLowerCase() === 'win-unpacked');
    if (!unpackedDir) throw new Error(`没有找到 win-unpacked：${releaseDir}`);
    return path.join(unpackedDir, 'resources');
  }
  throw new Error(`暂不支持校验平台：${platform}`);
}

function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', process.arch);
  const releaseDir = path.resolve(readArg('--release', 'release'));
  const key = `${platform}-${arch}`;
  const binaryName = platform === 'win32' ? 'opencode.exe' : 'opencode';
  const binaryPath = path.join(findResourceRoot(releaseDir, platform), 'opencode', key, binaryName);
  if (!fs.existsSync(binaryPath)) throw new Error(`打包产物缺少 OpenCode binary：${binaryPath}`);
  if (platform !== 'win32') fs.accessSync(binaryPath, fs.constants.X_OK);
  try { execFileSync(binaryPath, ['--version'], { stdio: 'pipe', timeout: 15000 }); } catch { execFileSync(binaryPath, ['--help'], { stdio: 'pipe', timeout: 15000 }); }
  console.log(`Packaged OpenCode binary verified: ${binaryPath}`);
}

try { main(); } catch (error) { console.error(error?.stack || error?.message || String(error)); process.exit(1); }
```

### 4.5 修改 `client/package.json`

在 `build` 中增加 `extraResources`，保证 binary 不被打进 asar，便于执行：

```json
{
  "build": {
    "asar": true,
    "extraResources": [
      {
        "from": "vendor/opencode",
        "to": "opencode",
        "filter": ["**/*"]
      }
    ]
  }
}
```

保留原有 `files` 配置即可。因为 GitHub Actions 会先清空再只生成当前平台目录，所以最终安装包只会包含当前平台的 OpenCode binary。

### 4.6 修改 GitHub Actions：按系统只注入对应 OpenCode binary

当前 release workflow 已经拆成 `build-windows` 和 `build-macos`，macOS 还按 `x64/arm64` matrix 分开构建。保持这个结构，只在每个构建 job 里新增 OpenCode 准备和校验步骤。

建议在 workflow 顶层增加：

```yaml
env:
  OPENCODE_VERSION: ${{ vars.OPENCODE_VERSION || 'v1.17.8' }}
```

在 `build-windows` 的 `Install dependencies` 之后，`Rebuild Electron native dependencies` 之前新增：

```yaml
      - name: Prepare OpenCode binary
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENCODE_VERSION: ${{ env.OPENCODE_VERSION }}
        run: node scripts/prepare-opencode-binary.cjs --platform win32 --arch x64

      - name: Verify OpenCode binary
        run: node scripts/verify-opencode-binary.cjs --platform win32 --arch x64
```

在 Windows artifacts 构建完成后、上传 release assets 前新增：

```yaml
      - name: Verify packaged OpenCode binary
        run: node scripts/verify-packaged-opencode-binary.cjs --platform win32 --arch x64 --release release
```

在 `build-macos` 的 `Install dependencies` 之后，`Rebuild Electron native dependencies` 之前新增：

```yaml
      - name: Prepare OpenCode binary
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENCODE_VERSION: ${{ env.OPENCODE_VERSION }}
        run: node scripts/prepare-opencode-binary.cjs --platform darwin --arch ${{ matrix.arch }}

      - name: Verify OpenCode binary
        run: node scripts/verify-opencode-binary.cjs --platform darwin --arch ${{ matrix.arch }}
```

在现有 `Verify packaged native architectures` 之后新增：

```yaml
      - name: Verify packaged OpenCode binary
        run: node scripts/verify-packaged-opencode-binary.cjs --platform darwin --arch ${{ matrix.arch }} --release release
```

最终结果：

```text
Windows 安装包：只包含 resources/opencode/win32-x64/opencode.exe
macOS x64 安装包：只包含 Contents/Resources/opencode/darwin-x64/opencode
macOS arm64 安装包：只包含 Contents/Resources/opencode/darwin-arm64/opencode
```

### 4.7 macOS 第一版必须完成的兼容工作

macOS 第一版不是“后续补齐”，而是必须和 Windows 同时可用。需要完成以下工作：

1. GitHub Actions 的 `build-macos` matrix 必须继续保留 `x64` 和 `arm64` 两个构建。
2. `prepare-opencode-binary.cjs` 必须在 macOS x64 job 下载 `darwin-x64`，在 macOS arm64 job 下载 `darwin-arm64`。
3. 脚本必须对 `opencode` 执行 `chmod 755`。
4. 脚本必须尽量清理 `com.apple.quarantine` xattr。
5. `verify-packaged-opencode-binary.cjs` 必须在 `.app/Contents/Resources/opencode/.../opencode` 上校验可执行权限。
6. `opencodeServerRunner.cjs` 的 `ensureExecutable()` 保留运行时 `chmodSync(0o755)` 兜底。
7. DMG 里的 `macOS使用说明.txt` 必须明确写出未签名版本的安装命令。

修改：`client/assets/macos-dmg/macOS使用说明.txt`

建议加入这段：

```text
macOS 未签名版本安装说明

1. 打开 DMG，将“易标投标工具箱.app”拖入“应用程序”。
2. 打开终端，执行下面命令解除 macOS quarantine：

   xattr -dr com.apple.quarantine "/Applications/易标投标工具箱.app"

3. 再从“应用程序”中打开“易标投标工具箱”。

说明：
- 这个命令会递归处理整个 .app，包括内置的 OpenCode Agent 可执行文件。
- 正常情况下不需要手动 chmod，程序包已经在构建阶段设置好可执行权限。
- 如果开启开发者模式后运行 OpenCode Agent 测试页，提示 spawn EACCES，再执行下面命令排查：

  chmod +x "/Applications/易标投标工具箱.app/Contents/Resources/opencode/darwin-arm64/opencode"
  chmod +x "/Applications/易标投标工具箱.app/Contents/Resources/opencode/darwin-x64/opencode"

  Apple Silicon 机器通常使用 darwin-arm64；Intel 机器通常使用 darwin-x64。
```

注意：`chmod +x` 是异常排查命令，不应作为默认安装步骤。默认安装步骤只有拖入应用程序和执行 `xattr -dr com.apple.quarantine ...`。可执行权限必须由构建脚本和打包校验保证。

### 4.8 本地开发调试方式

Windows：

```powershell
cd client
$env:OPENCODE_VERSION="v1.17.8"
npm ci
node scripts/prepare-opencode-binary.cjs --platform win32 --arch x64
node scripts/verify-opencode-binary.cjs --platform win32 --arch x64
npm run dev
```

macOS Apple Silicon：

```bash
cd client
export OPENCODE_VERSION="v1.17.8"
npm ci
node scripts/prepare-opencode-binary.cjs --platform darwin --arch arm64
node scripts/verify-opencode-binary.cjs --platform darwin --arch arm64
npm run dev
```

macOS Intel：

```bash
cd client
export OPENCODE_VERSION="v1.17.8"
npm ci
node scripts/prepare-opencode-binary.cjs --platform darwin --arch x64
node scripts/verify-opencode-binary.cjs --platform darwin --arch x64
npm run dev
```

开发阶段仍然可以通过环境变量指定已有 binary：

```bash
YIBIAO_OPENCODE_BIN=/absolute/path/to/opencode npm run dev
```

## 5. 第二步：扩展路径工具

修改：`client/electron/utils/paths.cjs`

新增这些函数：

```js
function getAgentRuntimeDir(app) {
  return path.join(getUserDataPath(app), 'agent-runtime');
}

function getAgentCacheDir(app) {
  return path.join(getUserDataPath(app), 'agent-cache');
}

function getPlatformArchKey() {
  return `${process.platform}-${process.arch}`;
}

function getBundledOpencodeBinaryPath(app) {
  if (process.env.YIBIAO_OPENCODE_BIN) {
    return process.env.YIBIAO_OPENCODE_BIN;
  }

  const binaryName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const platformArch = getPlatformArchKey();

  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'opencode', platformArch, binaryName);
  }

  return path.join(__dirname, '..', '..', 'vendor', 'opencode', platformArch, binaryName);
}
```

然后在 `module.exports` 里加入：

```js
module.exports = {
  // existing exports...
  getAgentRuntimeDir,
  getAgentCacheDir,
  getBundledOpencodeBinaryPath,
};
```

注意：这里的 `__dirname` 当前位于 `client/electron/utils`，所以 `../../vendor` 对应 `client/vendor`。

macOS 上 `process.arch` 与当前 App 架构一致：Intel 版走 `darwin-x64`，Apple Silicon 版走 `darwin-arm64`。如果 Apple Silicon 用户运行的是 x64 版 App，则会按 Rosetta 运行并使用 `darwin-x64`，这与打包产物保持一致。

---

## 6. 第三步：抽出共享 token 统计，并新增 OpenCode 专用 AI proxy 适配层

目标：OpenCode 的请求进入本地 proxy 后，不复用现有 `aiService.chat()` / `fetchChatCompletion()` 请求出口，而是在 `aiServiceOpenAiProxy.cjs` 内部实现一套适配 OpenCode 的 OpenAI-compatible 请求链路。

同时，按正式方案把现有 token 统计抽成共享模块：

```text
现有 aiService 文本请求
  ↓
textTokenStatsStore
  ↑
OpenCode AI proxy 文本请求
```

这样开发者模式下现有 Token 统计小窗仍然看到统一的文本模型请求统计，而不是 OpenCode 另起一套不可见统计。

本节只做共享 token 统计，不额外改造现有 analytics 上报。OpenCode proxy 会在 `logs/opencode-ai-proxy/*.jsonl` 中记录模型服务商、模型名称、endpoint host、usage 和耗时，后续如需进入线上 analytics，再单独抽共享 analytics 模块。

### 6.1 新增共享 token 统计模块

新建文件：`client/electron/services/textTokenStatsStore.cjs`

```js
function normalizeTokenNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function normalizeCachedTokenNumber(source) {
  const promptDetails = source.prompt_tokens_details
    || source.promptTokensDetails
    || source.input_token_details
    || source.inputTokenDetails
    || {};

  return normalizeTokenNumber(
    source.cached_tokens
    ?? source.cachedTokens
    ?? source.prompt_cached_tokens
    ?? source.promptCachedTokens
    ?? source.prompt_cache_hit_tokens
    ?? source.promptCacheHitTokens
    ?? source.cache_read_input_tokens
    ?? source.cacheReadInputTokens
    ?? source.cached_content_token_count
    ?? source.cachedContentTokenCount
    ?? promptDetails.cached_tokens
    ?? promptDetails.cachedTokens
    ?? promptDetails.cache_read
    ?? promptDetails.cacheRead
    ?? promptDetails.cache_read_input_tokens
    ?? promptDetails.cacheReadInputTokens,
  );
}

function normalizeTokenUsage(usage) {
  const source = usage || {};
  const promptTokens = normalizeTokenNumber(source.prompt_tokens ?? source.promptTokens ?? source.promptTokenCount);
  const completionTokens = normalizeTokenNumber(
    source.completion_tokens
    ?? source.completionTokens
    ?? source.completionTokenCount
    ?? source.candidatesTokenCount,
  );
  const totalTokens = normalizeTokenNumber(source.total_tokens ?? source.totalTokens ?? source.totalTokenCount)
    || promptTokens + completionTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cached_tokens: normalizeCachedTokenNumber(source),
  };
}

function createEmptyTextTokenStats() {
  return {
    request_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cached_tokens: 0,
  };
}

let textTokenStats = createEmptyTextTokenStats();
const textTokenStatsListeners = new Set();

function getTextTokenStatsSnapshot() {
  const inputTokens = normalizeTokenNumber(textTokenStats.input_tokens);
  const cachedTokens = normalizeTokenNumber(textTokenStats.cached_tokens);
  return {
    request_count: normalizeTokenNumber(textTokenStats.request_count),
    input_tokens: inputTokens,
    output_tokens: normalizeTokenNumber(textTokenStats.output_tokens),
    total_tokens: normalizeTokenNumber(textTokenStats.total_tokens),
    cached_tokens: cachedTokens,
    cache_ratio: inputTokens > 0 ? cachedTokens / inputTokens : 0,
  };
}

function emitTextTokenStatsChanged() {
  const snapshot = getTextTokenStatsSnapshot();
  textTokenStatsListeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch {
      // 统计展示不能影响 AI 主流程。
    }
  });
}

function recordTextTokenStats(usage) {
  const tokenUsage = normalizeTokenUsage(usage);
  textTokenStats = {
    request_count: textTokenStats.request_count + 1,
    input_tokens: textTokenStats.input_tokens + tokenUsage.prompt_tokens,
    output_tokens: textTokenStats.output_tokens + tokenUsage.completion_tokens,
    total_tokens: textTokenStats.total_tokens + tokenUsage.total_tokens,
    cached_tokens: textTokenStats.cached_tokens + tokenUsage.cached_tokens,
  };
  emitTextTokenStatsChanged();
}

function resetTextTokenStats() {
  textTokenStats = createEmptyTextTokenStats();
  emitTextTokenStatsChanged();
  return getTextTokenStatsSnapshot();
}

function onTextTokenStatsChanged(listener) {
  if (typeof listener !== 'function') {
    return () => undefined;
  }

  textTokenStatsListeners.add(listener);
  return () => textTokenStatsListeners.delete(listener);
}

module.exports = {
  normalizeTokenNumber,
  normalizeTokenUsage,
  recordTextTokenStats,
  resetTextTokenStats,
  onTextTokenStatsChanged,
  getTextTokenStatsSnapshot,
};
```

### 6.2 修改现有 `aiService.cjs` 接入共享统计

修改：`client/electron/services/aiService.cjs`

顶部新增：

```js
const textTokenStatsStore = require('./textTokenStatsStore.cjs');
```

保留现有 `normalizeTokenNumber()`、`normalizeTokenUsage()` 等 helper，因为 `extractOpenAIUsage()`、`extractGoogleUsage()`、`trackAiRequest()` 仍在使用它们。

把原文件中这段私有状态替换掉：

```js
let textTokenStats = createEmptyTextTokenStats();
const textTokenStatsListeners = new Set();

function getTextTokenStatsSnapshot() { ... }
function emitTextTokenStatsChanged() { ... }
function recordTextTokenStats(config, usage) { ... }
function resetTextTokenStats() { ... }
function onTextTokenStatsChanged(listener) { ... }
```

替换为共享 store 包装函数：

```js
function getTextTokenStatsSnapshot() {
  return textTokenStatsStore.getTextTokenStatsSnapshot();
}

function recordTextTokenStats(config, usage) {
  if (!config?.developer_mode) {
    return;
  }
  textTokenStatsStore.recordTextTokenStats(usage);
}

function resetTextTokenStats() {
  return textTokenStatsStore.resetTextTokenStats();
}

function onTextTokenStatsChanged(listener) {
  return textTokenStatsStore.onTextTokenStatsChanged(listener);
}
```

这样 `aiService` 原有调用点不用改：

```js
recordTextTokenStats(config, result.usage);
recordTextTokenStats(config, null);
```

开发者 Token 统计窗口也不用改，因为 `aiService.getTextTokenStats()`、`resetTextTokenStats()`、`onTextTokenStatsChanged()` 的外部接口不变。

### 6.3 OpenCode proxy 适配层要求

新增文件：`client/electron/services/opencode/aiServiceOpenAiProxy.cjs`

这套链路仍然必须保留现有 `aiService` 已具备的关键能力：

- 读取 `configStore.load()` 中的真实 `api_key/base_url/model_name/context_length_limit/concurrency_limit`。
- 请求进入文本模型并发队列，默认并发与文本模型配置保持一致。
- 识别 `429`、`rate limit`、`too many requests`，单请求最多重试 3 次。
- 开发者模式下写入 `userData/logs/opencode-ai-proxy/*.jsonl`，记录阶段、耗时、状态码、usage、hash 和错误摘要，不写 API Key、Base URL、Prompt 全文、AI 响应全文。
- 开发者模式下写入共享 `textTokenStatsStore`，非流式 JSON 和 SSE usage 都会统计；如果服务商未返回 usage，也至少累计一次请求数。

不修改：`client/electron/services/aiService.cjs` 的请求出口。OpenCode proxy 有自己的上游请求实现，只共享配置和 token 统计。

## 7. 第四步：新增 OpenCode 专用 OpenAI-compatible 本地代理

新建文件：`client/electron/services/opencode/aiServiceOpenAiProxy.cjs`

```js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAiRequestQueue } = require('../../utils/aiRequestQueue.cjs');
const { getDeveloperLogsDir } = require('../../utils/paths.cjs');
const {
  normalizeTokenUsage,
  recordTextTokenStats,
} = require('../textTokenStatsStore.cjs');

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 300000;
const RATE_LIMIT_MAX_RETRIES = 3;

function createProxyToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function trimBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function normalizeEndpointHost(baseUrl) {
  const rawValue = String(baseUrl || '').trim();
  if (!rawValue) return '';
  const candidates = rawValue.includes('://') ? [rawValue] : [`https://${rawValue}`];

  for (const candidate of candidates) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {}
  }

  return '';
}

function assertTextModelConfig(config) {
  if (!config?.api_key) {
    throw new Error('请先在设置中配置文本模型 API Key');
  }
  if (!config?.model_name) {
    throw new Error('请先在设置中配置文本模型名称');
  }
  if (!trimBaseUrl(config?.base_url)) {
    throw new Error('请先在设置中配置文本模型 Base URL');
  }
}

function createRequestId() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeErrorMessage(error) {
  return String(error?.message || error || 'OpenCode AI proxy failed').slice(0, 1000);
}

function createPromptHash(body) {
  return hashText(JSON.stringify({
    model: body?.model || '',
    messages: Array.isArray(body?.messages)
      ? body.messages.map((item) => ({ role: item?.role || '', content_hash: hashText(item?.content || '') }))
      : [],
    tools_count: Array.isArray(body?.tools) ? body.tools.length : 0,
    stream: Boolean(body?.stream),
  }));
}

function appendProxyDeveloperLog(app, config, payload) {
  if (!config?.developer_mode) return;

  try {
    const logDir = getDeveloperLogsDir(app, 'opencode-ai-proxy');
    fs.mkdirSync(logDir, { recursive: true });
    const fileName = `${new Date().toISOString().slice(0, 10)}.jsonl`;
    fs.appendFileSync(
      path.join(logDir, fileName),
      `${JSON.stringify({
        created_at: new Date().toISOString(),
        ...payload,
      })}\n`,
      'utf-8',
    );
  } catch {
    // 开发日志不能影响主流程。
  }
}

function recordProxyTextTokenStats(config, usage) {
  if (!config?.developer_mode) return;

  try {
    recordTextTokenStats(usage);
  } catch {
    // Token 统计不能影响主流程。
  }
}

function createOpenCodeProxyModelInfo() {
  return {
    id: 'default',
    object: 'model',
    created: 0,
    owned_by: 'yibiao',
  };
}

function normalizeOpenCodeProxyRequestBody(config, sourceBody) {
  const source = sourceBody && typeof sourceBody === 'object' ? sourceBody : {};
  const messages = Array.isArray(source.messages) ? source.messages : [];

  if (!messages.length) {
    throw new Error('OpenCode 代理请求缺少 messages');
  }

  return {
    ...source,
    // OpenCode 侧只使用 yibiao/default；真实模型名称以设置页保存的 model_name 为准。
    model: config.model_name,
    messages,
  };
}

function isAuthorized(req, token) {
  const value = String(req.headers.authorization || '').trim();
  return value === `Bearer ${token}`;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readRequestBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readRequestBody(req);
  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch (error) {
    const wrapped = new Error(`JSON 请求体解析失败：${error.message}`);
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

function createAbortError() {
  const error = new Error('AI 请求超时');
  error.name = 'AbortError';
  return error;
}

function createTimeoutSignal(parentSignal, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(createAbortError()), timeoutMs);

  const abortFromParent = () => controller.abort(parentSignal?.reason || new Error('请求已取消'));
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer);
      if (parentSignal) {
        try { parentSignal.removeEventListener('abort', abortFromParent); } catch {}
      }
    },
  };
}

async function createUpstreamError(response) {
  const rawText = await response.text().catch(() => '');
  let detail = '';

  try {
    const body = rawText ? JSON.parse(rawText) : null;
    detail = body?.error?.message || body?.message || '';
  } catch {
    detail = rawText;
  }

  const error = new Error(detail || `AI 请求失败：HTTP ${response.status}`);
  error.status = response.status;
  error.statusCode = response.status;
  error.raw_response_body = rawText.slice(0, 4000);
  return error;
}

function isRateLimitError(error) {
  if (error?.status === 429 || error?.statusCode === 429) return true;

  const message = String(error?.message || '').toLowerCase();
  return message.includes('429')
    || message.includes('rate limit')
    || message.includes('too many requests')
    || message.includes('rate_limit');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryRateLimitedRequest(runner, options = {}) {
  const maxRetries = options.maxRetries ?? RATE_LIMIT_MAX_RETRIES;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await runner({ attempt });
    } catch (error) {
      lastError = error;

      if (error?.name === 'AbortError' || !isRateLimitError(error) || attempt >= maxRetries) {
        throw error;
      }

      await sleep(800 * Math.pow(2, attempt));
    }
  }

  throw lastError || new Error('AI 请求失败');
}

function responseHeadersFromUpstream(response, fallbackContentType) {
  const headers = new Headers();
  const contentType = response.headers.get('content-type') || fallbackContentType;
  if (contentType) headers.set('content-type', contentType);

  const cacheControl = response.headers.get('cache-control');
  if (cacheControl) headers.set('cache-control', cacheControl);

  const requestId = response.headers.get('x-request-id');
  if (requestId) headers.set('x-request-id', requestId);

  return headers;
}

function extractUsageFromPayload(payload) {
  return payload?.usage || payload?.usageMetadata || payload?.usage_metadata || null;
}

function extractUsageFromJsonText(rawText) {
  try {
    const data = rawText ? JSON.parse(rawText) : null;
    return extractUsageFromPayload(data);
  } catch {
    return null;
  }
}

function createSseUsageCollector() {
  let buffer = '';
  let usage = null;

  function processLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('data:')) return;

    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;

    try {
      const payload = JSON.parse(data);
      const nextUsage = extractUsageFromPayload(payload);
      if (nextUsage) usage = nextUsage;
    } catch {
      // 单行解析失败不影响流式转发。
    }
  }

  return {
    push(text) {
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach(processLine);
    },
    flush() {
      if (buffer.trim()) {
        buffer.split(/\r?\n/).forEach(processLine);
      }
      buffer = '';
      return usage;
    },
  };
}

function createUsageCapturingStream(source, onDone) {
  if (!source?.getReader) return source;

  const reader = source.getReader();
  const decoder = new TextDecoder('utf-8');
  const collector = createSseUsageCollector();

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        collector.push(decoder.decode());
        await Promise.resolve(onDone(collector.flush()));
        controller.close();
        return;
      }

      if (value) {
        collector.push(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch {}
    },
  });
}

function recordOpenCodeAiSuccess({ app, config, requestId, requestBody, response, usage, startedAt, stream, attempt }) {
  const normalizedUsage = normalizeTokenUsage(usage);
  recordProxyTextTokenStats(config, usage);

  appendProxyDeveloperLog(app, config, {
    request_id: requestId,
    type: 'chat',
    stream: Boolean(stream),
    attempt,
    duration_ms: Date.now() - startedAt,
    status: response.status,
    provider: config.text_model_provider || '',
    model_name: config.model_name || '',
    endpoint_host: normalizeEndpointHost(config.base_url),
    request_hash: createPromptHash(requestBody),
    messages_count: Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
    usage: normalizedUsage,
  });
}

function recordOpenCodeAiFailure({ app, config, requestId, requestBody, error, startedAt, attempt }) {
  recordProxyTextTokenStats(config, null);

  appendProxyDeveloperLog(app, config, {
    request_id: requestId,
    type: 'chat-error',
    attempt,
    duration_ms: Date.now() - startedAt,
    status: error?.status || error?.statusCode || 0,
    provider: config.text_model_provider || '',
    model_name: config.model_name || '',
    endpoint_host: normalizeEndpointHost(config.base_url),
    request_hash: createPromptHash(requestBody),
    messages_count: Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
    error: safeErrorMessage(error),
  });
}

async function prepareProxyResponse({ app, config, requestId, requestBody, response, startedAt, attempt }) {
  const stream = Boolean(requestBody.stream);
  const contentType = response.headers.get('content-type') || '';
  const isSse = stream || contentType.toLowerCase().includes('text/event-stream');

  if (isSse) {
    const body = createUsageCapturingStream(response.body, (usage) => {
      recordOpenCodeAiSuccess({
        app,
        config,
        requestId,
        requestBody,
        response,
        usage,
        startedAt,
        stream: true,
        attempt,
      });
    });

    return new Response(body, {
      status: response.status,
      headers: responseHeadersFromUpstream(response, 'text/event-stream; charset=utf-8'),
    });
  }

  const rawText = await response.text();
  const usage = extractUsageFromJsonText(rawText);
  recordOpenCodeAiSuccess({
    app,
    config,
    requestId,
    requestBody,
    response,
    usage,
    startedAt,
    stream: false,
    attempt,
  });

  return new Response(rawText, {
    status: response.status,
    headers: responseHeadersFromUpstream(response, 'application/json; charset=utf-8'),
  });
}

async function requestOpenCodeChatCompletion({ app, configStore, textQueue, openAiBody, signal }) {
  return textQueue.enqueue(async () => {
    const config = configStore.load();
    assertTextModelConfig(config);

    const requestBody = normalizeOpenCodeProxyRequestBody(config, openAiBody);
    const requestId = createRequestId();

    return retryRateLimitedRequest(async ({ attempt }) => {
      const timeout = createTimeoutSignal(signal, UPSTREAM_TIMEOUT_MS);
      const startedAt = Date.now();

      try {
        appendProxyDeveloperLog(app, config, {
          request_id: requestId,
          type: 'chat-pending',
          stream: Boolean(requestBody.stream),
          attempt,
          provider: config.text_model_provider || '',
          model_name: config.model_name || '',
          endpoint_host: normalizeEndpointHost(config.base_url),
          request_hash: createPromptHash(requestBody),
          messages_count: Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
        });

        const response = await fetch(`${trimBaseUrl(config.base_url)}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.api_key}`,
          },
          body: JSON.stringify(requestBody),
          signal: timeout.signal,
        });

        if (!response.ok) {
          throw await createUpstreamError(response);
        }

        return prepareProxyResponse({
          app,
          config,
          requestId,
          requestBody,
          response,
          startedAt,
          attempt,
        });
      } catch (error) {
        recordOpenCodeAiFailure({
          app,
          config,
          requestId,
          requestBody,
          error,
          startedAt,
          attempt,
        });
        throw error;
      } finally {
        timeout.clear();
      }
    });
  });
}

function copyUpstreamHeaders(upstream, res) {
  const passHeaders = [
    'content-type',
    'cache-control',
    'x-request-id',
  ];

  for (const name of passHeaders) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

async function pipeWebStreamToNode(webStream, res) {
  if (!webStream?.getReader) {
    res.end();
    return;
  }

  const reader = webStream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
    res.end();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function bindAbortToRequestLifecycle({ req, res, controller }) {
  req.on('aborted', () => controller.abort(new Error('客户端请求已中止')));
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort(new Error('客户端连接已关闭'));
    }
  });
}

async function handleChatCompletions({ req, res, app, configStore, textQueue }) {
  const controller = new AbortController();
  bindAbortToRequestLifecycle({ req, res, controller });

  const requestBody = await readJson(req);
  const upstream = await requestOpenCodeChatCompletion({
    app,
    configStore,
    textQueue,
    openAiBody: requestBody,
    signal: controller.signal,
  });

  res.statusCode = upstream.status;
  copyUpstreamHeaders(upstream, res);

  if (!res.getHeader('Content-Type')) {
    res.setHeader('Content-Type', requestBody.stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8');
  }

  await pipeWebStreamToNode(upstream.body, res);
}

function handleModels({ res }) {
  sendJson(res, 200, {
    object: 'list',
    data: [createOpenCodeProxyModelInfo()],
  });
}

function createAiServiceOpenAiProxy({ app, configStore }) {
  const token = createProxyToken();
  const textQueue = createAiRequestQueue({
    defaultLimit: 10,
    getLimit() {
      return configStore.load()?.concurrency_limit;
    },
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!isAuthorized(req, token)) {
        sendJson(res, 401, {
          error: {
            message: 'Unauthorized',
            type: 'unauthorized',
          },
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/v1/models') {
        handleModels({ res });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        await handleChatCompletions({ req, res, app, configStore, textQueue });
        return;
      }

      sendJson(res, 404, {
        error: {
          message: `Not found: ${req.method} ${url.pathname}`,
          type: 'not_found',
        },
      });
    } catch (error) {
      const statusCode = error.statusCode || error.status || 500;
      if (!res.headersSent) {
        sendJson(res, statusCode, {
          error: {
            message: error.message || 'OpenCode AI proxy failed',
            type: 'proxy_error',
          },
        });
      } else {
        try { res.end(); } catch {}
      }
    }
  });

  server.headersTimeout = 310000;
  server.requestTimeout = 310000;

  return {
    token,
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });

      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('OpenCode AI proxy 启动失败：无法获取监听端口');
      }

      return {
        token,
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
      };
    },
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = {
  createAiServiceOpenAiProxy,
};
```

这一版已经补齐：

```text
1. assertTextModelConfig
2. retryRateLimitedRequest
3. createUpstreamError
4. prepareProxyResponse
5. 流式 SSE 边转发边解析 usage
6. 非流式 JSON usage 解析
7. 共享 token 统计写入
8. 开发者 JSONL 日志
```

## 8. 第五步：生成临时 OpenCode 配置

新建文件：`client/electron/services/opencode/opencodeConfigFactory.cjs`

```js
const fs = require('node:fs');
const path = require('node:path');

const DISABLED_BUILTIN_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'google',
  'openrouter',
  'github-copilot',
  'amazon-bedrock',
  'azure',
  'deepseek',
  'xai',
];

function normalizeContextLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 400000;
}

function buildOpenCodeConfig({ proxyBaseUrl, contextLengthLimit }) {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    model: 'yibiao/default',
    small_model: 'yibiao/default',
    enabled_providers: ['yibiao'],
    disabled_providers: DISABLED_BUILTIN_PROVIDERS,
    provider: {
      yibiao: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Yibiao AI',
        options: {
          baseURL: `${proxyBaseUrl}/v1`,
          apiKey: '{env:YIBIAO_OPENCODE_PROXY_TOKEN}',
          timeout: 300000,
        },
        models: {
          default: {
            name: 'Yibiao Current Text Model',
            limit: {
              context: normalizeContextLimit(contextLengthLimit),
              output: 16384,
            },
          },
        },
      },
    },
    permission: {
      read: {
        '*': 'allow',
        '*.env': 'deny',
        '*.env.*': 'deny',
        '*.env.example': 'allow',
      },
      grep: 'allow',
      glob: 'allow',
      edit: 'allow',
      webfetch: 'deny',
      websearch: 'deny',
      external_directory: 'deny',
      question: 'deny',
      doom_loop: 'deny',
      bash: {
        '*': 'deny',
        'git status*': 'allow',
        'git diff*': 'allow',
        'git ls-files*': 'allow',
        'ls *': 'allow',
        'dir *': 'allow',
        'find *': 'allow',
        'grep *': 'allow',
        'rg *': 'allow',
        'cat *': 'allow',
        'type *': 'allow',
      },
    },
    formatter: false,
    lsp: false,
    mcp: {},
    instructions: [],
    watcher: {
      ignore: [
        'node_modules/**',
        'dist/**',
        'release/**',
        '.git/**',
      ],
    },
  };
}

function writeOpenCodeConfig(configPath, input) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = buildOpenCodeConfig(input);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return config;
}

module.exports = {
  buildOpenCodeConfig,
  writeOpenCodeConfig,
};
```

说明：

- `enabled_providers: ['yibiao']` 确保只启用你们这个 provider。
- `apiKey` 是 `{env:YIBIAO_OPENCODE_PROXY_TOKEN}`，不是用户真实 AI Key。
- `baseURL` 指向本地 OpenCode AI proxy。
- `external_directory: 'deny'` 配合 `cwd=任务 workspace`，防止 OpenCode 读写 workspace 外文件。
- Headless 场景不要大量使用 `ask`，否则没有 TUI 处理确认。第一版推荐 `allow/deny` 明确化。

---

## 9. 第六步：隔离启动 OpenCode Server

新建文件：`client/electron/services/opencode/opencodeServerRunner.cjs`

```js
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  getAgentRuntimeDir,
  getAgentCacheDir,
  getBundledOpencodeBinaryPath,
} = require('../../utils/paths.cjs');
const { createAiServiceOpenAiProxy } = require('./aiServiceOpenAiProxy.cjs');
const { writeOpenCodeConfig } = require('./opencodeConfigFactory.cjs');

function randomId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

function createBasicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function ensureExecutable(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`OpenCode binary 不存在：${filePath}`);
  }

  if (process.platform !== 'win32') {
    try { fs.chmodSync(filePath, 0o755); } catch {}
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === 'string') {
          reject(new Error('无法分配本地端口'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}

function buildMinimalChildEnv(extra) {
  const keepKeys = [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'ComSpec',
  ];

  const env = {};
  keepKeys.forEach((key) => {
    if (process.env[key]) env[key] = process.env[key];
  });

  return { ...env, ...extra };
}

function createStderrBuffer(limit = 20000) {
  let value = '';

  return {
    push(chunk) {
      value += String(chunk || '');
      if (value.length > limit) {
        value = value.slice(-limit);
      }
    },
    tail(size = 4000) {
      return value.slice(-size);
    },
  };
}

async function waitForOpenCodeHealth({ baseUrl, authHeader, stderrBuffer, timeoutMs = 30000 }) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        headers: { Authorization: authHeader },
      });
      if (response.ok) return true;
      lastError = new Error(`health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const stderrTail = stderrBuffer?.tail?.(4000) || '';
  throw new Error(`OpenCode Server 启动超时：${lastError?.message || 'unknown error'}${stderrTail ? `\nstderr:\n${stderrTail}` : ''}`);
}

function killChild(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve();
    }, 2000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try { child.kill('SIGTERM'); } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function closeAiProxy(aiProxy) {
  if (!aiProxy) return;
  try { await aiProxy.close(); } catch {}
}

async function cleanupRuntime(runtimeRoot, keepRuntime) {
  if (keepRuntime || !runtimeRoot) return;
  try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch {}
}

async function startIsolatedOpenCodeServer({
  app,
  configStore,
  workspaceDir,
  taskId = randomId('agent'),
  keepRuntime = false,
}) {
  const opencodeBin = getBundledOpencodeBinaryPath(app);
  ensureExecutable(opencodeBin);

  fs.mkdirSync(workspaceDir, { recursive: true });

  const runtimeRoot = path.join(getAgentRuntimeDir(app), taskId);
  const tempHome = path.join(runtimeRoot, 'home');
  const configDir = path.join(tempHome, '.config', 'opencode');
  const dataHome = path.join(tempHome, '.local', 'share');
  const cacheHome = path.join(getAgentCacheDir(app), 'opencode-cache');
  const opencodeConfigPath = path.join(configDir, 'opencode.json');

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
  fs.mkdirSync(cacheHome, { recursive: true });

  let aiProxy = null;
  let child = null;
  const stderrBuffer = createStderrBuffer();

  try {
    aiProxy = createAiServiceOpenAiProxy({ app, configStore });
    const aiProxyInfo = await aiProxy.start();

    const currentConfig = configStore.load();
    const opencodeConfig = writeOpenCodeConfig(opencodeConfigPath, {
      proxyBaseUrl: aiProxyInfo.baseUrl,
      contextLengthLimit: currentConfig.context_length_limit,
    });

    const port = await findFreePort();
    const username = 'yibiao';
    const password = crypto.randomBytes(24).toString('base64url');
    const baseUrl = `http://127.0.0.1:${port}`;
    const authHeader = createBasicAuth(username, password);

    const env = buildMinimalChildEnv({
      HOME: tempHome,
      USERPROFILE: tempHome,
      XDG_CONFIG_HOME: path.join(tempHome, '.config'),
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      OPENCODE_CONFIG: opencodeConfigPath,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
      OPENCODE_PERMISSION: JSON.stringify(opencodeConfig.permission),
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      YIBIAO_OPENCODE_PROXY_TOKEN: aiProxyInfo.token,
    });

    child = spawn(opencodeBin, [
      'serve',
      '--pure',
      '--hostname', '127.0.0.1',
      '--port', String(port),
    ], {
      cwd: workspaceDir,
      env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    child.stderr.on('data', (chunk) => stderrBuffer.push(chunk));

    child.once('error', (error) => {
      stderrBuffer.push(`\n[spawn error] ${error?.message || String(error)}\n`);
    });

    child.once('exit', (code) => {
      if (code !== 0) {
        console.warn('[opencode] server exited', {
          code,
          stderr: stderrBuffer.tail(4000),
        });
      }
    });

    await waitForOpenCodeHealth({ baseUrl, authHeader, stderrBuffer, timeoutMs: 30000 });

    return {
      taskId,
      baseUrl,
      authHeader,
      workspaceDir,
      runtimeRoot,
      child,
      async close() {
        await killChild(child);
        await closeAiProxy(aiProxy);
        await cleanupRuntime(runtimeRoot, keepRuntime);
      },
    };
  } catch (error) {
    await killChild(child);
    await closeAiProxy(aiProxy);
    await cleanupRuntime(runtimeRoot, keepRuntime);
    throw error;
  }
}

module.exports = {
  startIsolatedOpenCodeServer,
};
```

本节已补齐：

```text
1. aiProxy 启动后任意步骤失败都会关闭 proxy
2. spawn 失败会进入 stderrBuffer
3. child error 有监听，不会形成未处理异常
4. health 等待时间从 10 秒调整为 30 秒
5. health 超时时附带 stderr 尾部 4000 字
6. catch 分支统一 kill child、close proxy、按 keepRuntime 决定是否清理 runtime
```

关键点：

- `HOME/USERPROFILE/XDG_CONFIG_HOME/XDG_DATA_HOME` 指向临时目录，避免读取用户系统 OpenCode 配置和 auth。
- `XDG_CACHE_HOME` 指向你们自己的 `userData/agent-cache`，只缓存 provider/runtime 依赖，不保存真实 AI Key。
- `OPENCODE_CONFIG` 指向临时生成的 `opencode.json`，方便保留 runtime 时检查。
- `OPENCODE_CONFIG_CONTENT` 和 `OPENCODE_PERMISSION` 传入同一份运行时配置，与 `--pure` 配合，降低 workspace 内配置覆盖风险。
- `OPENCODE_DISABLE_DEFAULT_PLUGINS`、`OPENCODE_DISABLE_MODELS_FETCH`、`OPENCODE_DISABLE_CLAUDE_CODE` 全部打开，避免加载默认插件、远程模型发现或 Claude Code 兼容层。
- `cwd` 指向任务 workspace，不指向用户真实项目根目录。
- `OPENCODE_SERVER_PASSWORD` 使用每次随机密码，避免本机其他进程轻易调用。
- `stdio` 的 stdout 使用 `ignore`，stderr 才保留尾部内容用于失败排查，避免 stdout 未消费导致子进程阻塞。

## 10. 第七步：新增 OpenCode HTTP Client

新建文件：`client/electron/services/opencode/opencodeHttpClient.cjs`

```js
function headers(server) {
  return {
    Authorization: server.authHeader,
    'Content-Type': 'application/json',
  };
}

async function readJsonResponse(response, fallbackMessage) {
  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || raw || fallbackMessage;
    throw new Error(message);
  }

  return data;
}

async function requestJson(server, routePath, options = {}) {
  const response = await fetch(`${server.baseUrl}${routePath}`, {
    method: options.method || 'GET',
    headers: headers(server),
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  return readJsonResponse(response, `OpenCode 请求失败：${routePath}`);
}

async function createSession(server, title) {
  return requestJson(server, '/session', {
    method: 'POST',
    body: { title: title || 'Yibiao Agent Task' },
  });
}

async function sendPrompt(server, sessionId, prompt, options = {}) {
  return requestJson(server, `/session/${encodeURIComponent(sessionId)}/message`, {
    method: 'POST',
    signal: options.signal,
    body: {
      model: {
        providerID: 'yibiao',
        modelID: 'default',
      },
      agent: options.agent || 'build',
      parts: [
        {
          type: 'text',
          text: prompt,
        },
      ],
    },
  });
}

async function getSessionDiff(server, sessionId) {
  return requestJson(server, `/session/${encodeURIComponent(sessionId)}/diff`);
}

function extractTextFromPromptResult(result) {
  const parts = Array.isArray(result?.parts) ? result.parts : [];
  return parts
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

async function runOpenCodeTask(server, { title, prompt, signal }) {
  const session = await createSession(server, title);
  const messageResult = await sendPrompt(server, session.id, prompt, { signal });
  const diff = await getSessionDiff(server, session.id).catch(() => []);

  return {
    session,
    message: messageResult?.info || null,
    parts: Array.isArray(messageResult?.parts) ? messageResult.parts : [],
    text: extractTextFromPromptResult(messageResult),
    diff: Array.isArray(diff) ? diff : [],
  };
}

module.exports = {
  createSession,
  sendPrompt,
  getSessionDiff,
  runOpenCodeTask,
};
```

---

## 11. 第八步：新增正式 agentService

新建文件：`client/electron/services/agentService.cjs`

这个文件是正式框架代码。它只做通用 agent 任务，不包含测试页样例，也不接入任何现有业务流程。

```js
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getAgentRuntimeDir } = require('../utils/paths.cjs');
const { startIsolatedOpenCodeServer } = require('./opencode/opencodeServerRunner.cjs');
const { runOpenCodeTask } = require('./opencode/opencodeHttpClient.cjs');

function safeRelativePath(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('..')) {
    throw new Error(`非法文件路径：${value}`);
  }
  const lower = raw.toLowerCase();
  const reserved =
    lower === 'opencode.json'
    || lower === 'opencode.jsonc'
    || lower === 'agents.md'
    || lower === 'claude.md'
    || lower.startsWith('.opencode/')
    || lower.startsWith('.config/opencode/')
    || lower.startsWith('.claude/');
  if (reserved) {
    throw new Error(`OpenCode 保留路径或指令文件不允许作为任务输入：${value}`);
  }
  return raw;
}

function writeWorkspaceFiles(workspaceDir, files = []) {
  fs.mkdirSync(workspaceDir, { recursive: true });

  files.forEach((file) => {
    const relativePath = safeRelativePath(file.path);
    const targetPath = path.join(workspaceDir, relativePath);
    const resolvedRoot = path.resolve(workspaceDir);
    const resolvedTarget = path.resolve(targetPath);

    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`文件路径越界：${file.path}`);
    }

    fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
    fs.writeFileSync(resolvedTarget, String(file.content || ''), 'utf-8');
  });
}

function createDefaultAgentPrompt({ task, outputFile }) {
  return `你是易标投标工具箱中的自主智能体。请只在当前工作目录内工作。

任务：
${task}

要求：
1. 先阅读当前目录中的输入文件。
2. 自主判断下一步需要做什么。
3. 如需产出结果，请写入 ${outputFile}。
4. 不要访问当前工作目录外的文件。
5. 不要联网。
6. 最终回复请包含：发现的问题、处理动作、输出文件路径。`;
}

function createAgentService({ app, configStore }) {
  async function runTask(payload = {}) {
    const taskId = payload.task_id || crypto.randomUUID();
    const title = payload.title || '易标智能体任务';
    const outputFile = payload.output_file || 'agent-result.md';
    const taskRoot = path.join(getAgentRuntimeDir(app), taskId);
    const workspaceDir = path.join(taskRoot, 'workspace');

    writeWorkspaceFiles(workspaceDir, payload.files || []);

    const prompt = payload.prompt || createDefaultAgentPrompt({
      task: payload.task || '请分析当前输入文件，并输出可执行结果。',
      outputFile,
    });

    const controller = new AbortController();
    const timeoutMs = Number(payload.timeout_ms || 10 * 60 * 1000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const server = await startIsolatedOpenCodeServer({
      app,
      configStore,
      workspaceDir,
      taskId,
      keepRuntime: Boolean(payload.keep_runtime),
    });

    try {
      const result = await runOpenCodeTask(server, {
        title,
        prompt,
        signal: controller.signal,
      });

      const outputPath = path.join(workspaceDir, safeRelativePath(outputFile));
      const outputContent = fs.existsSync(outputPath)
        ? fs.readFileSync(outputPath, 'utf-8')
        : '';

      return {
        success: true,
        task_id: taskId,
        title,
        workspace_dir: workspaceDir,
        output_file: outputFile,
        output_content: outputContent,
        assistant_text: result.text,
        diff: result.diff,
        session_id: result.session?.id || '',
      };
    } finally {
      clearTimeout(timer);
      await server.close();
    }
  }

  return {
    runTask,
  };
}

module.exports = {
  createAgentService,
};
```

---

## 12. 第九步：注册正式 IPC

### 12.1 新增 `client/electron/ipc/agentIpc.cjs`

```js
const { ipcMain } = require('electron');

function registerAgentIpc({ agentService }) {
  ipcMain.handle('agent:run', async (_event, payload) => agentService.runTask(payload));
}

module.exports = {
  registerAgentIpc,
};
```

### 12.2 修改 `client/electron/ipc/index.cjs`

顶部新增 import：

```js
const { registerAgentIpc } = require('./agentIpc.cjs');
const { createAgentService } = require('../services/agentService.cjs');
```

在 `registerIpcHandlers()` 中，`configStore` 创建后新增：

```js
const agentService = createAgentService({ app, configStore });
```

在已有 IPC 注册位置新增：

```js
registerAgentIpc({ agentService });
```

推荐放在：

```js
registerAiIpc({ aiService });
registerAgentIpc({ agentService });
registerFileIpc({ fileService });
```

### 12.3 修改 `client/electron/preload.cjs`

在 `bridge` 里新增：

```js
agent: {
  run: (payload) => ipcRenderer.invoke('agent:run', payload),
},
```

这属于正式框架代码。以后真正业务页面也只需要调用这个入口，不需要知道 OpenCode Server 和 proxy 的细节。

---

## 13. 第十步：新增开发者模式测试页

本节是测试代码。它只验证正式框架，不参与现有业务流程。

### 13.1 新增测试页文件

新建文件：`client/src/features/developer/pages/OpenCodeAgentTestPage.tsx`

```tsx
import { useMemo, useState } from 'react';

type TestStepStatus = 'idle' | 'running' | 'success' | 'error';

interface TestStep {
  id: string;
  label: string;
  status: TestStepStatus;
  detail?: string;
}

interface AgentRunResult {
  success: boolean;
  task_id: string;
  title: string;
  workspace_dir: string;
  output_file: string;
  output_content: string;
  assistant_text: string;
  diff: unknown[];
  session_id: string;
}

interface YibiaoBridgeForAgentTest {
  config?: {
    load: () => Promise<{
      api_key?: string;
      base_url?: string;
      model_name?: string;
      text_model_provider?: string;
    }>;
  };
  agent?: {
    run: (payload: unknown) => Promise<AgentRunResult>;
  };
}

const DEFAULT_TASK = `请基于 tender.md 和 current-checklist.md 做一次自主审计。
重点不是重复 checklist，而是发现 checklist 没覆盖但可能导致废标、响应失败或后续人工返工的异常。

请把完整结果写入 agent-result.md，格式包含：
1. 测试是否成功
2. 自主发现的问题
3. 建议补充到固定工作流的检查项
4. 可直接展示给用户的结论`;

const SAMPLE_TENDER = `# 招标文件摘要

项目名称：智慧园区运维服务采购项目。

关键要求：

1. 投标人需要提供 7x24 小时运维响应方案。
2. 项目经理需要具有类似项目经验。
3. 需要提交服务团队人员清单。
4. 投标文件应包含数据安全、备份恢复、应急响应方案。
5. 未按要求提供承诺函或响应表，可能被视为未实质性响应。
`;

const SAMPLE_CHECKLIST = `# 当前固定检查清单

- 是否提供项目经理信息
- 是否提供服务周期
- 是否提供报价表
- 是否提供售后服务承诺
`;

function getYibiaoBridge(): YibiaoBridgeForAgentTest | undefined {
  return (window as unknown as { yibiao?: YibiaoBridgeForAgentTest }).yibiao;
}

function createInitialSteps(): TestStep[] {
  return [
    { id: 'config', label: '读取当前文本模型配置', status: 'idle' },
    { id: 'agent', label: '调用正式 agent:run IPC', status: 'idle' },
    { id: 'output', label: '校验 agent-result.md 输出', status: 'idle' },
  ];
}

function updateStep(steps: TestStep[], id: string, patch: Partial<TestStep>): TestStep[] {
  return steps.map((step) => (step.id === id ? { ...step, ...patch } : step));
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function OpenCodeAgentTestPage() {
  const [task, setTask] = useState(DEFAULT_TASK);
  const [keepRuntime, setKeepRuntime] = useState(true);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<TestStep[]>(() => createInitialSteps());
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [error, setError] = useState('');

  const yibiao = useMemo(() => getYibiaoBridge(), []);

  const runTest = async () => {
    if (running) return;

    setRunning(true);
    setError('');
    setResult(null);
    setSteps(createInitialSteps());

    try {
      if (!yibiao?.config?.load || !yibiao?.agent?.run) {
        throw new Error('当前 preload 未暴露 yibiao.config.load 或 yibiao.agent.run，请先完成 Main/IPC/preload 改造。');
      }

      setSteps((prev) => updateStep(prev, 'config', { status: 'running', detail: '正在读取 configStore 配置' }));
      const config = await yibiao.config.load();
      if (!config?.api_key || !config?.base_url || !config?.model_name) {
        throw new Error('请先在设置页配置文本模型 API Key、Base URL 和模型名称。');
      }
      setSteps((prev) => updateStep(prev, 'config', {
        status: 'success',
        detail: `${config.text_model_provider || 'unknown'} / ${config.model_name}`,
      }));

      setSteps((prev) => updateStep(prev, 'agent', { status: 'running', detail: '正在启动 OpenCode Server、OpenCode AI proxy 并执行任务' }));
      const agentResult = await yibiao.agent.run({
        title: 'OpenCode Agent 开发者链路测试',
        task,
        output_file: 'agent-result.md',
        files: [
          {
            path: 'tender.md',
            content: SAMPLE_TENDER,
          },
          {
            path: 'current-checklist.md',
            content: SAMPLE_CHECKLIST,
          },
        ],
        timeout_ms: 10 * 60 * 1000,
        keep_runtime: keepRuntime,
      });
      setResult(agentResult);
      setSteps((prev) => updateStep(prev, 'agent', {
        status: 'success',
        detail: `task_id=${agentResult.task_id}，session_id=${agentResult.session_id || '-'}`,
      }));

      setSteps((prev) => updateStep(prev, 'output', { status: 'running', detail: '正在检查输出内容' }));
      const output = String(agentResult.output_content || agentResult.assistant_text || '').trim();
      if (!agentResult.success || !output) {
        throw new Error('agent 调用完成，但未返回 output_content 或 assistant_text。');
      }
      setSteps((prev) => updateStep(prev, 'output', {
        status: 'success',
        detail: `输出 ${output.length} 字，workspace=${agentResult.workspace_dir}`,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OpenCode Agent 测试失败';
      setError(message);
      setSteps((prev) => {
        const runningStep = prev.find((step) => step.status === 'running');
        return runningStep
          ? updateStep(prev, runningStep.id, { status: 'error', detail: message })
          : prev;
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ padding: 24, maxWidth: 1120, margin: '0 auto' }}>
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 26 }}>OpenCode Agent 开发者测试</h1>
        <p style={{ marginTop: 8, color: '#64748b', lineHeight: 1.7 }}>
          这个页面只用于验证 OpenCode Server + OpenCode AI proxy + agentService 的完整链路。
          它不会写入现有业务数据库，也不会接入技术方案、废标项检查或查重流程。
        </p>
      </header>

      <section style={{ display: 'grid', gap: 16 }}>
        <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: '#fff' }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>测试任务</h2>
          <textarea
            value={task}
            onChange={(event) => setTask(event.target.value)}
            disabled={running}
            style={{
              width: '100%',
              minHeight: 180,
              resize: 'vertical',
              border: '1px solid #cbd5e1',
              borderRadius: 8,
              padding: 12,
              fontFamily: 'monospace',
              lineHeight: 1.6,
            }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, color: '#475569' }}>
            <input
              type="checkbox"
              checked={keepRuntime}
              disabled={running}
              onChange={(event) => setKeepRuntime(event.target.checked)}
            />
            保留 runtime 目录，方便检查 workspace、临时 opencode.json 和输出文件
          </label>
          <button
            type="button"
            onClick={() => { void runTest(); }}
            disabled={running}
            style={{
              marginTop: 16,
              padding: '10px 16px',
              border: 0,
              borderRadius: 8,
              background: running ? '#94a3b8' : '#2563eb',
              color: '#fff',
              cursor: running ? 'not-allowed' : 'pointer',
            }}
          >
            {running ? '测试中...' : '运行完整链路测试'}
          </button>
        </div>

        <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: '#fff' }}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>测试步骤</h2>
          <div style={{ display: 'grid', gap: 10 }}>
            {steps.map((step) => (
              <div key={step.id} style={{ display: 'grid', gap: 4, padding: 12, borderRadius: 8, background: '#f8fafc' }}>
                <strong>{step.label}：{step.status}</strong>
                {step.detail && <span style={{ color: '#64748b', wordBreak: 'break-all' }}>{step.detail}</span>}
              </div>
            ))}
          </div>
          {error && (
            <pre style={{ marginTop: 12, padding: 12, borderRadius: 8, background: '#fef2f2', color: '#991b1b', whiteSpace: 'pre-wrap' }}>
              {error}
            </pre>
          )}
        </div>

        {result && (
          <div style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 16, background: '#fff' }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>测试结果</h2>
            <h3>agent-result.md</h3>
            <pre style={{ padding: 12, borderRadius: 8, background: '#0f172a', color: '#e2e8f0', whiteSpace: 'pre-wrap' }}>
              {result.output_content || result.assistant_text || '(无输出)'}
            </pre>
            <h3>原始返回</h3>
            <pre style={{ padding: 12, borderRadius: 8, background: '#f8fafc', color: '#0f172a', whiteSpace: 'pre-wrap' }}>
              {formatJson(result)}
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}

export default OpenCodeAgentTestPage;
```

### 13.2 修改开发者菜单

修改：`client/src/app/menuConfig.ts`

在 `developerMenuItems` 的 `children` 里增加一项：

```ts
{
  id: 'developer-opencode-agent-test',
  label: 'OpenCode Agent测试',
  description: '验证 OpenCode Server、OpenCode AI proxy、agentService 的完整隔离链路。',
  icon: 'tool',
},
```

因为 `developerMenuItems` 只在 `developerMode` 为 `true` 时追加，所以这个测试入口不会出现在普通用户菜单里。

### 13.3 修改导航类型

修改：`client/src/shared/types/navigation.ts`

在 `SectionId` 联合类型中增加：

```ts
| 'developer-opencode-agent-test'
```

如果该文件不是显式 union，而是通过数组推断，则按你当前写法补齐对应 id 即可。

### 13.4 修改 AppRouter

修改：`client/src/app/AppRouter.tsx`

顶部新增：

```ts
import OpenCodeAgentTestPage from '../features/developer/pages/OpenCodeAgentTestPage';
```

在 `switch (activeSection)` 中新增：

```tsx
case 'developer-opencode-agent-test':
  return <OpenCodeAgentTestPage />;
```

### 13.5 修改 Sidebar 图标映射

修改：`client/src/components/Sidebar.tsx`

`navigationIcons` 是 `Record<SectionId, Icon>`，新增 section id 后必须补齐映射，否则 `npm run build` 会失败：

```ts
'developer-opencode-agent-test': FlaskIcon,
```

### 13.6 确认 preload bridge 类型

修改：`client/src/shared/types/ipc.ts`

这是正式框架类型，不属于可删除测试页代码。在 `YibiaoBridge` 里增加：

```ts
agent: {
  run: (payload: unknown) => Promise<unknown>;
};
```

如果后续要收紧返回类型，再新增 `AgentRunRequest` / `AgentRunResult` interface，不要让测试页单独声明一份不一致类型。

### 13.7 修改埋点看板页面映射

修改：`analytics/dashboard/public/src/pages/traffic.js`

在 `pageLabels` 中增加：

```js
'developer-opencode-agent-test': '测试页 - OpenCode Agent测试',
```

这个测试页虽然只在开发者模式下显示，但新增菜单页仍然要保持页面访问统计的中文映射完整。

### 13.8 测试页和正式框架的关系

这个页面只调用：

```ts
window.yibiao.agent.run(payload)
```

它不应该：

```text
不要 import 业务 store
不要调用 technicalPlan/rejectionCheck/duplicateCheck IPC
不要写现有 sqlite 业务库
不要修改现有任务状态
不要把测试结果展示到正式业务页面
```

删除测试页时，只需要删除：

```text
client/src/features/developer/pages/OpenCodeAgentTestPage.tsx
client/src/app/menuConfig.ts 里的 developer-opencode-agent-test 菜单项
client/src/app/AppRouter.tsx 里的 import 和 case
client/src/shared/types/navigation.ts 里的 section id
client/src/components/Sidebar.tsx 里的图标映射
analytics/dashboard/public/src/pages/traffic.js 里的页面中文名
```

正式框架代码不用删。

---

## 14. 开发者测试页完整执行链路

点击测试页按钮后，实际执行顺序是：

```text
OpenCodeAgentTestPage.runTest()
  ↓
window.yibiao.config.load()
  ↓
确认文本模型 api_key/base_url/model_name 已配置
  ↓
window.yibiao.agent.run({ files, task, output_file })
  ↓
agent:run IPC
  ↓
agentService.runTask()
  ↓
创建 userData/agent-runtime/<taskId>/workspace
  ↓
写入 tender.md 和 current-checklist.md
  ↓
启动 OpenCode 专用 OpenAI-compatible proxy
  ↓
启动隔离 OpenCode Server
  ↓
OpenCode 自主读文件、思考、写 agent-result.md
  ↓
agentService 读取 agent-result.md
  ↓
返回测试页展示
```

这套测试只验证能力，不影响现有业务链路。

---

## 15. 正式业务接入方式：后续再做，不混进测试页

测试页跑通后，如果要接入废标项检查，应该新增一个业务适配层，而不是复用测试页代码。

示例：后续可以新建 `client/electron/services/rejectionCheckAgentService.cjs`：

```js
function createRejectionCheckAgentService({ agentService, rejectionCheckStore }) {
  async function runSupplementalAudit({ tenderMarkdown, bidMarkdown, currentResultJson }) {
    return agentService.runTask({
      title: '废标项补充智能审计',
      task: `请基于 tender.md、bid.md、current-result.json 做补充审计。
不要重复已有结果，重点发现固定流程遗漏的潜在废标风险。
输出 high/middle/low 风险和建议追加到固定流程的检查项。`,
      output_file: 'agent-result.md',
      files: [
        { path: 'tender.md', content: tenderMarkdown },
        { path: 'bid.md', content: bidMarkdown },
        { path: 'current-result.json', content: JSON.stringify(currentResultJson, null, 2) },
      ],
      timeout_ms: 10 * 60 * 1000,
      keep_runtime: false,
    });
  }

  return {
    runSupplementalAudit,
  };
}

module.exports = {
  createRejectionCheckAgentService,
};
```

这个后续业务适配层才应该接入：

```text
taskService / rejectionCheckService / UI 正式页面
```

不要让正式业务页面直接复制 `OpenCodeAgentTestPage.tsx` 里的测试样例。

---

## 16. 验证步骤

### 16.1 验证正式框架是否已注册

启动开发模式：

```bash
cd client
npm run dev
```

进入设置页：

```text
设置 → 通用 → 开启开发者模式 → 保存
```

侧边栏应出现开发者菜单。进入：

```text
测试页 → OpenCode Agent测试
```

### 16.2 运行完整链路测试

在测试页点击：

```text
运行完整链路测试
```

预期步骤：

```text
读取当前文本模型配置：success
调用正式 agent:run IPC：success
校验 agent-result.md 输出：success
```

结果区域应显示：

```text
agent-result.md 内容
原始返回 JSON
workspace_dir
session_id
task_id
```

### 16.3 验证不会读取用户系统 OpenCode 配置

如果用户机器上存在：

```text
~/.config/opencode/opencode.json
~/.local/share/opencode/auth.json
```

测试仍应只使用本次临时目录：

```text
userData/agent-runtime/<taskId>/home/.config/opencode/opencode.json
userData/agent-runtime/<taskId>/home/.local/share/opencode/
```

验证方式：

1. 测试页勾选“保留 runtime 目录”。
2. 运行测试。
3. 打开返回结果里的 `workspace_dir`。
4. 回到上级目录，检查 `home/.config/opencode/opencode.json`。
5. 确认其中 provider 只有 `yibiao`，`baseURL` 指向 `http://127.0.0.1:<proxyPort>/v1`。
6. 尝试在测试 payload 的 `files` 中写入 `opencode.json`、`.opencode/config.json`、`AGENTS.md` 或 `CLAUDE.md`，应被 `agentService` 拒绝，不应进入 workspace。
7. 确认 OpenCode 启动参数包含 `--pure`，环境变量包含 `OPENCODE_CONFIG_CONTENT` 和 `OPENCODE_PERMISSION`。

### 16.4 验证端口不会冲突

连续运行多次测试。预期：

```text
OpenCode Server 使用随机端口
OpenCode AI proxy 使用随机端口
不会占用固定 4096
不会影响用户自己安装的 opencode
```

### 16.5 测试失败时的排查顺序

按这个顺序查，不要先改业务代码：

1. 文本模型配置是否可用：先用设置页“文本模型测试”。
2. `YIBIAO_OPENCODE_BIN` 或内置 binary 路径是否正确。
3. 非 Windows 平台 binary 是否有执行权限。
4. `userData/agent-runtime/<taskId>/home/.config/opencode/opencode.json` 是否生成。
5. `agent-result.md` 是否生成在 `workspace_dir` 下。
6. Main 进程控制台是否有 `[opencode] server exited` 日志。

### 16.6 验证 GitHub Actions 只打入当前平台 OpenCode

发布前必须在三个构建目标都验证通过：

```text
build-windows：vendor/opencode 只存在 win32-x64/opencode.exe
build-macos x64：vendor/opencode 只存在 darwin-x64/opencode
build-macos arm64：vendor/opencode 只存在 darwin-arm64/opencode
```

Actions 中 `Verify OpenCode binary` 失败时，不继续打包。`Verify packaged OpenCode binary` 失败时，不上传 release assets。

### 16.7 验证 macOS 用户安装路径可用

macOS 发布前必须完成：

1. 下载 GitHub Release 中的 macOS x64 DMG，在 Intel Mac 或 x64 runner 上安装测试。
2. 下载 GitHub Release 中的 macOS arm64 DMG，在 Apple Silicon Mac 上安装测试。
3. 按 `macOS使用说明.txt` 操作：拖入应用程序，然后执行：

```bash
xattr -dr com.apple.quarantine "/Applications/易标投标工具箱.app"
```

4. 打开 App，进入设置页开启开发者模式。
5. 进入 `OpenCode Agent测试` 页面运行完整链路测试。
6. 预期能生成 `agent-result.md`，且没有 `spawn EACCES`、`spawn EPERM`、`OpenCode binary 不存在`。

如果第 6 步失败，先检查打包校验是否真的跑过：

```bash
find "/Applications/易标投标工具箱.app/Contents/Resources/opencode" -maxdepth 3 -type f -name "opencode*" -print -exec ls -l {} \;
```

正常情况下，macOS 用户不需要自己配置 OpenCode binary，也不需要安装系统级 OpenCode。

---

## 17. 安全策略

第一版建议：

1. 不让 OpenCode 直接访问真实项目目录。只给任务 workspace。
2. 不把真实 API Key 写入 opencode.json。只写 `{env:YIBIAO_OPENCODE_PROXY_TOKEN}`。
3. 不暴露 OpenCode Server 到非 localhost。只监听 `127.0.0.1`。
4. 每次启动随机 Basic Auth 密码。
5. 禁用 webfetch/websearch。
6. 禁用 external_directory。
7. Headless 下不要用 permission ask。该允许的明确 allow，该禁止的明确 deny。
8. 任务输入文件禁止写入 `opencode.json`、`opencode.jsonc`、`AGENTS.md`、`CLAUDE.md`、`.opencode/**`、`.config/opencode/**`、`.claude/**` 等 OpenCode 保留配置或指令路径。
9. OpenCode 启动使用 `--pure`，并通过 `OPENCODE_CONFIG_CONTENT` / `OPENCODE_PERMISSION` 注入运行时配置，避免 workspace 中的配置文件覆盖安全策略。
10. 任务结束关闭 OpenCode Server 和 proxy。
11. 正式业务接入时，结果仍要回到现有审计链后再展示给用户。

---

## 18. 需要注意的坑

### 18.1 OpenCode provider package 初始化

OpenCode 自定义 provider 配置中使用：

```json
"npm": "@ai-sdk/openai-compatible"
```

如果 OpenCode 当前版本会动态准备 provider 包，第一次运行可能需要写 cache。建议：

```text
XDG_CACHE_HOME = userData/agent-cache/opencode-cache
```

这样不会污染用户系统 OpenCode，也避免每个任务重复初始化。

如果发布环境不允许运行时下载依赖，需要在打包或安装阶段预热 OpenCode provider cache，或者选择 OpenCode 官方推荐的可离线分发方式。

### 18.2 不要直接设置 cwd 为真实项目根目录

错误：

```js
cwd: app.getAppPath()
```

正确：

```js
cwd: workspaceDir
```

只把本次任务需要的文件复制/写入 workspace。

### 18.3 不要把整个 `process.env` 传给 OpenCode

错误：

```js
spawn(opencodeBin, args, { env: { ...process.env, ...extra } })
```

原因：可能泄露用户机器上的 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等环境变量。

正确：使用白名单环境变量，再加你们需要的临时变量。

### 18.4 Headless Server 不适合交互确认

OpenCode 的 `ask` 权限适合 TUI，不适合你们的后台任务。Server 模式下第一版建议使用明确的 `allow/deny`。

### 18.5 需要固定 OpenCode 版本

OpenCode Server API、权限配置和 provider 配置可能随版本变化。建议新增：

```text
client/vendor/opencode/VERSION
```

记录：

```text
opencode version
commit/tag
下载来源
打包日期
```

每次升级只通过一个专门 PR 做兼容验证。


### 18.6 macOS 未签名版本必须靠说明书完成信任步骤

当前项目 macOS 版没有签名和公证，不能指望系统自动放行。发布包中必须继续包含 `assets/macos-dmg/macOS使用说明.txt`，并把下面命令写成安装必做步骤：

```bash
xattr -dr com.apple.quarantine "/Applications/易标投标工具箱.app"
```

这个命令会递归处理整个 `.app`，包括内置 OpenCode binary。程序能做的事情是：

```text
构建时 chmod 755
构建时尽量清理 vendor binary 的 quarantine
打包后校验 .app 内 binary 可执行
运行时 ensureExecutable 再 chmod 兜底
```

程序不能替用户绕过未签名 App 的 Gatekeeper 信任步骤，所以必须在使用说明里明确要求用户执行 `xattr -dr ...`。

### 18.7 不要在一个安装包中塞入所有平台 binary

`extraResources` 会完整复制 `vendor/opencode`。如果仓库或构建目录里同时存在多个平台目录，最终安装包就会全部带上。解决方式不是在 `package.json` 写复杂平台 filter，而是在 Actions 里先运行：

```bash
node scripts/prepare-opencode-binary.cjs --platform <platform> --arch <arch>
```

这个脚本会清空旧目录，只生成当前平台目录。随后 `verify-opencode-binary.cjs` 会强制校验只存在一个平台目录。

---

## 19. 最小改造清单

### 19.1 正式框架改造清单

按顺序执行：

1. 新增 `client/vendor/opencode/VERSION`，固定 OpenCode 版本。
2. 新增 `client/scripts/prepare-opencode-binary.cjs`，按 `platform/arch` 下载并准备 OpenCode binary。
3. 新增 `client/scripts/verify-opencode-binary.cjs`，确保一次构建只包含当前平台 binary。
4. 新增 `client/scripts/verify-packaged-opencode-binary.cjs`，校验打包产物中的 OpenCode binary 可执行。
5. 修改 `.github/workflows/release.yml`：
   - `build-windows` 准备 `win32-x64/opencode.exe`。
   - `build-macos x64` 准备 `darwin-x64/opencode`。
   - `build-macos arm64` 准备 `darwin-arm64/opencode`。
   - 三个平台都执行 vendor 校验和 packaged 校验。
6. 修改 `client/package.json`，增加 `extraResources`。
7. 修改 `client/assets/macos-dmg/macOS使用说明.txt`，把 `xattr -dr com.apple.quarantine ...` 写成未签名版必做安装步骤，并说明 OpenCode Agent 已内置，不需要用户安装系统 OpenCode。
8. 修改 `client/electron/utils/paths.cjs`，增加 agent runtime/cache/binary 路径。
9. 新增 `client/electron/services/textTokenStatsStore.cjs`，把现有文本 token 统计抽成共享模块。
10. 修改 `client/electron/services/aiService.cjs`，让现有文本请求继续通过同一个 `getTextTokenStats/reset/onChanged` 外部接口读写共享统计。
11. 新增 `client/electron/services/opencode/aiServiceOpenAiProxy.cjs`，在该文件内实现 OpenCode 专用上游请求、队列、限流重试、开发日志和共享 token 统计。
12. OpenCode proxy 不复用现有 AI 请求唯一出口，只复用 `configStore` 和共享 token 统计。
13. 新增 `client/electron/services/opencode/opencodeConfigFactory.cjs`。
14. 新增 `client/electron/services/opencode/opencodeServerRunner.cjs`，启动时使用 `--pure`、`OPENCODE_CONFIG_CONTENT`、`OPENCODE_PERMISSION`、30 秒 health 超时、stderr 尾部错误和失败清理。
15. 新增 `client/electron/services/opencode/opencodeHttpClient.cjs`。
16. 新增 `client/electron/services/agentService.cjs`。
17. 新增 `client/electron/ipc/agentIpc.cjs`。
18. 修改 `client/electron/ipc/index.cjs` 注册 agent IPC。
19. 修改 `client/electron/preload.cjs` 暴露 `window.yibiao.agent.run()`。
20. 修改 `client/src/shared/types/ipc.ts`，补齐 `window.yibiao.agent.run()` bridge 类型。

这些是正式框架代码，后续保留。

### 19.2 第一版发布验收清单

第一版必须同时通过：

```text
Windows x64 安装包：OpenCode Agent 测试页可运行
macOS x64 DMG：按说明执行 xattr 后，OpenCode Agent 测试页可运行
macOS arm64 DMG：按说明执行 xattr 后，OpenCode Agent 测试页可运行
```

不满足任意一项，就不能标记为“OpenCode Agent 第一版完成”。

### 19.3 开发者测试页改造清单

完成正式框架后再做：

1. 新增 `client/src/features/developer/pages/OpenCodeAgentTestPage.tsx`。
2. 修改 `client/src/app/menuConfig.ts`，在开发者菜单下增加 `developer-opencode-agent-test`。
3. 修改 `client/src/shared/types/navigation.ts`，增加 `developer-opencode-agent-test` section id。
4. 修改 `client/src/app/AppRouter.tsx`，注册测试页 route。
5. 修改 `client/src/components/Sidebar.tsx`，补齐 `developer-opencode-agent-test` 图标映射。
6. 修改 `analytics/dashboard/public/src/pages/traffic.js`，补齐测试页中文映射。
7. 开启开发者模式。
8. 进入测试页运行完整链路测试。

这些是测试代码，测试完成后可以整体删除。

---

## 20. 推荐的后续增强

第一版跑通后，再考虑：

1. 任务事件流：订阅 OpenCode `/event`，把 todo、tool、diff 状态推给 UI。
2. 权限请求处理：如果必须用 `ask`，监听 permission event 并由 UI 决策。
3. 差异预览：把 `/session/:id/diff` 接入你们现有 UI，用户确认后再合并。
4. 审计归档：把 prompt、输入文件 hash、OpenCode diff、最终输出写入 developer logs。
5. 并发控制：agent 任务单独队列，避免多个 OpenCode Server 同时占用过多资源。
6. 更细粒度权限：按任务类型生成不同 `permission` 配置，例如只读审计、允许编辑、允许执行特定校验命令。
7. 版本升级测试脚本：每次升级 OpenCode binary 后自动跑 smoke test。

---

## 21. 官方资料对应关系

以下资料用于确认本方案中的 OpenCode 行为：

- OpenCode Server：`https://opencode.ai/docs/server`
  - `opencode serve` 是 headless HTTP server。
  - 默认监听 `127.0.0.1:4096`，本方案改为随机端口。
  - 支持 `OPENCODE_SERVER_PASSWORD` Basic Auth。
  - 提供 `/session`、`/session/:id/message`、`/session/:id/diff` 等 API。

- OpenCode CLI：`https://opencode.ai/docs/cli`
  - 支持 `OPENCODE_CONFIG`、`OPENCODE_CONFIG_DIR`、`OPENCODE_CONFIG_CONTENT`、`OPENCODE_PERMISSION`、`OPENCODE_DISABLE_AUTOUPDATE`、`OPENCODE_SERVER_PASSWORD` 等环境变量。
  - 支持 `--pure`，用于跳过默认配置加载。

- OpenCode Config：`https://opencode.ai/docs/config`
  - 全局配置、项目配置、自定义配置、inline config 有优先级。
  - `enabled_providers` 可限制 provider allowlist。
  - `disabled_providers` 可阻止 provider 即使存在环境变量或 `/connect` 鉴权也被加载。

- OpenCode Providers：`https://opencode.ai/docs/providers`
  - 自定义 OpenAI-compatible provider 使用 `@ai-sdk/openai-compatible`。
  - 支持 `options.baseURL`、`options.apiKey`。
  - `apiKey` 支持 `{env:VARIABLE_NAME}`。

- OpenCode Permissions：`https://opencode.ai/docs/permissions`
  - `permission` 支持 `allow/ask/deny`。
  - 支持按 `bash/edit/read/webfetch/websearch/external_directory` 配置权限。
  - 默认权限偏宽，headless 集成应主动收紧。

- OpenCode SDK：`https://opencode.ai/docs/sdk`
  - `client.session.prompt()` 示例使用：
    ```js
    body: {
      model: { providerID: 'anthropic', modelID: '...' },
      parts: [{ type: 'text', text: 'Hello!' }],
    }
    ```

---

## 22. 最终推荐落地形态

最终代码边界保持这样：

```text
正式框架代码只在：
  client/electron/services/textTokenStatsStore.cjs
  client/electron/services/opencode/*
  client/electron/services/agentService.cjs
  client/electron/ipc/agentIpc.cjs
  client/electron/preload.cjs
  client/src/shared/types/ipc.ts 的 agent bridge 类型

开发者测试代码只在：
  client/src/features/developer/pages/OpenCodeAgentTestPage.tsx
  client/src/app/menuConfig.ts 的开发者测试菜单项
  client/src/app/AppRouter.tsx 的测试页 route
  client/src/shared/types/navigation.ts 的测试 section id
  client/src/components/Sidebar.tsx 的测试页图标映射
  analytics/dashboard/public/src/pages/traffic.js 的测试页中文映射

现有业务服务暂不改：
  technicalPlan
  rejectionCheck
  duplicateCheck
  taskService
```

不要让业务代码直接依赖 OpenCode 内部 core；也不要让 OpenCode 直接读取 `user_config.json`。  
第一版发布时，Windows x64、macOS x64、macOS arm64 必须都带有对应 OpenCode binary，并通过测试页验收。正式框架跑通后，再用单独业务适配层接入具体流程，测试页代码不要进入正式业务链路。
