"""目录生成相关提示词。"""

from typing import Any, Dict, List


def _build_outline_system_prompt() -> str:
    """构建目录生成的共享系统提示词。"""
    return """你是一个专业的标书编写专家。根据提供的项目概述和技术评分要求，生成投标文件中技术标部分的目录结构。
如果用户提供了自己编写的目录，你要保证目录满足技术评分要求，并充分结合用户自己编写的目录。

要求：
1. 目录结构要全面覆盖技术标的所有必要章节
2. 章节名称要专业、准确，符合投标文件规范
3. 一级目录名称要与技术评分要求中的章节名称一致；如果技术评分要求中没有明确章节名称，则结合内容总结一级目录名称
4. 一共包括三级目录
5. 返回标准 JSON 格式，包含章节编号、标题、描述和子章节
6. 除了 JSON 结果外，不要输出任何其他内容

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


def _build_top_level_outline_system_prompt() -> str:
    """构建仅生成一级目录的系统提示词。"""
    return """你是一个专业的标书编写专家。根据提供的项目概述和技术评分要求，生成投标文件中技术标部分的一级目录结构。
如果用户提供了自己编写的目录，你要保证一级目录满足技术评分要求，并充分结合用户自己编写的目录。

要求：
1. 只生成一级目录，不要生成二级和三级目录
2. 一级目录名称要专业、准确，符合投标文件规范
3. 一级目录名称要尽量与技术评分要求中的章节名称一致；如果技术评分要求中没有明确章节名称，则结合内容总结一级目录名称
4. 返回标准 JSON 格式，使用 outline 字段，每个一级目录必须包含 id、title、description
5. 除了 JSON 结果外，不要输出任何其他内容

JSON 格式要求：
{
  "outline": [
    {
      "id": "1",
      "title": "",
      "description": ""
    }
  ]
}
"""


def _format_revision_suggestions(suggestions: list[str] | None) -> str:
    """格式化目录修正建议。"""
    if not suggestions:
        return ""

    suggestion_lines = [
        f"{index}. {item}" for index, item in enumerate(suggestions, start=1)
    ]
    return "\n\n本轮修正建议：\n" + "\n".join(suggestion_lines)


def generate_outline_prompt(
    overview: str,
    requirements: str,
    suggestions: list[str] | None = None,
) -> List[Dict[str, str]]:
    """生成标准目录的提示词。"""
    return [
        {"role": "system", "content": _build_outline_system_prompt()},
        {"role": "user", "content": f"项目概述：\n{overview}"},
        {"role": "user", "content": f"技术评分要求：\n{requirements}"},
        {
            "role": "user",
            "content": "请生成完整的技术标目录结构，确保覆盖所有技术评分要点。"
            + _format_revision_suggestions(suggestions),
        },
    ]


def generate_outline_with_old_prompt(
    overview: str,
    requirements: str,
    old_outline: str | None,
    suggestions: list[str] | None = None,
) -> List[Dict[str, str]]:
    """生成基于旧目录扩写的提示词。"""
    return [
        {"role": "system", "content": _build_outline_system_prompt()},
        {"role": "user", "content": f"项目概述：\n{overview}"},
        {"role": "user", "content": f"技术评分要求：\n{requirements}"},
        {"role": "user", "content": f"用户自己编写的目录：\n{old_outline or ''}"},
        {
            "role": "user",
            "content": "请在满足技术评分要求的前提下，充分结合用户自己编写的目录，生成完整的技术标目录结构。"
            + _format_revision_suggestions(suggestions),
        },
    ]


def generate_top_level_outline_prompt(
    overview: str,
    requirements: str,
    suggestions: list[str] | None = None,
) -> List[Dict[str, str]]:
    """生成仅包含一级目录的提示词。"""
    return [
        {"role": "system", "content": _build_top_level_outline_system_prompt()},
        {"role": "user", "content": f"项目概述：\n{overview}"},
        {"role": "user", "content": f"技术评分要求：\n{requirements}"},
        {
            "role": "user",
            "content": "请仅生成一级目录列表，不要生成二级和三级目录。返回的 JSON 仍然使用 outline 字段，每个一级目录都必须包含 id、title、description。"
            + _format_revision_suggestions(suggestions),
        },
    ]


def generate_top_level_outline_with_old_prompt(
    overview: str,
    requirements: str,
    old_outline: str | None,
    suggestions: list[str] | None = None,
) -> List[Dict[str, str]]:
    """生成结合旧目录的一级目录提示词。"""
    return [
        {"role": "system", "content": _build_top_level_outline_system_prompt()},
        {"role": "user", "content": f"项目概述：\n{overview}"},
        {"role": "user", "content": f"技术评分要求：\n{requirements}"},
        {"role": "user", "content": f"用户自己编写的目录：\n{old_outline or ''}"},
        {
            "role": "user",
            "content": "请在满足技术评分要求的前提下，充分结合用户自己编写的目录，仅生成一级目录，不要生成二级和三级目录。返回的 JSON 使用 outline 字段，每个一级目录都必须包含 id、title、description。"
            + _format_revision_suggestions(suggestions),
        },
    ]


def extract_requirement_groups_messages(
    requirements: str,
    suggestions: list[str] | None = None,
) -> List[Dict[str, str]]:
    """提取适合作为一级目录的技术评分大类。"""
    system_prompt = """你是一个专业的招标文件分析专家。请从技术评分要求中提取适合作为技术标一级目录的评分大类。

