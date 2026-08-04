#!/usr/bin/env bash
# 下载 GitHub 最新发行版资源，并上传到 AtomGit 对应 tag 的 release。
# 用法：直接运行 ./release_download.sh（依赖 curl、jq，macOS 自带即可）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ATOMGIT_ENV_FILE="${SCRIPT_DIR}/.env"

GITHUB_REPO="FB208/OpenBidKit_Yibiao"
GITHUB_API="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
ATOM_OWNER="FB208"
ATOM_REPO="OpenBidKit_Yibiao"
ATOM_API_BASE="https://api.atomgit.com"

GITHUB_UA="macOS-Release-Downloader"

# 退出前清理临时文件
TMP_DIR=""
cleanup() {
  if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
}
trap cleanup EXIT

# 从 .env 文件读取 ATOMGIT_TOKEN（支持引号包裹、注释行、空行）
read_atomgit_token() {
  local env_file="$1"
  if [[ ! -f "${env_file}" ]]; then
    echo "错误：找不到 AtomGit 配置文件: ${env_file}" >&2
    exit 1
  fi
  local line key value
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="$(echo "${line}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" != *"="* ]] && continue
    key="${line%%=*}"
    key="$(echo "${key}" | sed 's/[[:space:]]*$//')"
    [[ "${key}" != "ATOMGIT_TOKEN" ]] && continue
    value="${line#*=}"
    value="$(echo "${value}" | sed 's/^[[:space:]]*//')"
    # 去除首尾引号
    if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
      value="${value:1:-1}"
    elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
      value="${value:1:-1}"
    fi
    if [[ -z "${value}" ]]; then
      echo "错误：ATOMGIT_TOKEN 不能为空。" >&2
      exit 1
    fi
    echo "${value}"
    return 0
  done < "${env_file}"
  echo "错误：AtomGit 配置文件中缺少 ATOMGIT_TOKEN。" >&2
  exit 1
}

# 根据文件扩展名推断 Content-Type
get_asset_content_type() {
  local file_name="$1"
  local ext="${file_name##*.}"
  ext="$(echo "${ext}" | tr '[:upper:]' '[:lower:]')"
  case "${ext}" in
    exe) echo "application/vnd.microsoft.portable-executable" ;;
    zip) echo "application/zip" ;;
    dmg) echo "application/x-apple-diskimage" ;;
    yml|yaml) echo "application/yaml" ;;
    *) echo "application/octet-stream" ;;
  esac
}

# 将文件上传到 AtomGit 指定 tag 的 release
upload_atomgit_asset() {
  local file_path="$1"
  local tag="$2"
  local atom_token="$3"
  local file_name
  file_name="$(basename "${file_path}")"

  local encoded_file_name
  encoded_file_name="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "${file_name}")"
  local encoded_tag
  encoded_tag="$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "${tag}")"

  local upload_api="${ATOM_API_BASE}/api/v5/repos/${ATOM_OWNER}/${ATOM_REPO}/releases/${encoded_tag}/upload_url?file_name=${encoded_file_name}"

  echo "正在获取 AtomGit 上传地址: ${file_name}"
  local upload_response
  upload_response="$(curl -sS -H "Accept: application/json" -H "Authorization: Bearer ${atom_token}" "${upload_api}")"

  local upload_url
  upload_url="$(echo "${upload_response}" | jq -r '.url // empty')"
  if [[ -z "${upload_url}" ]]; then
    echo "错误：AtomGit 未返回 ${file_name} 的上传地址。响应内容: ${upload_response}" >&2
    exit 1
  fi

  local content_type
  content_type="$(get_asset_content_type "${file_name}")"

  local extra_headers=()
  local header_content_type
  header_content_type="$(echo "${upload_response}" | jq -r '.headers."Content-Type" // empty')"
  if [[ -n "${header_content_type}" ]]; then
    content_type="${header_content_type}"
  fi

  # 拼接 upload_response.headers 中除 Content-Type 外的所有额外请求头
  local header_keys
  header_keys="$(echo "${upload_response}" | jq -r '.headers // {} | keys[]?')"
  if [[ -n "${header_keys}" ]]; then
    while IFS= read -r hk; do
      [[ "${hk}" == "Content-Type" ]] && continue
      local hv
      hv="$(echo "${upload_response}" | jq -r --arg k "${hk}" '.headers[$k]')"
      extra_headers+=(-H "${hk}: ${hv}")
    done <<< "${header_keys}"
  fi

  echo "正在上传到 AtomGit: ${file_name}"
  curl -sS -X PUT "${upload_url}" \
    -H "Content-Type: ${content_type}" \
    "${extra_headers[@]}" \
    --upload-file "${file_path}" \
    -o /dev/null
}

main() {
  local atom_token
  atom_token="$(read_atomgit_token "${ATOMGIT_ENV_FILE}")"

  echo "正在获取 GitHub 最新发行版信息..."
  local release_json
  release_json="$(curl -sS -H "User-Agent: ${GITHUB_UA}" -H "Accept: application/vnd.github+json" "${GITHUB_API}")"

  local tag
  tag="$(echo "${release_json}" | jq -r '.tag_name // empty')"
  if [[ -z "${tag}" ]]; then
    echo "错误：未能获取 GitHub 最新发行版标签。响应内容: ${release_json}" >&2
    exit 1
  fi

  local asset_count
  asset_count="$(echo "${release_json}" | jq -r '.assets | length')"
  if [[ "${asset_count}" -eq 0 ]]; then
    echo "错误：未找到 GitHub 发行版资源。" >&2
    exit 1
  fi

  local out_dir="$(pwd)/Yibiao-${tag}"
  mkdir -p "${out_dir}"
  echo "最新版本: ${tag}"

  local downloaded_files=()
  local i asset_name asset_url
  for ((i=0; i<asset_count; i++)); do
    asset_name="$(echo "${release_json}" | jq -r ".assets[${i}].name")"
    asset_url="$(echo "${release_json}" | jq -r ".assets[${i}].browser_download_url")"
    local file_path="${out_dir}/${asset_name}"
    echo "正在下载: ${asset_name}"
    curl -sS -L -H "User-Agent: ${GITHUB_UA}" -H "Accept: application/vnd.github+json" -o "${file_path}" "${asset_url}"
    downloaded_files+=("${file_path}")
  done

  echo ""
  echo "所有 GitHub 发行版资源已下载完成。开始上传到 AtomGit..."
  local file
  for file in "${downloaded_files[@]}"; do
    upload_atomgit_asset "${file}" "${tag}" "${atom_token}"
  done

  echo ""
  echo "完成。保存路径: ${out_dir}"
  echo "AtomGit 发行版地址: https://atomgit.com/${ATOM_OWNER}/${ATOM_REPO}/releases/${tag}"
}

main "$@"
