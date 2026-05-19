"""SSE (Server-Sent Events) 相关工具。"""

import json
from typing import AsyncGenerator, Any, Dict, Optional

from fastapi.responses import StreamingResponse


DEFAULT_SSE_HEADERS: Dict[str, str] = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream",
}


def sse_response(
    generator: AsyncGenerator[str, Any],
    media_type: str = "text/event-stream",
    extra_headers: Optional[Dict[str, str]] = None,
) -> StreamingResponse:
    """
    包装 SSE 异步生成器为 StreamingResponse，统一 headers 和 media_type。

    Args:
        generator: 异步生成器，yield 已经带好 "data: ..." 和 "\n\n" 的字符串
        media_type: 响应的 media_type，默认使用 text/event-stream
        extra_headers: 额外需要添加或覆盖的响应头
    """
    headers = DEFAULT_SSE_HEADERS.copy()
    if extra_headers:
        headers.update(extra_headers)

    return StreamingResponse(
        generator,
        media_type=media_type,
        headers=headers,
    )


def sse_data(payload: Dict[str, Any]) -> str:
    """将 payload 包装为标准 SSE data 事件。"""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def sse_chunk(chunk: str) -> str:
    """输出增量文本块。"""
    return sse_data({"chunk": chunk})


def sse_progress(message: str) -> str:
    """输出进度事件。"""
    return sse_data({"type": "progress", "message": message})


def sse_result(payload: Dict[str, Any]) -> str:
    """输出结果事件。"""
    return sse_data({"type": "result", **payload})


def sse_error(message: str) -> str:
    """输出统一错误事件。"""
    return sse_data({"error": True, "message": message})


def sse_done() -> str:
    """输出结束标记。"""
    return "data: [DONE]\n\n"
