"""数据模型定义"""

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ConfigRequest(BaseModel):
    """OpenAI配置请求"""

    model_config = {"protected_namespaces": ()}

    api_key: str = Field(..., description="OpenAI API密钥")
    base_url: Optional[str] = Field(None, description="Base URL")
    model_name: str = Field("gpt-3.5-turbo", description="模型名称")


class ConfigResponse(BaseModel):
    """配置响应"""

    success: bool
    message: str


class ModelListResponse(BaseModel):
    """模型列表响应"""

    models: List[str]
    success: bool
    message: str = ""


class FileUploadResponse(BaseModel):
    """文件上传响应"""

    success: bool
    message: str
    file_content: Optional[str] = None
    old_outline: Optional[str] = None


class AnalysisType(str, Enum):
    """分析类型"""

    OVERVIEW = "overview"
    REQUIREMENTS = "requirements"


class OutlineMode(str, Enum):
    """目录生成模式。"""

    FREE = "free"
    ALIGNED = "aligned"


class AnalysisRequest(BaseModel):
    """文档分析请求"""

    file_content: str = Field(..., description="文档内容")
    analysis_type: AnalysisType = Field(..., description="分析类型")


class OutlineItem(BaseModel):
    """目录项"""

    id: str
    title: str
    description: str
    source_requirement_id: Optional[str] = None
    source_requirement_title: Optional[str] = None
    children: Optional[List["OutlineItem"]] = None
    content: Optional[str] = None


# 解决循环引用
OutlineItem.model_rebuild()


class OutlineResponse(BaseModel):
    """目录响应"""

    outline: List[OutlineItem]


class OutlineChildrenResponse(BaseModel):
    """指定一级目录下的子目录响应。"""

    children: List[OutlineItem]


class OutlineReviewResponse(BaseModel):
    """目录审核响应。"""

    passed: bool
    suggestions: List[str] = Field(default_factory=list)


class TechnicalRequirementGroup(BaseModel):
    """技术评分大类。"""

    requirement_id: str
    title: str
    description: str
    detail_points: List[str] = Field(default_factory=list)


class TechnicalRequirementGroupResponse(BaseModel):
    """技术评分大类提取响应。"""

    groups: List[TechnicalRequirementGroup]


class OutlineRequest(BaseModel):
    """目录生成请求"""

    overview: str = Field(..., description="项目概述")
    requirements: str = Field(..., description="技术评分要求")
    mode: OutlineMode = Field(OutlineMode.FREE, description="目录生成模式")
    uploaded_expand: Optional[bool] = Field(False, description="是否已上传方案扩写文件")
    old_outline: Optional[str] = Field(
        None, description="上传的方案扩写文件解析出的旧目录JSON"
    )
    old_document: Optional[str] = Field(
        None, description="上传的方案扩写文件解析出的旧文档"
    )


class ContentGenerationRequest(BaseModel):
    """内容生成请求"""

    outline: Dict[str, Any] = Field(..., description="目录结构")
    project_overview: str = Field("", description="项目概述")


class ChapterContentRequest(BaseModel):
    """单章节内容生成请求"""

    chapter: Dict[str, Any] = Field(..., description="章节信息")
    parent_chapters: Optional[List[Dict[str, Any]]] = Field(
        None, description="上级章节列表"
    )
    sibling_chapters: Optional[List[Dict[str, Any]]] = Field(
        None, description="同级章节列表"
    )
    project_overview: str = Field("", description="项目概述")


class ErrorResponse(BaseModel):
    """错误响应"""

    error: str
    detail: Optional[str] = None


class WordExportOutlineItem(BaseModel):
    """Word 导出用目录项。"""

    id: str
    title: str
    description: Optional[str] = None
    children: Optional[List["WordExportOutlineItem"]] = None
    content: Optional[str] = None


WordExportOutlineItem.model_rebuild()


class WordExportRequest(BaseModel):
    """Word导出请求"""

    project_name: Optional[str] = Field(None, description="项目名称")
    outline: List[WordExportOutlineItem] = Field(..., description="目录结构，包含内容")
