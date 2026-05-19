"""扩写目录提取相关提示词。"""

from typing import Dict, List


def read_expand_outline_prompt() -> str:
    """从简版技术方案中提取目录的系统提示词。"""
    return """你是一个专业的标书编写专家。请严格基于用户提交的标书技术方案原文完成目录提取任务。

要求：
1. 目录结构要全面覆盖技术标的所有必要目录，包含多级目录
2. 如果技术方案中有章节名称，则直接使用技术方案中的章节名称
3. 如果技术方案中没有章节名称，则结合全文，总结出章节名称
4. 返回标准 JSON 格式，包含章节编号、标题、描述和子章节，注意编号要连贯
5. 除了 JSON 结果外，不要输出任何其他内容

JSON 格式要求：
{
  "outline": [
    {
      "id": "1",
      "title": "",
      "description": "",
      "children": [
        {
          "id": "1.1",
          "title": "",
          "description": "",
          "children": [
            {
              "id": "1.1.1",
              "title": "",
              "description": ""
            }
          ]
        }
      ]
    }
  ]
}
"""


def build_expand_outline_messages(file_content: str) -> List[Dict[str, str]]:
    """构建方案扩写目录提取消息。"""
    return [
        {"role": "system", "content": read_expand_outline_prompt()},
        {
            "role": "user",
            "content": f"以下是完整技术方案全文，请先完整阅读，并仅基于原文完成后续任务：\n\n{file_content}",
        },
        {
            "role": "user",
            "content": "请从上述技术方案中提取完整目录结构，确保覆盖技术标的所有必要目录，并按要求返回标准 JSON。",
        },
    ]
