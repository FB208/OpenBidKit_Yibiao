#!/usr/bin/env bash
# 按指定 tag 下载缺失附件并发布到 AtomGit；凭据由环境变量注入。
# 用法：bash release_download.sh <tag>（依赖 node、curl、jq、python3）。
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo '用法：bash release_download.sh <tag>' >&2
  exit 1
fi
export TAG_NAME="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ATOM_API_BASE='https://api.atomgit.com'

for dependency in node curl jq python3; do
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

# 根据附件扩展名选择默认 Content-Type。
get_asset_content_type() {
  local ext="${1##*.}"
  ext="$(echo "$ext" | tr '[:upper:]' '[:lower:]')"
  case "$ext" in
    exe) echo 'application/vnd.microsoft.portable-executable' ;;
    zip) echo 'application/zip' ;;
    dmg) echo 'application/x-apple-diskimage' ;;
    yml|yaml) echo 'application/yaml' ;;
    *) echo 'application/octet-stream' ;;
  esac
}

# 复用现有本地协议，携带接口返回的请求头执行 PUT；HTTP 错误必须失败。
upload_atomgit_asset() {
  local file_path="$1"
  local file_name encoded_file_name encoded_tag encoded_owner encoded_repo
  file_name="$(basename "$file_path")"
  encoded_file_name="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$file_name")"
  encoded_tag="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$TAG_NAME")"
  encoded_owner="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$ATOMGIT_OWNER")"
  encoded_repo="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$ATOMGIT_REPO")"
  local upload_api="${ATOM_API_BASE}/api/v5/repos/${encoded_owner}/${encoded_repo}/releases/${encoded_tag}/upload_url?file_name=${encoded_file_name}"
  local upload_response upload_url content_type header_content_type header_keys
  echo "正在获取 AtomGit 上传地址: $file_name"
  upload_response="$(curl --fail --silent --show-error -H 'Accept: application/json' -H "Authorization: Bearer ${ATOMGIT_ACCESS_TOKEN}" "$upload_api")"
  upload_url="$(echo "$upload_response" | jq -r '.url // empty')"
  if [[ -z "$upload_url" ]]; then
    echo "AtomGit 未返回 ${file_name} 的上传地址。" >&2
    exit 1
  fi
  content_type="$(get_asset_content_type "$file_name")"
  header_content_type="$(echo "$upload_response" | jq -r '.headers."Content-Type" // empty')"
  if [[ -n "$header_content_type" ]]; then
    content_type="$header_content_type"
  fi
  local extra_headers=(-H "Content-Type: $content_type")
  header_keys="$(echo "$upload_response" | jq -r '.headers // {} | keys[]?')"
  if [[ -n "$header_keys" ]]; then
    while IFS= read -r hk; do
      [[ "$hk" == 'Content-Type' ]] && continue
      local hv
      hv="$(echo "$upload_response" | jq -r --arg k "$hk" '.headers[$k]')"
      extra_headers+=(-H "${hk}: ${hv}")
    done <<< "$header_keys"
  fi
  echo "正在上传到 AtomGit: $file_name"
  curl --fail --silent --show-error -X PUT "$upload_url" \
    "${extra_headers[@]}" \
    --upload-file "$file_path" -o /dev/null
}

# 调用共用准备逻辑，再按待传清单下载和上传，全部成功后才完成发布。
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
      upload_atomgit_asset "$file"
    done
  fi
  node "${SCRIPT_DIR}/sync-atomgit-release.mjs" --finalize
}

main
