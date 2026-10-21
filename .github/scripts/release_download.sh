#!/usr/bin/env bash
# 按指定 tag 下载缺失附件并发布到 AtomGit；凭据由环境变量注入。
# 用法：bash release_download.sh <tag>（依赖 node、curl、jq）。
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo '用法：bash release_download.sh <tag>' >&2
  exit 1
fi
export TAG_NAME="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for dependency in node curl jq; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "缺少依赖：$dependency" >&2
    exit 1
  fi
done

TEMP_ROOT="$(cd "${RUNNER_TEMP:-${TMPDIR:-/tmp}}" && pwd -P)"
WORK_DIR="$(mktemp -d "${TEMP_ROOT}/yibiao-atomgit.XXXXXX")"
export GITHUB_RELEASE_JSON="${WORK_DIR}/release.json"

# 只清理 mktemp 在已解析临时根目录下为本次运行创建的目录。
cleanup() {
  case "$WORK_DIR" in
    "$TEMP_ROOT"/yibiao-atomgit.*) rm -rf -- "$WORK_DIR" ;;
  esac
}
trap cleanup EXIT

# 调用共用准备逻辑，再按待传清单下载，并由 Node 逐个上传，全部成功后才完成发布。
main() {
  node "${SCRIPT_DIR}/sync-atomgit-release.mjs" --prepare
  local asset_count i asset_name asset_url file_path
  asset_count="$(jq '.pendingAssets | length' "$GITHUB_RELEASE_JSON")"
  local downloaded_files=()
  for ((i=0; i<asset_count; i++)); do
    asset_name="$(jq -r ".pendingAssets[$i].name" "$GITHUB_RELEASE_JSON")"
    asset_url="$(jq -r ".pendingAssets[$i].url" "$GITHUB_RELEASE_JSON")"
    file_path="${WORK_DIR}/${asset_name}"
    echo "正在下载: $asset_name"
    curl --fail --silent --show-error --location -H 'User-Agent: macOS-Release-Downloader' \
      --output "$file_path" "$asset_url"
    downloaded_files+=("$file_path")
  done
  # Bash 3.2 在 nounset 下不能直接展开空数组。
  if [[ "$asset_count" -gt 0 ]]; then
    local file
    for file in "${downloaded_files[@]}"; do
      node "${SCRIPT_DIR}/sync-atomgit-release.mjs" --upload "$file"
    done
  fi
  node "${SCRIPT_DIR}/sync-atomgit-release.mjs" --finalize
}

main
