"""后端服务启动脚本"""
import uvicorn
import os
import multiprocessing

if __name__ == "__main__":
    # 确保在正确的目录中运行
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8000,
        reload=False,  # 多进程模式下不支持reload
        log_level="info",
        workers=multiprocessing.cpu_count() * 2  # CPU核心数的2倍，最大化并发能力
    )