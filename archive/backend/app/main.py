"""FastAPI应用主入口"""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import settings
from .utils.logging_setup import setup_logging

setup_logging(settings.enable_file_logging)

from .routers import config, document, outline, content, expand

# 创建FastAPI应用实例
app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="基于FastAPI的AI写标书助手后端API",
)

# 添加CORS中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(config.router)
app.include_router(document.router)
app.include_router(outline.router)
app.include_router(content.router)
app.include_router(expand.router)


# 健康检查端点
@app.get("/health")
async def health_check():
    """健康检查"""
    return {
        "status": "healthy",
        "app_name": settings.app_name,
        "version": settings.app_version,
    }


# 静态文件服务（用于服务前端构建文件）
if os.path.exists("static"):
    # 挂载静态资源文件夹
    app.mount("/static", StaticFiles(directory="static/static"), name="static")

    # 处理React应用的路由（SPA路由支持）
    @app.get("/")
    async def read_index():
        """根路径，返回前端首页"""
        return FileResponse("static/index.html")

    @app.get("/{full_path:path}")
    async def serve_react_app(full_path: str):
        """处理React路由，所有非API路径都返回index.html"""
        # 排除API路径
        if (
            full_path.startswith("api/")
            or full_path.startswith("docs")
            or full_path.startswith("health")
        ):
            # 这些路径应该由FastAPI处理，如果到这里说明404
            from fastapi import HTTPException

            raise HTTPException(status_code=404, detail="接口不存在")

        # 检查是否是静态文件
        static_file_path = os.path.join("static", full_path)
        if os.path.exists(static_file_path) and os.path.isfile(static_file_path):
            return FileResponse(static_file_path)

        # 对于其他所有路径，返回React应用的index.html（SPA路由）
        return FileResponse("static/index.html")
else:
    # 如果没有静态文件，返回API信息
    @app.get("/")
    async def read_root():
        """根路径，返回API信息"""
        return {
            "message": f"欢迎使用 {settings.app_name} API",
            "version": settings.app_version,
            "docs": "/docs",
            "health": "/health",
        }
