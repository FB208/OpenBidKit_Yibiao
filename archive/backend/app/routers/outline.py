"""目录相关 API 路由。"""

import asyncio
import logging

from fastapi import APIRouter, HTTPException

from ..models.schemas import OutlineRequest, OutlineResponse
from ..services.outline_service import OutlineService
from ..utils.errors import AppError
from ..utils.sse import (
    sse_done,
    sse_error,
    sse_progress,
    sse_response,
    sse_result,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/outline", tags=["目录管理"])


@router.post("/generate", response_model=OutlineResponse)
async def generate_outline(request: OutlineRequest):
    """生成完整目录结构。"""
    try:
        outline_service = OutlineService()
        return await outline_service.generate_outline(
            overview=request.overview,
            requirements=request.requirements,
            mode=request.mode,
            uploaded_expand=bool(request.uploaded_expand),
            old_outline=request.old_outline,
        )
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    except Exception as exc:
        logger.exception("目录生成失败")
        raise HTTPException(status_code=500, detail=f"目录生成失败: {exc}") from exc


@router.post("/generate-stream")
async def generate_outline_stream(request: OutlineRequest):
    """流式生成目录结构。"""
    try:
        outline_service = OutlineService()
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    async def generate():
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        client_disconnected = False

        async def progress_callback(message: str) -> None:
            await queue.put(sse_progress(message))

        async def run_workflow() -> None:
            try:
                outline = await outline_service.generate_outline(
                    overview=request.overview,
                    requirements=request.requirements,
                    mode=request.mode,
                    uploaded_expand=bool(request.uploaded_expand),
                    old_outline=request.old_outline,
                    progress_callback=progress_callback,
                )
                await queue.put(sse_result({"outline": outline}))
            except AppError as exc:
                await queue.put(sse_error(exc.message))
            except Exception:
                logger.exception("目录流式生成失败")
                await queue.put(sse_error("目录生成失败，请稍后重试"))
            finally:
                await queue.put(None)

        task = asyncio.create_task(run_workflow())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield event
        except asyncio.CancelledError:
            client_disconnected = True
            raise
        finally:
            if not task.done():
                task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            finally:
                if not client_disconnected:
                    yield sse_done()

    return sse_response(generate())
