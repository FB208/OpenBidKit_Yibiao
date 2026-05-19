"""标书解析服务。"""

from typing import AsyncGenerator

from ..utils.openai_util import OpenAIUtil
from ..utils.prompts.analysis_prompts import build_analysis_messages


class AnalysisService:
    """负责标书解析与文档分析。"""

    def __init__(self, ai: OpenAIUtil | None = None):
        self.ai = ai or OpenAIUtil()

    async def stream_document_analysis(
        self,
        file_content: str,
        analysis_type: str,
    ) -> AsyncGenerator[str, None]:
        """流式分析文档内容。"""
        messages = build_analysis_messages(file_content, analysis_type)
        async for chunk in self.ai.stream_chat_completion(messages, temperature=0.3):
            yield chunk

    async def stream_chat_completion(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.7,
        response_format: dict | None = None,
    ) -> AsyncGenerator[str, None]:
        """兼容直接透传底层聊天接口。"""
        async for chunk in self.ai.stream_chat_completion(
            messages,
            temperature=temperature,
            response_format=response_format,
        ):
            yield chunk
