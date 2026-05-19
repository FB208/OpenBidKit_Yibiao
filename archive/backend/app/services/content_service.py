"""正文生成服务。"""

from typing import Any, AsyncGenerator

from ..utils.openai_util import OpenAIUtil
from ..utils.prompts.content_prompts import build_chapter_content_messages


class ContentService:
    """负责目录叶子章节的正文生成。"""

    def __init__(self, ai: OpenAIUtil | None = None):
        self.ai = ai or OpenAIUtil()

    async def stream_chapter_content(
        self,
        chapter: dict[str, Any],
        parent_chapters: list[dict[str, Any]] | None = None,
        sibling_chapters: list[dict[str, Any]] | None = None,
        project_overview: str = "",
    ) -> AsyncGenerator[str, None]:
        """流式生成单章节内容。"""
        messages = build_chapter_content_messages(
            chapter=chapter,
            parent_chapters=parent_chapters,
            sibling_chapters=sibling_chapters,
            project_overview=project_overview,
        )
        async for chunk in self.ai.stream_chat_completion(messages, temperature=0.7):
            yield chunk

    async def generate_chapter_content(
        self,
        chapter: dict[str, Any],
        parent_chapters: list[dict[str, Any]] | None = None,
        sibling_chapters: list[dict[str, Any]] | None = None,
        project_overview: str = "",
    ) -> str:
        """生成单章节完整正文。"""
        return await self.ai.collect_chat_completion(
            build_chapter_content_messages(
                chapter=chapter,
                parent_chapters=parent_chapters,
                sibling_chapters=sibling_chapters,
                project_overview=project_overview,
            ),
            temperature=0.7,
        )
