"""模型查询服务。"""

from typing import List

from ..utils.openai_util import OpenAIUtil


class ModelService:
    """负责读取可用模型列表。"""

    def __init__(self, ai: OpenAIUtil | None = None):
        self.ai = ai or OpenAIUtil()

    async def get_available_models(self) -> List[str]:
        """获取可用模型列表。"""
        return await self.ai.get_available_models()
