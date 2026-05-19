"""内容相关 API 路由。"""

import logging

from fastapi import APIRouter, HTTPException

from ..models.schemas import ChapterContentRequest
from ..services.content_service import ContentService
from ..utils.errors import AppError
from ..utils.sse import sse_chunk, sse_done, sse_error, sse_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/content", tags=["内容管理"])


@router.post("/generate-chapter")
async def generate_chapter_content(request: ChapterContentRequest):
    """为单个章节生成完整内容。"""
    try:
        content_service = ContentService()
        content = await content_service.generate_chapter_content(
            chapter=request.chapter,
            parent_chapters=request.parent_chapters,
            sibling_chapters=request.sibling_chapters,
            project_overview=request.project_overview,
        )
        return {"success": True, "content": content}
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    except Exception as exc:
        logger.exception("章节内容生成失败")
        raise HTTPException(status_code=500, detail=f"章节内容生成失败: {exc}") from exc


@router.post("/generate-chapter-stream")
async def generate_chapter_content_stream(request: ChapterContentRequest):
    """流式生成单章节内容。"""
    try:
        content_service = ContentService()
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    async def generate():
        try:
            async for chunk in content_service.stream_chapter_content(
                chapter=request.chapter,
                parent_chapters=request.parent_chapters,
                sibling_chapters=request.sibling_chapters,
                project_overview=request.project_overview,
            ):
                yield sse_chunk(chunk)
        except AppError as exc:
            yield sse_error(exc.message)
        except Exception:
            logger.exception("章节内容流式生成失败")
            yield sse_error("章节内容生成失败，请稍后重试")
        finally:
            yield sse_done()

    return sse_response(generate())
