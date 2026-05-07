"""正文生成相关提示词。"""

from typing import Any, Dict, List


def build_chapter_content_messages(
    chapter: Dict[str, Any],
    parent_chapters: List[Dict[str, Any]] | None = None,
    sibling_chapters: List[Dict[str, Any]] | None = None,
    project_overview: str = "",
) -> List[Dict[str, str]]:
    """构建章节正文生成消息。"""
    chapter_id = chapter.get("id", "unknown")
    chapter_title = chapter.get("title", "未命名章节")
    chapter_description = chapter.get("description", "")

    system_prompt = """你是一个专业的标书编写专家，负责为投标文件的技术标部分生成具体内容。

要求：
1. 内容要专业、准确，与章节标题和描述保持一致。
2. 这是技术方案，不是宣传报告，注意朴实无华，不要假大空。
3. 语言要正式、规范，符合标书写作要求，但不要使用奇怪的连接词，不要让人觉得内容像是 AI 生成的。
4. 内容要详细具体，避免空泛的描述。
5. 注意避免与同级章节内容重复，保持内容的独特性和互补性。
6. 直接返回章节内容，不生成标题，不要任何额外说明或格式标记。
"""

    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]

    if project_overview.strip():
        messages.append(
            {"role": "user", "content": f"项目概述信息：\n{project_overview}"}
        )

    if parent_chapters:
        parent_lines = ["上级章节信息："]
        for parent in parent_chapters:
            parent_lines.append(
                f"- {parent.get('id', 'unknown')} {parent.get('title', '未命名章节')}\n  {parent.get('description', '')}"
            )
        messages.append({"role": "user", "content": "\n".join(parent_lines)})

    if sibling_chapters:
        sibling_lines = ["同级章节信息（请避免内容重复）："]
        for sibling in sibling_chapters:
            if sibling.get("id") == chapter_id:
                continue
            sibling_lines.append(
                f"- {sibling.get('id', 'unknown')} {sibling.get('title', '未命名章节')}\n  {sibling.get('description', '')}"
            )
        if len(sibling_lines) > 1:
            messages.append({"role": "user", "content": "\n".join(sibling_lines)})

    messages.append(
        {
            "role": "user",
            "content": f"""请为以下标书章节生成具体内容：

当前章节信息：
章节ID: {chapter_id}
章节标题: {chapter_title}
章节描述: {chapter_description}

请根据项目概述信息和上述章节层级关系，生成详细的专业内容，确保与上级章节的内容逻辑相承，同时避免与同级章节内容重复，突出本章节的独特性和技术方案优势。
正文中不要重复章节标题。
直接返回编写的正文内容，不要输出标题、解释、总结等任何其他内容""",
        }
    )

    return messages
