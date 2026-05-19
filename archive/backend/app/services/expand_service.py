"""标书扩写服务。"""

from typing import Any, Dict

from ..models.schemas import OutlineResponse
from ..utils.openai_util import OpenAIUtil
from ..utils.prompts.expand_prompts import build_expand_outline_messages


class ExpandService:
    """负责从已有技术方案中提取旧目录。"""

    def __init__(self, ai: OpenAIUtil | None = None):
        self.ai = ai or OpenAIUtil()

    async def generate_expand_outline(self, file_content: str) -> Dict[str, Any]:
        """从已有技术方案中提取目录结构。"""
        return await self.ai.collect_json_response(
            messages=build_expand_outline_messages(file_content),
            temperature=0.7,
            schema=OutlineResponse,
        )
