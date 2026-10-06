#!/usr/bin/env bash
# 在 macOS 配置 AtomGit 发布专用 Runner。用法：bash setup-atomgit-runner.sh [空安装目录]
# 前置依赖：Git、curl、jq、python3；可用 Homebrew 安装 git jq python。
set -euo pipefail

if [[ "$(uname -s)" != 'Darwin' ]]; then
  echo '此配置脚本用于 macOS；Windows 请运行 setup-atomgit-runner.bat。' >&2
  exit 1
fi
if [[ "$EUID" -eq 0 ]]; then
  echo '请使用当前登录用户运行，不要使用 sudo。' >&2
  exit 1
fi
for dependency in git curl jq python3 tar shasum; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "缺少依赖：$dependency。请先安装依赖，例如 brew install git jq python。" >&2
    exit 1
  fi
done
git --version >/dev/null

REPO_URL='https://github.com/FB208/OpenBidKit_Yibiao'
INSTALL_DIR="${1:-$HOME/actions-runner-yibiao-atomgit}"
if [[ -e "$INSTALL_DIR" && ( ! -d "$INSTALL_DIR" || -n "$(ls -A "$INSTALL_DIR")" ) ]]; then
  echo "安装目录不是空目录：$INSTALL_DIR。已有 Runner 无需重新注册；新安装请指定另一个空目录。" >&2
  exit 1
fi
case "$(uname -m)" in
  arm64) RUNNER_ARCH='arm64' ;;
  x86_64) RUNNER_ARCH='x64' ;;
  *) echo '此安装脚本支持 Apple Silicon 和 Intel Mac。' >&2; exit 1 ;;
esac

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/atomgit-runner-setup.XXXXXX")"
ARCHIVE="${TEMP_DIR}/runner.tar.gz"

# 退出时只删除本次下载的安装包和空临时目录。
cleanup() {
  rm -f -- "$ARCHIVE"
  rmdir -- "$TEMP_DIR"
}
trap cleanup EXIT

# 下载官方最新安装包，并使用 GitHub 提供的 SHA-256 验证。
echo "目标仓库：$REPO_URL"
echo "安装目录：$INSTALL_DIR"
release_json="$(curl --fail --silent --show-error -H 'Accept: application/vnd.github+json' \
  -H 'User-Agent: yibiao-runner-setup' 'https://api.github.com/repos/actions/runner/releases/latest')"
asset_json="$(printf '%s' "$release_json" | jq -ce --arg arch "$RUNNER_ARCH" \
  '[.assets[] | select(.name | test("^actions-runner-osx-" + $arch + "-.*\\.tar\\.gz$"))] | if length == 1 then .[0] else error("未找到唯一对应的安装包") end')"
asset_name="$(printf '%s' "$asset_json" | jq -r '.name')"
asset_url="$(printf '%s' "$asset_json" | jq -r '.browser_download_url')"
asset_digest="$(printf '%s' "$asset_json" | jq -r '.digest')"
if [[ ! "$asset_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo '官方发布未提供 SHA-256，安装已停止。' >&2
  exit 1
fi
echo "正在下载 $asset_name..."
curl --fail --silent --show-error --location --output "$ARCHIVE" "$asset_url"
actual_hash="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [[ "$actual_hash" != "${asset_digest#sha256:}" ]]; then
  echo 'Runner 安装包 SHA-256 不匹配。' >&2
  exit 1
fi
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
tar -xzf "$ARCHIVE"

# 读取仓库页面生成的一小时注册令牌，输入过程不回显。
echo ''
echo "打开：$REPO_URL/settings/actions/runners/new"
echo '选择 macOS，复制 Configure 命令中 --token 后面的值（有效期一小时）。'
read -r -s -p '粘贴临时注册令牌：' registration_token
echo ''
if [[ -z "$registration_token" ]]; then
  echo '注册令牌不能为空。' >&2
  exit 1
fi

# 以当前用户注册 Runner，并安装、启动登录后自动运行的 launchd 服务。
./config.sh --unattended --url "$REPO_URL" --token "$registration_token" \
  --name "atomgit-$(hostname -s)-$RUNNER_ARCH" --labels 'atomgit-upload' --work '_work'
unset registration_token
./svc.sh install
./svc.sh start
echo ''
echo '配置完成，当前用户的后台服务已启动，后续登录时自动启动。'
echo "请在 $REPO_URL/settings/actions/runners 确认状态为 Idle，标签包含 atomgit-upload。"
echo '发布凭据由工作流注入，无需在此目录配置 .env。电脑需要保持登录、联网且不休眠。'
