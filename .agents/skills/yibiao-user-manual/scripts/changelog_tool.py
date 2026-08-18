#!/usr/bin/env python3
"""Inspect Git evidence and safely insert one v2 changelog entry."""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


CHANGELOG_TITLE = "# 易标投标工具箱版本更新日志"
VERSION_RE = re.compile(r"^v2\.(\d+)\.(\d+)$")
CATEGORY_OPTIONS = (
    ("added", "新增"),
    ("optimized", "优化"),
    ("fixed", "修复"),
    ("adjusted", "调整"),
)


class ChangelogToolError(Exception):
    """Describe a deterministic, user-safe changelog operation failure."""


def repository_root() -> Path:
    """Locate the repository containing the bundled Skill."""
    return Path(__file__).resolve().parents[4]


def version_key(version: str) -> tuple[int, int, int]:
    """Convert a strict v2 tag into a sortable semantic-version key."""
    match = VERSION_RE.fullmatch(version)
    if not match:
        raise ChangelogToolError(f"版本号格式无效：{version}")
    return 2, int(match.group(1)), int(match.group(2))


def decode_utf8(raw: bytes, path: Path) -> tuple[str, bool]:
    """Decode UTF-8 while remembering whether the source used a BOM."""
    has_bom = raw.startswith(b"\xef\xbb\xbf")
    try:
        return raw.decode("utf-8-sig"), has_bom
    except UnicodeDecodeError as exc:
        raise ChangelogToolError(f"文件不是有效的 UTF-8：{path}") from exc


def read_changelog(path: Path) -> tuple[bytes, str, bool]:
    """Read changelog bytes without normalizing line endings."""
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ChangelogToolError(f"无法读取版本日志：{path}") from exc
    content, has_bom = decode_utf8(raw, path)
    return raw, content, has_bom


def content_hash(raw: bytes) -> str:
    """Return the stable SHA-256 used to bind preview and apply."""
    return hashlib.sha256(raw).hexdigest()


def current_version(content: str) -> str:
    """Read the first recorded strict v2 version from the changelog."""
    if not content.startswith(CHANGELOG_TITLE):
        raise ChangelogToolError("版本日志一级标题无效")
    match = re.search(r"(?m)^## (v2\.\d+\.\d+)\r?$", content)
    if not match:
        raise ChangelogToolError("版本日志中没有有效的 v2 版本标题")
    return match.group(1)


def validate_existing_layout(content: str) -> None:
    """Reject malformed heading spacing before collecting evidence or inserting."""
    lines = content.splitlines()
    if not lines or lines[0] != CHANGELOG_TITLE:
        raise ChangelogToolError("版本日志一级标题无效")
    if len(lines) < 2 or lines[1].strip():
        raise ChangelogToolError("版本日志一级标题后必须保留空行")
    for index, line in enumerate(lines):
        if not line.startswith(("## ", "### ")):
            continue
        line_number = index + 1
        if index == 0 or lines[index - 1].strip():
            raise ChangelogToolError(f"第 {line_number} 行标题前缺少空行")
        if index + 1 >= len(lines) or lines[index + 1].strip():
            raise ChangelogToolError(f"第 {line_number} 行标题后缺少空行")


def strip_line_ending(line: str) -> str:
    """Remove one line ending without changing other whitespace."""
    if line.endswith("\r\n"):
        return line[:-2]
    if line.endswith("\n") or line.endswith("\r"):
        return line[:-1]
    return line


def has_line_ending(line: str) -> bool:
    """Return whether a preserved source line already has a line ending."""
    return line.endswith(("\r\n", "\n", "\r"))


