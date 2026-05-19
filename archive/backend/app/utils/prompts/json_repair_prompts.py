"""JSON 修复相关提示词。"""

from typing import Dict, List


def build_json_repair_messages(
    invalid_content: str,
    issues: list[str],
    target_description: str,
) -> List[Dict[str, str]]:
    """构建 JSON 定向修复消息。"""
    issue_lines = [f"{index}. {item}" for index, item in enumerate(issues, start=1)]

    system_prompt = """你是一个严格的 JSON 修复助手。请根据给出的原始内容和校验问题，修复现有结果。

要求：
1. 优先在原结果基础上做最小必要修改，不要整体重写
2. 尽量保留原有结构、字段值、节点顺序和已生成内容
3. 若缺少必填字段，应结合现有上下文补齐合理内容，不要用空字符串敷衍
4. 若存在多余说明、代码块包裹、字段名错误、children 结构不规范或顶层包裹错误，应修正为合法 JSON
5. 只返回修复后的完整 JSON，不要输出任何解释
"""

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"目标结果类型：{target_description}"},
        {"role": "user", "content": "当前校验问题：\n" + "\n".join(issue_lines)},
        {
            "role": "user",
            "content": f"待修复内容：\n```json\n{invalid_content}\n```",
        },
        {
            "role": "user",
            "content": "请在保留原有正确内容的前提下，仅修复上述问题，并返回完整 JSON。",
        },
    ]
