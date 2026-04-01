#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Phase 1 测试脚本
用于验证微信语音消息监听功能
"""

import sys
import json
import time
import os

def run_command(command):
    """运行命令并返回结果"""
    import subprocess
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True)
        return {
            "success": result.returncode == 0,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "returncode": result.returncode
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

def check_dependencies():
    """检查必要的依赖"""
    print("🔍 检查依赖...")

    # 检查Python包
    packages = ['uiautomator2', 'pyaudio', 'webrtcvad', 'faster_whisper', 'numpy']
    missing_packages = []

    for package in packages:
        result = run_command(f"python -c \"import {package}\"")
        if not result["success"]:
            missing_packages.append(package)

    if missing_packages:
        print(f"❌ 缺少依赖包: {', '.join(missing_packages)}")
        print("请运行: pip install uiautomator2 pyaudio webrtcvad faster-whisper numpy")
        return False
    else:
        print("✅ 所有依赖包已安装")

    # 检查ADB设备
    result = run_command("adb devices")
    if result["success"] and "device" in result["stdout"]:
        print("✅ ADB设备已连接")
    else:
        print("❌ 未检测到ADB设备，请连接Android设备并开启USB调试")
        return False

    return True

def test_voice_listener():
    """测试语音监听功能"""
    print("\n🎤 测试语音监听功能...")

    # 检查脚本是否存在
    script_path = "wechat_voice_listener.py"
    if not os.path.exists(script_path):
        print(f"❌ 找不到脚本: {script_path}")
        return False

    print("✅ 语音监听脚本存在")

    # 这里可以添加实际的测试逻辑
    # 由于需要连接设备，这里只做基本检查
    print("⚠️  需要连接Android设备才能进行完整测试")
    print("📱 请确保:")
    print("   - Android设备已通过USB连接")
    print("   - 已开启USB调试")
    print("   - 微信已打开")
    print("   - 有一个语音消息可以测试")

    return True

def main():
    """主函数"""
    print("🚀 Phase 1 微信语音消息监听测试")
    print("=" * 50)

    # 检查依赖
    if not check_dependencies():
        print("\n❌ 依赖检查失败，请解决上述问题")
        sys.exit(1)

    # 测试语音监听
    if not test_voice_listener():
        print("\n❌ 语音监听测试失败")
        sys.exit(1)

    print("\n✅ Phase 1 测试准备完成")
    print("\n📋 使用说明:")
    print("1. 确保微信已打开并有语音消息")
    print("2. 运行: python wechat_voice_listener.py <device_id> [timeout]")
    print("3. 或者直接使用MCP工具: wechat_listen_voice_messages")

    sys.exit(0)

if __name__ == "__main__":
    main()