def repair_heading_spacing(content: str) -> tuple[str, list[str]]:
    """Insert only missing blank lines around Markdown headings."""
    lines = content.splitlines(keepends=True)
    if not lines or strip_line_ending(lines[0]) != CHANGELOG_TITLE:
        raise ChangelogToolError("版本日志一级标题无效")
    newline = "\r\n" if "\r\n" in content else "\n"
    repaired: list[str] = []
    changes: list[str] = []

    for index, line in enumerate(lines):
        text = strip_line_ending(line)
        is_heading = index == 0 or text.startswith(("## ", "### "))
        line_number = index + 1
        if index > 0 and is_heading and repaired and strip_line_ending(repaired[-1]).strip():
            repaired.append(newline)
            changes.append(f"在第 {line_number} 行标题前插入空行")

        repaired.append(line)
        next_is_blank = index + 1 < len(lines) and not strip_line_ending(lines[index + 1]).strip()
        if is_heading and not next_is_blank:
            if not has_line_ending(repaired[-1]):
                repaired[-1] += newline
            repaired.append(newline)
            changes.append(f"在第 {line_number} 行标题后插入空行")

    proposed = "".join(repaired)
    before_nonblank = [line for line in content.splitlines() if line.strip()]
    after_nonblank = [line for line in proposed.splitlines() if line.strip()]
    if before_nonblank != after_nonblank:
        raise ChangelogToolError("格式修复会改变非空内容，已拒绝执行")
    validate_existing_layout(proposed)
    return proposed, changes


def run_git(repository: Path, arguments: Iterable[str], allowed_codes: set[int] | None = None) -> tuple[int, str]:
    """Run one Git process without a shell and decode output as UTF-8."""
    command = ["git", "-c", "core.quotepath=false", *arguments]
    try:
        result = subprocess.run(command, cwd=repository, capture_output=True, check=False)
    except OSError as exc:
        raise ChangelogToolError("无法启动 Git") from exc
    stdout = result.stdout.decode("utf-8", errors="replace")
    stderr = result.stderr.decode("utf-8", errors="replace").strip()
    allowed = {0} if allowed_codes is None else allowed_codes
    if result.returncode not in allowed:
        detail = stderr[:300] if stderr else f"退出码 {result.returncode}"
        raise ChangelogToolError(f"Git 命令失败：{' '.join(arguments)}（{detail}）")
    return result.returncode, stdout


def parse_changed_files(output: str) -> list[dict[str, str]]:
    """Parse Git name-status output into stable JSON records."""
    files: list[dict[str, str]] = []
    for line in output.splitlines():
        if not line:
            continue
        parts = line.split("\t")
        record = {"status": parts[0], "path": parts[-1]}
        if len(parts) > 2:
            record["source_path"] = parts[1]
        files.append(record)
    return files


def collect_release_evidence(repository: Path, changelog_path: Path) -> dict[str, Any]:
    """Collect baseline, pending tags, commits, file changes, and diff statistics."""
    repository = repository.resolve()
    changelog_path = changelog_path.resolve()
    _, content, _ = read_changelog(changelog_path)
    baseline = current_version(content)

    _, shallow_output = run_git(repository, ["rev-parse", "--is-shallow-repository"])
    if shallow_output.strip().casefold() != "false":
        raise ChangelogToolError("仓库是浅克隆，无法可靠分析正式版本历史")

    _, tag_output = run_git(repository, ["tag", "--list", "v2.*"])
    tags = sorted(
        {tag.strip() for tag in tag_output.splitlines() if VERSION_RE.fullmatch(tag.strip())},
        key=version_key,
    )
    if baseline not in tags:
        raise ChangelogToolError(f"版本日志基线标签不存在：{baseline}")

    pending = [tag for tag in tags if version_key(tag) > version_key(baseline)]
    comparisons: list[dict[str, Any]] = []
    previous = baseline
    for tag in pending:
        relation_code, _ = run_git(
            repository,
            ["merge-base", "--is-ancestor", previous, tag],
            allowed_codes={0, 1},
        )
        if relation_code != 0:
            raise ChangelogToolError(f"正式标签关系不明确：{previous} -> {tag}")
        _, log_output = run_git(
            repository,
            ["log", "--format=%H%x09%ad%x09%s", "--date=iso-strict", f"{previous}..{tag}"],
        )
        commits = []
        for line in log_output.splitlines():
            parts = line.split("\t", 2)
            if len(parts) == 3:
                commits.append({"commit": parts[0], "date": parts[1], "subject": parts[2]})
        _, files_output = run_git(repository, ["diff", "--name-status", previous, tag])
        _, stat_output = run_git(repository, ["diff", "--stat", previous, tag])
        comparisons.append(
            {
                "from": previous,
                "to": tag,
                "commits": commits,
                "changed_files": parse_changed_files(files_output),
                "stat": stat_output.rstrip(),
            }
        )
        previous = tag

    return {
        "repository": str(repository),
        "changelog": str(changelog_path),
        "current_version": baseline,
        "pending_versions": pending,
        "comparisons": comparisons,
    }


