"""构建脚本 - 用于打包exe"""

import os
import sys
import subprocess
import shutil
from pathlib import Path
import glob


def run_command(cmd, cwd=None):
    """运行命令"""
    print(f"执行命令: {cmd}")
    result = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"命令执行失败: {result.stderr}")
        return False
    print(result.stdout)
    return True


def clean_build_files():
    """清理构建相关的文件和文件夹"""
    print("=" * 50)
    print("清理构建文件...")
    print("=" * 50)

    # 要清理的文件夹列表
    folders_to_clean = [
        "dist",  # PyInstaller输出目录
        "build",  # PyInstaller构建缓存
        "frontend/build",  # React构建输出
        "backend/static",  # 后端静态文件（前端构建产物）
    ]

    # 要清理的文件模式
    files_to_clean = [
        "*.spec",  # PyInstaller spec文件
        "requirements_build.txt",  # 临时requirements文件
    ]

    # 清理文件夹
    for folder in folders_to_clean:
        folder_path = Path(folder)
        if folder_path.exists():
            print(f"删除文件夹: {folder}")
            try:
                shutil.rmtree(folder_path)
                print(f"[OK] 已删除 {folder}")
            except Exception as e:
                print(f"[FAIL] 删除 {folder} 失败: {e}")
        else:
            print(f"- 文件夹不存在: {folder}")

    # 清理文件
    for file_pattern in files_to_clean:
        for file_path in glob.glob(file_pattern):
            try:
                os.remove(file_path)
                print(f"[OK] 已删除文件: {file_path}")
            except Exception as e:
                print(f"[FAIL] 删除文件 {file_path} 失败: {e}")

    # 清理Python缓存文件
    print("清理Python缓存文件...")
    for root, dirs, files in os.walk("."):
        # 删除__pycache__文件夹
        if "__pycache__" in dirs:
            pycache_path = Path(root) / "__pycache__"
            try:
                shutil.rmtree(pycache_path)
                print(f"[OK] 已删除: {pycache_path}")
            except Exception as e:
                print(f"[FAIL] 删除 {pycache_path} 失败: {e}")
            dirs.remove("__pycache__")  # 避免继续遍历已删除的目录

        # 删除.pyc文件
        for file in files:
            if file.endswith(".pyc"):
                pyc_path = Path(root) / file
                try:
                    pyc_path.unlink()
                    print(f"[OK] 已删除: {pyc_path}")
                except Exception as e:
                    print(f"[FAIL] 删除 {pyc_path} 失败: {e}")

    # 清理node_modules中的构建缓存（如果存在）
    node_modules_cache = Path("frontend/node_modules/.cache")
    if node_modules_cache.exists():
        try:
            shutil.rmtree(node_modules_cache)
            print(f"[OK] 已删除Node.js缓存: {node_modules_cache}")
        except Exception as e:
            print(f"[FAIL] 删除Node.js缓存失败: {e}")

    print("文件清理完成！")
    return True


def build_frontend():
    """构建前端"""
    print("=" * 50)
    print("构建前端...")
    print("=" * 50)

    frontend_dir = Path("frontend")
    if not frontend_dir.exists():
        print("前端目录不存在")
        return False

    # 安装依赖
    if not run_command("npm install", cwd=frontend_dir):
        print("安装前端依赖失败")
        return False

    # 构建前端
    if not run_command("npm run build", cwd=frontend_dir):
        print("构建前端失败")
        return False

    # 复制构建文件到后端静态目录
    build_dir = frontend_dir / "build"
    static_dir = Path("backend") / "static"

    if static_dir.exists():
        shutil.rmtree(static_dir)

    shutil.copytree(build_dir, static_dir)
    print("前端构建文件已复制到后端静态目录")

    return True


def build_exe():
    """构建exe文件"""
    print("=" * 50)
    print("构建exe文件...")
    print("=" * 50)

    # 安装所需依赖
    print("安装构建依赖...")
    if not run_command(f"{sys.executable} -m pip install pyinstaller"):
        print("安装PyInstaller失败")
        return False

    # 安装应用依赖
    if not run_command(f"{sys.executable} -m pip install -r backend/requirements.txt"):
        print("安装应用依赖失败")
        return False

    # 构建exe - 使用更详细的参数，增加进程管理相关导入
    pyinstaller_cmd = (
        'pyinstaller --onefile --name="yibiao-simple" '
        '--add-data="backend;backend" '
        "--hidden-import=uvicorn --hidden-import=uvicorn.logging --hidden-import=uvicorn.loops "
        "--hidden-import=uvicorn.loops.auto --hidden-import=uvicorn.protocols "
        "--hidden-import=uvicorn.protocols.http --hidden-import=uvicorn.protocols.http.auto "
        "--hidden-import=uvicorn.protocols.websockets --hidden-import=uvicorn.protocols.websockets.auto "
        "--hidden-import=uvicorn.lifespan --hidden-import=uvicorn.lifespan.on --hidden-import=uvicorn.server "
        "--hidden-import=fastapi --hidden-import=fastapi.staticfiles --hidden-import=fastapi.responses "
        "--hidden-import=fastapi.middleware --hidden-import=fastapi.middleware.cors --hidden-import=fastapi.routing "
        "--hidden-import=fastapi.exceptions --hidden-import=starlette --hidden-import=starlette.middleware "
        "--hidden-import=starlette.middleware.cors --hidden-import=starlette.applications "
        "--hidden-import=starlette.routing --hidden-import=starlette.responses --hidden-import=starlette.staticfiles "
        "--hidden-import=starlette.types --hidden-import=openai --hidden-import=docx --hidden-import=docx.oxml "
        "--hidden-import=docx.oxml.ns --hidden-import=PyPDF2 --hidden-import=PyPDF2.generic "
        "--hidden-import=pdfplumber --hidden-import=pdfplumber.page --hidden-import=pdfplumber.table "
        "--hidden-import=pdfplumber.utils --hidden-import=fitz --hidden-import=pymupdf "
        "--hidden-import=docx2python --hidden-import=docx2python.iterators --hidden-import=paragraphs "
        "--hidden-import=pydantic --hidden-import=pydantic_settings --hidden-import=multipart "
        "--hidden-import=aiofiles --hidden-import=dotenv --hidden-import=json --hidden-import=pathlib "
        "--hidden-import=asyncio --hidden-import=signal --hidden-import=atexit "
        "--console app_launcher.py"
    )

    if not run_command(pyinstaller_cmd):
        print("构建exe失败")
        return False

    print("exe文件构建完成，位于 dist/ 目录中")
    return True


def main():
    """主函数"""
    print("AI写标书助手 - 构建脚本")
    print("=" * 50)

    # 确保在项目根目录
    if not Path("backend").exists() or not Path("frontend").exists():
        print("请在项目根目录运行此脚本")
        return False

    # 清理构建文件
    if not clean_build_files():
        return False

    # 构建前端
    if not build_frontend():
        return False

    # 构建exe
    if not build_exe():
        return False

    print("\n" + "=" * 50)
    print("构建完成！")
    print("exe文件位于: dist/yibiao-simple.exe")
    print("=" * 50)

    return True


if __name__ == "__main__":
    success = main()
    if not success:
        sys.exit(1)
