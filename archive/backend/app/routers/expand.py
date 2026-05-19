"""标书扩写相关 API 路由。"""

import json
import logging

from fastapi import APIRouter, File, UploadFile

from ..models.schemas import FileUploadResponse
from ..services.expand_service import ExpandService
from ..services.file_service import FileService
from ..utils.errors import AppError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/expand", tags=["标书扩写"])


@router.post("/upload", response_model=FileUploadResponse)
async def upload_file(file: UploadFile = File(...)):
    """上传扩写参考文档并提取旧目录。"""
    try:
        if not FileService.is_supported_document(file.content_type):
            return FileUploadResponse(
                success=False, message="不支持的文件类型，请上传PDF或Word文档"
            )

        file_content = await FileService.process_uploaded_file(file)
        expand_service = ExpandService()
        outline = await expand_service.generate_expand_outline(file_content)
        return FileUploadResponse(
            success=True,
            message=f"文件 {file.filename} 上传成功",
            file_content=file_content,
            old_outline=json.dumps(outline, ensure_ascii=False),
        )
    except AppError as exc:
        return FileUploadResponse(success=False, message=exc.message)
    except Exception as exc:
        logger.exception("方案扩写文件处理失败")
        return FileUploadResponse(success=False, message=f"文件处理失败: {exc}")