要求：
1. 只提取技术评分大类，不要提取商务、报价、资质、售后服务等非技术类条目
2. 每个大类都必须适合作为技术标一级目录标题，标题要专业、简洁、完整
3. 同一大类下的细项、子项、分值说明、评分标准要归入 detail_points，不要拆成多个一级目录
4. requirement_id 必须唯一，使用 R1、R2、R3 这种格式
5. description 需要概括该大类关注的核心内容
6. detail_points 中保留该大类下的关键评分细项，使用简洁短句
7. 只返回 JSON，格式必须为 {"groups": [...]}，不要输出任何其他内容

JSON 格式要求：
{
  "groups": [
    {
      "requirement_id": "R1",
      "title": "",
      "description": "",
      "detail_points": ["", ""]
    }
  ]
}
"""

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"技术评分要求：\n{requirements}"},
        {
            "role": "user",
            "content": "请提取所有适合作为技术标一级目录的技术评分大类，保持顺序稳定，并把每个大类下的评分细项归入 detail_points。"
            + _format_revision_suggestions(suggestions),
        },
    ]


def generate_aligned_children_outline_prompt(
    overview: str,
    requirements: str,
    parent_item: Dict[str, Any],
    requirement_group: Dict[str, Any],
    suggestions: list[str] | None = None,
) -> List[Dict[str, str]]:
    """围绕指定技术评分大类生成二三级目录。"""
    parent_id = parent_item.get("id", "1")
    parent_title = parent_item.get("title", "未命名一级目录")
    parent_description = parent_item.get("description", "")
    requirement_id = requirement_group.get("requirement_id", "R1")
    detail_points = requirement_group.get("detail_points") or []
    detail_lines = "\n".join(
        f"- {item}" for item in detail_points if isinstance(item, str) and item.strip()
    )

    system_prompt = """你是一个专业的标书编写专家。请围绕指定的技术评分大类，为已经固定好的一级目录生成二级和三级目录。

要求：
1. 一级目录标题和顺序已经固定，不能修改、重命名、合并或删除一级目录
2. 只输出当前一级目录下的二级和三级目录，不要重复输出一级目录本身
3. 二级和三级目录要覆盖当前技术评分大类及其细项，不能越界写入其他评分大类内容
4. 返回标准 JSON，格式为 {"children": [...]}，children 中只能包含当前一级目录的直接子目录
5. 每个节点必须包含 id、title、description，三级目录继续使用 children 字段
6. 章节编号必须以给定的一级目录编号为前缀，例如父级是 2，则二级目录编号从 2.1 开始，三级目录编号从 2.1.1 开始
7. 除了 JSON 结果外，不要输出任何其他内容
"""

    detail_content = detail_lines or "- 未提供明确细项，请根据评分大类描述合理展开"

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"项目概述：\n{overview}"},
        {"role": "user", "content": f"技术评分要求原文：\n{requirements}"},
        {
            "role": "user",
            "content": f"当前固定一级目录：\n编号：{parent_id}\n标题：{parent_title}\n描述：{parent_description}",
        },
        {
            "role": "user",
            "content": f"当前对应的技术评分大类：\nrequirement_id：{requirement_id}\n标题：{requirement_group.get('title', '')}\n描述：{requirement_group.get('description', '')}\n细项：\n{detail_content}",
        },
        {
            "role": "user",
            "content": '请仅生成该一级目录下的二级、三级目录，一级目录标题必须保持为当前给定标题，返回格式必须是 {"children": [...]}。'
            + _format_revision_suggestions(suggestions),
        },
    ]


def generate_aligned_children_outline_with_old_prompt(
    overview: str,
    requirements: str,
    parent_item: Dict[str, Any],
    requirement_group: Dict[str, Any],
    old_outline: str | None,
    suggestions: list[str] | None = None,
) -> List[Dict[str, str]]:
    """结合旧目录参考，为指定评分大类生成二三级目录。"""
    messages = generate_aligned_children_outline_prompt(
        overview=overview,
        requirements=requirements,
        parent_item=parent_item,
        requirement_group=requirement_group,
        suggestions=suggestions,
    )
    messages.insert(
        5, {"role": "user", "content": f"用户自己编写的目录参考：\n{old_outline or ''}"}
    )
    messages[-1] = {
        "role": "user",
        "content": '请在覆盖当前技术评分大类细项的前提下，参考用户目录优化当前一级目录下的二级、三级目录，但不得修改当前一级目录标题，返回格式必须是 {"children": [...]}。'
        + _format_revision_suggestions(suggestions),
    }
    return messages


def generate_children_outline_prompt(
    overview: str,
    requirements: str,
    parent_item: Dict[str, Any],
    suggestions: list[str] | None = None,
) -> List[Dict[str, str]]:
    """为指定一级目录生成二三级目录。"""
    parent_id = parent_item.get("id", "1")
    parent_title = parent_item.get("title", "未命名一级目录")
    parent_description = parent_item.get("description", "")

    system_prompt = """你是一个专业的标书编写专家。请围绕指定的一级目录，生成其下属的二级目录和三级目录。

