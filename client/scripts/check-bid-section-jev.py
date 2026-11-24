# Jev 标段识别测试：在仓库根目录的 .env.test 配置 JEV_API_KEY、JEV_API_URL、JEV_MODEL_NAME。
# 在仓库根目录运行，默认使用 testfiles/jev-tender.md：
# python -X utf8 client/scripts/check-bid-section-jev.py
# 指定自己的 Markdown 或 Word 文件（Word 需要 Node 和已安装的客户端依赖）：
# python -X utf8 client/scripts/check-bid-section-jev.py --file ".\testfiles\jev-tender.docx"
# 文件超出默认上下文时可追加 --long-context。

import argparse
import json
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from test_model_config import read_test_model
from test_tender_input import add_tender_arguments, read_tender_markdown


# 用 Jev 对完整招标原文做一次标段判断，记录接口耗时和用量。
def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="测试 Jev 识别招标文件单标段或多标段")
    add_tender_arguments(parser, root)
    parser.add_argument("--long-context", action="store_true", help="启用 TypeSafe 长上下文模式")
    args = parser.parse_args()

    api_key, api_url, model = read_test_model(root, "JEV", "API_URL")
    payload = {
        "model": model,
        "state": read_tender_markdown(args.file or args.markdown, root),
        "questions": {
            "multiple_bid_sections": {
                "type": "noul",
                "instructions": "本次招标项目是否实际划分为两个或以上独立的投标范围？",
                "criteria": {
                    "true": "原文明确划分出至少两个可分别投标或分别评审、授标的标段、标包、采购包、包件或标的。",
                    "false": "本次只有一个或未划分独立投标范围。章节、采购明细、同一标段的重复提及，以及仅在通用条款或模板中提到多个标段，均不算实际划分。",
                },
            },
        },
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    if args.long_context:
        headers["TypeSafe-Danger-Zone-Long-Context"] = "true"
    request = Request(
        api_url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    started = time.perf_counter()
    try:
        with urlopen(request, timeout=300) as response:
            body = response.read()
    except HTTPError as error:
        raise SystemExit(f"TypeSafe HTTP {error.code}: {error.read().decode('utf-8')}") from error
    elapsed = time.perf_counter() - started

    result = json.loads(body)
    answers = result["answers"]
    probability = answers["multiple_bid_sections"]["noul"]
    usage = result["usage"]
    input_tokens = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    # TypeSafe 公布的 Jev 价格：每百万输入 token 0.042 美元，输出免费。
    cost_usd = round(input_tokens * 0.042 / 1_000_000, 9) if input_tokens is not None else None
    print(json.dumps({
        "模型": result["model"],
        "判定": "多标段" if probability >= 0.5 else "单标段",
        "多标段概率": probability,
        "模型原始输出": answers,
        "输入 token": input_tokens,
        "输出 token": output_tokens,
        "总 token": input_tokens + output_tokens if None not in (input_tokens, output_tokens) else None,
        "估算费用（美元）": cost_usd,
        "接口耗时（秒）": round(elapsed, 3),
        "长上下文": args.long_context,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
