@echo off
echo 启动Android模拟器用于测试...
echo 请确保已安装Android Studio并创建了模拟器

REM 检查emulator是否可用
where emulator >nul 2>&1
if %errorlevel% neq 0 (
    echo 错误: 找不到emulator命令
    echo 请确保Android SDK已正确安装，并将emulator添加到PATH
    pause
    exit /b 1
)

REM 列出可用的模拟器
echo 可用的模拟器:
emulator -list-avds

REM 启动第一个模拟器（如果有）
for /f "delims=" %%i in ('emulator -list-avds') do (
    echo 正在启动模拟器: %%i
    start emulator -avd %%i
    timeout /t 10 /nobreak >nul
    break
)

echo 模拟器启动完成，按任意键继续...
pause
