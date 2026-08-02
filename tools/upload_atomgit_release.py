"""将当前目录中的易标 macOS 安装包上传到指定 AtomGit Release。"""

import argparse
import http.client
import json
import mimetypes
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen


API_BASE = "https://api.atomgit.com"
OWNER = "FB208"
REPOSITORY = "OpenBidKit_Yibiao"
RELEASE_TAG = "v2.23.10"
DEFAULT_FILE_NAME = "Yibiao-2.23.10-mac-arm64.dmg"
CHUNK_SIZE = 1024 * 1024


def parse_arguments() -> argparse.Namespace:
    """解析待上传的自定义文件名或文件路径。"""
    parser = argparse.ArgumentParser(description="上传文件到 AtomGit v2.23.10 Release")
    parser.add_argument(
        "file",
        nargs="?",
        default=DEFAULT_FILE_NAME,
        help=f"待上传的文件名或路径，默认为 {DEFAULT_FILE_NAME}",
    )
    return parser.parse_args()


def read_token(env_path: Path) -> str:
    """从脚本同目录的 .env 文件读取 AtomGit 访问令牌。"""
    if not env_path.is_file():
        raise RuntimeError(f"找不到配置文件：{env_path}")

    for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        if key.strip() == "ATOMGIT_TOKEN":
            token = value.strip()
            if len(token) >= 2 and token[0] == token[-1] and token[0] in {'"', "'"}:
                token = token[1:-1]
            if not token:
                raise RuntimeError(".env 中的 ATOMGIT_TOKEN 不能为空")
            return token

    raise RuntimeError(".env 中缺少 ATOMGIT_TOKEN 配置")


def get_upload_target(token: str, file_name: str) -> tuple[str, dict[str, str]]:
    """向 AtomGit 获取 Release 附件的预签名上传地址及请求头。"""
    path = (
        f"/api/v5/repos/{quote(OWNER, safe='')}/{quote(REPOSITORY, safe='')}"
        f"/releases/{quote(RELEASE_TAG, safe='')}/upload_url"
    )
    url = f"{API_BASE}{path}?{urlencode({'file_name': file_name})}"
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="GET",
    )

    try:
        with urlopen(request, timeout=60) as response:
            payload = json.load(response)
    except HTTPError as exc:
        message = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"获取上传地址失败（HTTP {exc.code}）：{message}") from exc
    except URLError as exc:
        raise RuntimeError(f"无法连接 AtomGit API：{exc.reason}") from exc

    upload_url = payload.get("url")
    if not isinstance(upload_url, str) or not upload_url:
        raise RuntimeError("接口响应中缺少有效的 url 字段")

    raw_headers = payload.get("headers", {})
    if not isinstance(raw_headers, dict):
        raise RuntimeError(f"接口返回的 headers 格式无效：{raw_headers}")
    headers = {str(key): str(value) for key, value in raw_headers.items()}
    return upload_url, headers


def upload_file(upload_url: str, supplied_headers: dict[str, str], file_path: Path) -> None:
    """按预签名地址以 PUT 方式流式上传文件并输出进度。"""
    parsed = urlsplit(upload_url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise RuntimeError(f"AtomGit 返回了无效的 HTTPS 上传地址：{upload_url}")

    request_path = parsed.path or "/"
    if parsed.query:
        request_path += f"?{parsed.query}"

    file_size = file_path.stat().st_size
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    headers = dict(supplied_headers)
    headers.setdefault("Content-Type", content_type)
    headers["Content-Length"] = str(file_size)

    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port, timeout=300)
    try:
        connection.putrequest("PUT", request_path)
        for name, value in headers.items():
            connection.putheader(name, value)
        connection.endheaders()

        uploaded = 0
        last_percent = -1
        with file_path.open("rb") as source:
            while chunk := source.read(CHUNK_SIZE):
                connection.send(chunk)
                uploaded += len(chunk)
                percent = uploaded * 100 // file_size
                if percent != last_percent:
                    print(f"\r上传进度：{percent:3d}%", end="", flush=True)
                    last_percent = percent

        response = connection.getresponse()
        response_body = response.read().decode("utf-8", errors="replace")
        print()
        if not 200 <= response.status < 300:
            raise RuntimeError(
                f"上传失败（HTTP {response.status} {response.reason}）：{response_body}"
            )
    finally:
        connection.close()


def main() -> int:
    """检查本地文件并执行 AtomGit Release 附件上传。"""
    arguments = parse_arguments()
    script_directory = Path(__file__).resolve().parent
    file_path = Path(arguments.file).expanduser()
    if not file_path.is_absolute():
        file_path = script_directory / file_path
    file_path = file_path.resolve()

    if not file_path.is_file():
        print(f"错误：找不到文件 {file_path}", file=sys.stderr)
        return 1

    try:
        token = read_token(script_directory / ".env")
        print(f"正在获取 {OWNER}/{REPOSITORY} 的 {RELEASE_TAG} 附件上传地址……")
        upload_url, upload_headers = get_upload_target(token, file_path.name)
        print(f"附件上传地址：{upload_url}")
        print(f"开始上传 {file_path.name}（{file_path.stat().st_size / 1024 / 1024:.1f} MB）……")
        upload_file(upload_url, upload_headers, file_path)
    except (OSError, RuntimeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1

    print(f"上传完成：https://atomgit.com/{OWNER}/{REPOSITORY}/releases/{RELEASE_TAG}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
