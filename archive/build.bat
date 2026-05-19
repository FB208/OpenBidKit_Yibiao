@echo off
cd /d "%~dp0"
chcp 65001 >nul
echo ================================================
echo AI写标书助手 - 构建exe
echo ================================================
echo.
echo 检查Python环境...
python --version
if %errorlevel% neq 0 (
    echo Python未安装或不在PATH中
    pause
    exit /b 1
)
echo.
echo 检查Node.js环境...
node --version
if %errorlevel% neq 0 (
    echo Node.js未安装或不在PATH中
    pause
    exit /b 1
)
echo.
echo 开始构建...
echo 构建前将自动清理以下目录和文件:
echo   - dist/
echo   - build/
echo   - frontend/build/
echo   - backend/static/
echo   - __pycache__/
echo   - *.spec
echo.
python -X utf8 build.py
if errorlevel 1 (
    echo.
    echo ================================================
    echo 构建失败！请检查上方的错误信息
    echo ================================================
) else (
    echo.
    echo ================================================
    echo 构建成功！
    echo exe文件位于: dist\yibiao-simple.exe
    echo ================================================
)
echo.
pause