@dataclass(frozen=True)
class InsertPlan:
    """Hold an immutable preview ready for optional atomic application."""

    path: Path
    version: str
    before_hash: str
    after_hash: str
    entry: str
    diff: str
    after_bytes: bytes


def validate_items(items: Iterable[str], category: str) -> list[str]:
    """Validate one category's user-facing Chinese sentence list."""
    cleaned: list[str] = []
    for item in items:
        sentence = item.strip()
        if not sentence:
            raise ChangelogToolError(f"{category}栏目包含空条目")
        if "\r" in sentence or "\n" in sentence:
            raise ChangelogToolError(f"{category}栏目每条内容必须是单行句子")
        if sentence.startswith(("-", "#")):
            raise ChangelogToolError(f"{category}栏目条目不要包含 Markdown 标记")
        if not sentence.endswith("。"):
            raise ChangelogToolError(f"{category}栏目条目必须以中文句号结尾")
        cleaned.append(sentence)
    return cleaned


def build_entry(version: str, categories: dict[str, list[str]], newline: str) -> str:
    """Build fixed-order Markdown from structured category sentences."""
    version_key(version)
    lines = [f"## {version}"]
    item_count = 0
    for key, heading in CATEGORY_OPTIONS:
        items = validate_items(categories.get(key, []), heading)
        if not items:
            continue
        lines.extend(("", f"### {heading}", ""))
        lines.extend(f"- {item}" for item in items)
        item_count += len(items)
    if item_count == 0:
        raise ChangelogToolError("新版本至少需要一条更新内容")
    return newline.join(lines)


def prepare_insert(
    repository: Path,
    changelog_path: Path,
    version: str,
    categories: dict[str, list[str]],
) -> InsertPlan:
    """Prepare a strict top insertion without writing the changelog."""
    evidence = collect_release_evidence(repository, changelog_path)
    pending = evidence["pending_versions"]
    if not pending:
        raise ChangelogToolError("没有待写入的正式版本")
    if version != pending[0]:
        raise ChangelogToolError(f"必须先写入最早缺失版本：{pending[0]}")

    raw, original_content, has_bom = read_changelog(changelog_path)
    if re.search(rf"(?m)^## {re.escape(version)}\r?$", original_content):
        raise ChangelogToolError(f"版本日志已包含 {version}")
    content, _ = repair_heading_spacing(original_content)
    newline = "\r\n" if "\r\n" in content else "\n"
    prefix = CHANGELOG_TITLE + newline + newline
    if not content.startswith(prefix):
        raise ChangelogToolError("版本日志标题后必须保留一个空行")

    entry = build_entry(version, categories, newline)
    proposed = prefix + entry + newline + newline + content[len(prefix) :]
    after_bytes = proposed.encode("utf-8")
    if has_bom:
        after_bytes = b"\xef\xbb\xbf" + after_bytes
    diff = "".join(
        difflib.unified_diff(
            original_content.splitlines(keepends=True),
            proposed.splitlines(keepends=True),
            fromfile=str(changelog_path),
            tofile=str(changelog_path),
        )
    )
    return InsertPlan(
        changelog_path,
        version,
        content_hash(raw),
        content_hash(after_bytes),
        entry,
        diff,
        after_bytes,
    )


