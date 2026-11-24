import subprocess
from argparse import ArgumentParser, ArgumentTypeError
from pathlib import Path


# 为两份标段测试脚本添加相同的样本参数和默认路径。
def add_tender_arguments(parser: ArgumentParser, root: Path):
    # 校验通过 --file 指定的输入格式。
    def parse_file(value: str) -> Path:
        file = Path(value)
        if file.suffix.lower() not in {".md", ".markdown", ".docx"}:
            raise ArgumentTypeError("仅支持 .md、.markdown 和 .docx")
        return file

    input_files = parser.add_mutually_exclusive_group()
    input_files.add_argument(
        "markdown", nargs="?", type=Path,
        default=root / "testfiles" / "jev-tender.md",
        help="招标 Markdown 路径，未指定文件时使用 testfiles/jev-tender.md",
    )
    input_files.add_argument("--file", type=parse_file, metavar="路径", help="指定招标 Markdown 或 Word（.docx）文件")


# Markdown 直接读入，Word 由项目解析器在本地转成 Markdown。
def read_tender_markdown(file: Path, root: Path) -> str:
    if file.suffix.lower() != ".docx":
        return file.read_text(encoding="utf-8-sig")
    return subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { convertPathToMarkdown } from './client/electron/services/doc2markdown/convert.mjs'; "
            "process.stdout.write(await convertPathToMarkdown(process.argv[1]));",
            str(file.resolve()),
        ],
        cwd=root, stdout=subprocess.PIPE, encoding="utf-8", check=True,
    ).stdout