要求：
1. 只输出当前一级目录下的二级和三级目录，不要重复输出一级目录本身
2. 返回标准 JSON，格式为 {"children": [...]} 
3. children 中只能包含当前一级目录的直接子目录，每个节点必须包含 id、title、description
4. 二级目录下如有三级目录，同样使用 children 字段
5. 章节编号必须以给定的一级目录编号为前缀，例如父级是 2，则二级目录编号从 2.1 开始，三级目录编号从 2.1.1 开始
6. 除了 JSON 结果外，不要输出任何其他内容
"""

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"项目概述：\n{overview}"},
        {"role": "user", "content": f"技术评分要求：\n{requirements}"},
        {
            "role": "user",
            "content": f"当前一级目录：\n编号：{parent_id}\n标题：{parent_title}\n描述：{parent_description}",
        },
        {
            "role": "user",
            "content": '请仅生成该一级目录下的二级、三级目录，返回格式必须是 {"children": [...]}。'
            + _format_revision_suggestions(suggestions),
        },
    ]


def generate_children_outline_with_old_prompt(
    overview: str,
    requirements: str,
    parent_item: Dict[str, Any],
    old_outline: str | None,
    suggestions: list[str] | None = None,
) -> List[Dict[str, str]]:
    """为指定一级目录生成二三级目录，并结合旧目录参考。"""
    messages = generate_children_outline_prompt(
        overview=overview,
        requirements=requirements,
        parent_item=parent_item,
        suggestions=suggestions,
    )
    messages.insert(
        4, {"role": "user", "content": f"用户自己编写的目录：\n{old_outline or ''}"}
    )
    messages[-1] = {
        "role": "user",
        "content": '请在满足技术评分要求的前提下，充分结合用户自己编写的目录，仅生成该一级目录下的二级、三级目录，返回格式必须是 {"children": [...]}。'
        + _format_revision_suggestions(suggestions),
    }
    return messages


def review_outline_messages(
    overview: str,
    requirements: str,
    outline_json: str,
) -> List[Dict[str, str]]:
    """构建目录审核消息。"""
    system_prompt = """你是一个严格的招标文件目录审核专家。请审核目录是否符合项目概述和技术评分要求。

要求：
1. 重点检查目录是否完整覆盖技术评分要点
2. 检查一级目录名称是否专业、准确，是否尽量与评分项原文保持一致
3. 检查目录层级是否清晰，是否达到三级目录要求，是否存在明显遗漏、错位、重复或不合理章节
4. 只返回 JSON，格式为：{"passed": true, "suggestions": []}
5. 若不通过，suggestions 中必须给出具体、可执行的修改建议
6. 除了 JSON 外，不要输出任何其他内容
"""

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"项目概述：\n{overview}"},
        {"role": "user", "content": f"技术评分要求：\n{requirements}"},
        {"role": "user", "content": f"待审核目录 JSON：\n{outline_json}"},
        {
            "role": "user",
            "content": "请判断该目录是否满足要求。若满足则返回 passed=true；若不满足则返回 passed=false，并给出具体修改建议。",
        },
    ]


def review_aligned_outline_messages(
    overview: str,
    requirements: str,
    groups_json: str,
    outline_json: str,
) -> List[Dict[str, str]]:
    """构建一一对应模式的目录审核消息。"""
    system_prompt = """你是一个严格的招标文件目录审核专家。请审核目录是否与技术评分大类一一对应，并判断二三级目录是否覆盖各评分大类的细项。

要求：
1. 一级目录必须与提供的技术评分大类一一对应，数量一致、顺序一致、标题必须完全一致
2. 不允许缺失技术评分大类，也不允许新增、合并、改写一级目录
3. 二级和三级目录要围绕各自对应的技术评分大类与细项展开，避免错位、遗漏和明显重复
4. 检查完整目录是否层级清晰，整体是否达到三级目录要求
5. 只返回 JSON，格式为：{"passed": true, "suggestions": []}
6. 若不通过，suggestions 中必须给出具体、可执行的修改建议，重点说明哪个评分大类覆盖不足或结构不合理
7. 除了 JSON 外，不要输出任何其他内容
"""

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"项目概述：\n{overview}"},
        {"role": "user", "content": f"技术评分要求：\n{requirements}"},
        {"role": "user", "content": f"技术评分大类 JSON：\n{groups_json}"},
        {"role": "user", "content": f"待审核目录 JSON：\n{outline_json}"},
        {
            "role": "user",
            "content": "请判断该目录是否满足一一对应要求。若满足则返回 passed=true；若不满足则返回 passed=false，并给出具体修改建议。",
        },
    ]