def atomic_apply(
    path: Path,
    before_hash: str,
    after_bytes: bytes,
) -> None:
    """Atomically apply prepared bytes if the source did not change meanwhile."""
    current_raw, _, _ = read_changelog(path)
    if content_hash(current_raw) != before_hash:
        raise ChangelogToolError("版本日志在写入前发生变化，请重新执行更新任务")
    if current_raw == after_bytes:
        return
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=path.parent,
            prefix=path.name + ".",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary.write(after_bytes)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, path)
        temporary_path = None
    except OSError as exc:
        raise ChangelogToolError(f"无法原子写入版本日志：{path}") from exc
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def apply_insert(plan: InsertPlan) -> None:
    """Atomically apply a prepared version insertion."""
    atomic_apply(plan.path, plan.before_hash, plan.after_bytes)


def plan_payload(plan: InsertPlan, applied: bool) -> dict[str, Any]:
    """Convert an insertion plan to stable JSON without exposing raw bytes."""
    return {
        "success": True,
        "mode": "apply" if applied else "preview",
        "version": plan.version,
        "changelog": str(plan.path),
        "content_hash_before": plan.before_hash,
        "content_hash_after": plan.after_hash,
        "entry": plan.entry,
        "diff": plan.diff,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse deterministic inspect and insert commands."""
    parser = argparse.ArgumentParser(description="检查正式版本证据并安全更新易标 v2 版本日志")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="只读收集待写版本和 Git 证据")
    inspect_parser.add_argument("--repository", type=Path)
    inspect_parser.add_argument("--changelog", type=Path)
    inspect_parser.add_argument("--json", action="store_true")

    insert_parser = subparsers.add_parser("insert", help="预览或原子插入一个正式版本")
    insert_parser.add_argument("--repository", type=Path)
    insert_parser.add_argument("--changelog", type=Path)
    insert_parser.add_argument("--version", required=True)
    insert_parser.add_argument("--new", dest="added", action="append", default=[])
    insert_parser.add_argument("--optimize", dest="optimized", action="append", default=[])
    insert_parser.add_argument("--fix", dest="fixed", action="append", default=[])
    insert_parser.add_argument("--adjust", dest="adjusted", action="append", default=[])
    insert_parser.add_argument("--apply", action="store_true")
    insert_parser.add_argument("--json", action="store_true")

    args = parser.parse_args(argv)
    if args.repository is None:
        args.repository = repository_root()
    if args.changelog is None:
        args.changelog = args.repository / "使用说明" / "更新日志" / "v2版本更新日志.md"
    return args


def print_human(payload: dict[str, Any]) -> None:
    """Print a concise fallback when JSON output is not requested."""
    if "pending_versions" in payload:
        print(f"当前版本：{payload['current_version']}")
        pending = payload["pending_versions"]
        print("待写版本：" + ("、".join(pending) if pending else "无"))
        return
    print(f"{payload['mode']}：{payload['version']}")
    print(f"写入前哈希：{payload['content_hash_before']}")
    print(payload["diff"])


def main(argv: list[str] | None = None) -> int:
    """Run the requested operation with Windows UTF-8 console output."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8")
    args = parse_args(argv)
    try:
        if args.command == "inspect":
            payload = collect_release_evidence(args.repository, args.changelog)
        else:
            categories = {
                "added": args.added,
                "optimized": args.optimized,
                "fixed": args.fixed,
                "adjusted": args.adjusted,
            }
            plan = prepare_insert(args.repository, args.changelog, args.version, categories)
            if args.apply:
                apply_insert(plan)
            payload = plan_payload(plan, args.apply)
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print_human(payload)
        return 0
    except ChangelogToolError as exc:
        error = {"success": False, "error": "changelog", "message": str(exc)}
        if getattr(args, "json", False):
            print(json.dumps(error, ensure_ascii=False), file=sys.stderr)
        else:
            print(f"版本日志工具失败：{exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("操作已取消", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
