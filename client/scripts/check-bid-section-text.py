# 文本模型标段识别测试：在仓库根目录的 .env.test 配置 TEXT_API_KEY、TEXT_BASE_URL、TEXT_MODEL_NAME。
# 在仓库根目录运行，默认使用 testfiles/jev-tender.md：
# python -X utf8 client/scripts/check-bid-section-text.py
# 指定自己的 Markdown 或 Word 文件（Word 需要 Node 和已安装的客户端依赖）：
# python -X utf8 client/scripts/check-bid-section-text.py --file ".\testfiles\jev-tender.docx"
# 要估算费用，可追加 --price-usd <输入单价> <输出单价>，单位为美元/百万 token。

import argparse
import json
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from test_model_config import read_test_model
from test_tender_input import add_tender_arguments, read_tender_markdown


# 用测试文本模型一次性判断完整招标原文，输出模型答案和请求统计。
def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="测试普通文本模型识别招标文件单标段或多标段")
    add_tender_arguments(parser, root)
    parser.add_argument(
        "--price-usd", nargs=2, type=float, metavar=("输入单价", "输出单价"),
        help="估算费用所用单价，单位为美元/百万 token；不填则不估价",
    )
    args = parser.parse_args()

    api_key, base_url, model = read_test_model(root, "TEXT", "BASE_URL")
    payload = {
        "model": model,
        "stream": False,
        "max_tokens": 32,
        "messages": [
            {
                "role": "system",
                "content": (
                    "判断本次招标项目是否实际划分为两个或以上独立的投标范围。\n"
                    "多标段：原文明确划分出至少两个可分别投标或分别评审、授标的标段、标包、采购包、包件或标的。\n"
                    "单标段：本次只有一个或未划分独立投标范围。章节、采购明细、同一标段的重复提及，"
                    "以及仅在通用条款或模板中提到多个标段，均不算实际划分。\n"
                    "只输出“单标段”或“多标段”，不要添加其他内容。"
                ),
            },
            {"role": "user", "content": read_tender_markdown(args.file or args.markdown, root)},
        ],
    }
    if model.startswith("deepseek"):
        payload["thinking"] = {"type": "disabled"}

    request = Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )

    started = time.perf_counter()
    try:
        with urlopen(request, timeout=300) as response:
            body = response.read()
    except HTTPError as error:
        raise SystemExit(f"文本模型 HTTP {error.code}: {error.read().decode('utf-8')}") from error
    elapsed = time.perf_counter() - started

    result = json.loads(body)
    usage = result["usage"]
    input_tokens = usage["prompt_tokens"]
    output_tokens = usage["completion_tokens"]
    output = {
        "模型": result["model"],
        "模型原始输出": result["choices"][0]["message"]["content"],
        "输入 token": input_tokens,
        "输出 token": output_tokens,
        "总 token": usage["total_tokens"],
        "接口耗时（秒）": round(elapsed, 3),
    }
    if args.price_usd:
        input_price, output_price = args.price_usd
        output["估算费用（美元）"] = round((input_tokens * input_price + output_tokens * output_price) / 1_000_000, 9)
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
