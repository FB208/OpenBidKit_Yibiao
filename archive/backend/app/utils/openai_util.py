"""OpenAI 调用公共工具。"""

import json
import logging
import uuid
from typing import Any, AsyncGenerator, Awaitable, Callable, Dict, List

import openai
from pydantic import BaseModel, ValidationError

from ..config import settings
from ..utils.config_manager import config_manager
from ..utils.errors import AppError
from .prompts.json_repair_prompts import build_json_repair_messages

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[str], Awaitable[None]]
JsonValidator = Callable[[Dict[str, Any]], None]


class OpenAIUtil:
    """封装 OpenAI SDK 调用、日志与 JSON 修复能力。"""

    def __init__(self):
        config = config_manager.load_config()
        self.api_key = config.get("api_key", "")
        self.base_url = config.get("base_url", "")
        self.model_name = config.get("model_name", "gpt-3.5-turbo")
        if not self.api_key:
            raise AppError("请先配置OpenAI API密钥", status_code=400)
        self.client = openai.AsyncOpenAI(
            api_key=self.api_key,
            base_url=self.base_url or None,
        )

    def _chat_endpoint_url(self) -> str:
        """获取聊天完成接口地址。"""
        base_url = (self.base_url or "https://api.openai.com/v1").rstrip("/")
        return f"{base_url}/chat/completions"

    def _log_ai_request(
        self,
        request_id: str,
        messages: list[dict[str, str]],
        temperature: float,
        response_format: dict | None,
    ) -> None:
        """记录 AI 请求日志。"""
        if not settings.enable_file_logging:
            return

        logger.debug(
            "AI_REQUEST %s",
            json.dumps(
                {
                    "request_id": request_id,
                    "url": self._chat_endpoint_url(),
                    "model": self.model_name,
                    "temperature": temperature,
                    "response_format": response_format,
                    "messages": messages,
                },
                ensure_ascii=False,
            ),
        )

    def _log_ai_response(self, request_id: str, content: str) -> None:
        """记录 AI 响应日志。"""
        if not settings.enable_file_logging:
            return

        logger.debug(
            "AI_RESPONSE %s",
            json.dumps(
                {
                    "request_id": request_id,
                    "url": self._chat_endpoint_url(),
                    "model": self.model_name,
                    "content": content,
                },
                ensure_ascii=False,
            ),
        )

    def _log_ai_raw_response(
        self,
        request_id: str,
        raw_chunks: list[dict[str, Any]],
        content: str,
    ) -> None:
        """记录 AI 接口原始响应日志。"""
        if not settings.enable_file_logging:
            return

        logger.debug(
            "AI_RAW_RESPONSE %s",
            json.dumps(
                {
                    "request_id": request_id,
                    "url": self._chat_endpoint_url(),
                    "model": self.model_name,
                    "raw_chunks": raw_chunks,
                    "content": content,
                },
                ensure_ascii=False,
                default=str,
            ),
        )

    def _log_ai_error(
        self,
        request_id: str,
        messages: list[dict[str, str]],
        temperature: float,
        response_format: dict | None,
        partial_content: str,
        raw_chunks: list[dict[str, Any]],
        error: Exception,
    ) -> None:
        """记录 AI 异常日志。"""
        if not settings.enable_file_logging:
            return

        logger.debug(
            "AI_ERROR %s",
            json.dumps(
                {
                    "request_id": request_id,
                    "url": self._chat_endpoint_url(),
                    "model": self.model_name,
                    "temperature": temperature,
                    "response_format": response_format,
                    "messages": messages,
                    "partial_content": partial_content,
                    "raw_chunks": raw_chunks,
                    "error": str(error),
                },
                ensure_ascii=False,
                default=str,
            ),
        )

    @staticmethod
    def _dump_chunk(chunk: Any) -> dict[str, Any]:
        """序列化 OpenAI SDK 返回的 chunk。"""
        if hasattr(chunk, "model_dump"):
            return chunk.model_dump(mode="json")
        return {"raw": str(chunk)}

    @staticmethod
    def _extract_json_content(content: str) -> str:
        """提取模型响应中的 JSON 内容，兼容 Markdown 代码块包裹。"""
        normalized = content.strip()
        if not normalized.startswith("```"):
            return normalized

        lines = normalized.splitlines()
        if not lines:
            return normalized

        first_line = lines[0].strip().lower()
        last_line = lines[-1].strip()
        if not last_line.startswith("```"):
            return normalized

        if first_line in {"```", "```json", "```javascript", "```js"}:
            return "\n".join(lines[1:-1]).strip()

        return normalized

    @staticmethod
    def _is_response_format_unsupported_error(message: str) -> bool:
        """判断当前错误是否表示模型不支持 response_format。"""
        normalized = message.lower()
        if "response_format" not in normalized:
            return False

        return any(
            marker in normalized
            for marker in (
                "not supported",
                "does not support",
                "not support",
                "unsupported",
                "unknown parameter",
                "invalid parameter",
            )
        )

    @staticmethod
    async def emit_progress(
        progress_callback: ProgressCallback | None,
        message: str,
    ) -> None:
        """发送进度消息。"""
        if progress_callback is None:
            return

        await progress_callback(message)

    async def get_available_models(self) -> List[str]:
        """获取可用模型列表。"""
        try:
            models = await self.client.models.list()
        except Exception as exc:
            raise AppError(f"获取模型列表失败: {exc}", status_code=502) from exc

        chat_models: list[str] = []
        for model in models.data:
            model_id = model.id.lower()
            if any(
                keyword in model_id
                for keyword in ["gpt", "claude", "chat", "llama", "qwen", "deepseek"]
            ):
                chat_models.append(model.id)
        return sorted(set(chat_models))

    async def stream_chat_completion(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.7,
        response_format: dict | None = None,
    ) -> AsyncGenerator[str, None]:
        """流式调用聊天完成接口。"""
        request_id = uuid.uuid4().hex
        parts: list[str] = []
        raw_chunks: list[dict[str, Any]] = []
        self._log_ai_request(request_id, messages, temperature, response_format)

        try:
            stream = await self.client.chat.completions.create(
                model=self.model_name,
                messages=messages,
                temperature=temperature,
                stream=True,
                **(
                    {"response_format": response_format}
                    if response_format is not None
                    else {}
                ),
            )
        except Exception as exc:
            self._log_ai_error(
                request_id,
                messages,
                temperature,
                response_format,
                "",
                raw_chunks,
                exc,
            )
            raise AppError(f"模型调用失败: {exc}", status_code=502) from exc

        try:
            async for chunk in stream:
                raw_chunks.append(self._dump_chunk(chunk))
                if not chunk.choices:
                    continue
                content = chunk.choices[0].delta.content
                if content is not None:
                    parts.append(content)
                    yield content
        except Exception as exc:
            self._log_ai_error(
                request_id,
                messages,
                temperature,
                response_format,
                "".join(parts),
                raw_chunks,
                exc,
            )
            raise AppError(f"模型调用失败: {exc}", status_code=502) from exc

        self._log_ai_response(request_id, "".join(parts))
        self._log_ai_raw_response(request_id, raw_chunks, "".join(parts))

    async def collect_chat_completion(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.7,
        response_format: dict | None = None,
    ) -> str:
        """收集流式输出并拼接为完整文本。"""
        parts: list[str] = []
        async for chunk in self.stream_chat_completion(
            messages,
            temperature=temperature,
            response_format=response_format,
        ):
            parts.append(chunk)
        return "".join(parts)

    async def _collect_chat_completion_with_json_mode_fallback(
        self,
        messages: list[dict[str, str]],
        temperature: float,
        use_response_format: bool,
        progress_callback: ProgressCallback | None = None,
    ) -> tuple[str, bool]:
        """优先使用 JSON 模式请求，不支持时自动降级为普通请求。"""
        try:
            content = await self.collect_chat_completion(
                messages,
                temperature=temperature,
                response_format={"type": "json_object"}
                if use_response_format
                else None,
            )
            return content, use_response_format
        except AppError as exc:
            if (
                not use_response_format
                or not self._is_response_format_unsupported_error(exc.message)
            ):
                raise

            await self.emit_progress(
                progress_callback,
                "当前模型不支持结构化 JSON 响应，已降级为普通请求解析。",
            )
            content = await self.collect_chat_completion(
                messages,
                temperature=temperature,
                response_format=None,
            )
            return content, False

    @staticmethod
    def _normalize_json_response(
        content: str,
        schema: type[BaseModel] | None = None,
        validator: JsonValidator | None = None,
    ) -> Dict[str, Any]:
        """解析、校验并标准化 JSON 响应。"""
        json_content = OpenAIUtil._extract_json_content(content)
        parsed = json.loads(json_content)

        if schema is None:
            normalized = parsed
        else:
            validated = schema.model_validate(parsed)
            normalized = validated.model_dump(exclude_none=True)

        if validator is not None:
            validator(normalized)

        return normalized

    @staticmethod
    def _format_json_issues(error: Exception) -> list[str]:
        """格式化 JSON 解析或校验问题。"""
        if isinstance(error, json.JSONDecodeError):
            return [
                f"JSON 语法错误：第 {error.lineno} 行第 {error.colno} 列附近 {error.msg}。"
            ]

        if isinstance(error, ValidationError):
            issues: list[str] = []
            for item in error.errors():
                location = ".".join(str(part) for part in item.get("loc", [])) or "root"
                message = item.get("msg", "字段校验失败")
                issues.append(f"{location}: {message}")
            return issues or [str(error)]

        return [str(error)]

    async def _repair_json_response(
        self,
        invalid_content: str,
        issues: list[str],
        temperature: float,
        use_response_format: bool,
        progress_callback: ProgressCallback | None,
        progress_label: str,
    ) -> tuple[str, bool]:
        """基于当前结果发起一次定向 JSON 修复。"""
        await self.emit_progress(
            progress_callback,
            f"{progress_label}格式校验失败，正在基于当前结果进行修复。",
        )
        repair_messages = build_json_repair_messages(
            invalid_content=invalid_content,
            issues=issues,
            target_description=progress_label,
        )
        return await self._collect_chat_completion_with_json_mode_fallback(
            messages=repair_messages,
            temperature=temperature,
            use_response_format=use_response_format,
            progress_callback=progress_callback,
        )

    async def collect_json_response(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.7,
        schema: type[BaseModel] | None = None,
        validator: JsonValidator | None = None,
        progress_callback: ProgressCallback | None = None,
        progress_label: str = "JSON结果",
        failure_message: str = "模型返回的 JSON 数据格式无效",
    ) -> Dict[str, Any]:
        """收集并校验 JSON 响应。"""
        max_retries = 2
        total_attempts = max_retries + 1
        use_response_format = True

        for attempt in range(total_attempts):
            try:
                (
                    content,
                    use_response_format,
                ) = await self._collect_chat_completion_with_json_mode_fallback(
                    messages=messages,
                    temperature=temperature,
                    use_response_format=use_response_format,
                    progress_callback=progress_callback,
                )
                normalized = self._normalize_json_response(
                    content,
                    schema=schema,
                    validator=validator,
                )
                return normalized
            except (json.JSONDecodeError, ValidationError, ValueError) as exc:
                issues = self._format_json_issues(exc)
                logger.warning(
                    "模型返回非法 JSON，第 %s/%s 次尝试: %s；问题: %s",
                    attempt + 1,
                    total_attempts,
                    content,
                    " | ".join(issues),
                )

                try:
                    (
                        repaired_content,
                        use_response_format,
                    ) = await self._repair_json_response(
                        invalid_content=content,
                        issues=issues,
                        temperature=temperature,
                        use_response_format=use_response_format,
                        progress_callback=progress_callback,
                        progress_label=progress_label,
                    )
                    normalized = self._normalize_json_response(
                        repaired_content,
                        schema=schema,
                        validator=validator,
                    )
                    return normalized
                except AppError as repair_error:
                    logger.warning(
                        "JSON 修复请求失败，第 %s/%s 次尝试: %s",
                        attempt + 1,
                        total_attempts,
                        repair_error.message,
                    )
                    exc = repair_error
                except (
                    json.JSONDecodeError,
                    ValidationError,
                    ValueError,
                ) as repair_error:
                    logger.warning(
                        "JSON 修复后仍校验失败，第 %s/%s 次尝试: %s；问题: %s",
                        attempt + 1,
                        total_attempts,
                        repaired_content,
                        " | ".join(self._format_json_issues(repair_error)),
                    )
                    exc = repair_error

                if attempt == max_retries:
                    await self.emit_progress(
                        progress_callback,
                        f"{progress_label}连续 {total_attempts} 次校验失败。",
                    )
                    raise AppError(failure_message, status_code=502) from exc

                await self.emit_progress(
                    progress_callback,
                    f"{progress_label}第 {attempt + 1}/{total_attempts} 次校验失败，正在重试。",
                )

        raise AppError(failure_message, status_code=502)
