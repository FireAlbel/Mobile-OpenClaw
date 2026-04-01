# Phase 1 使用说明 - 微信语音消息监听

## 功能概述
Phase 1 实现了微信语音消息的监听与转写功能：
1. 自动点击最新的微信语音消息
2. 采集系统音频（Windows环回音频）
3. 使用VAD检测语音活动
4. 使用faster-whisper进行语音识别
5. 返回转写文本

## 环境要求
- Windows 10/11（支持WASAPI环回音频）
- Python 3.8+
- Android设备（已开启USB调试）
- 微信应用

## 依赖安装
```bash
# 安装Python依赖
pip install uiautomator2 pyaudio webrtcvad faster-whisper numpy

# 安装ADB工具（如果未安装）
# 下载Android Platform Tools并添加到PATH
```

## 使用方法

### 1. 命令行测试
```bash
# 基本使用
python wechat_voice_listener.py <device_id> [timeout]

# 示例
python wechat_voice_listener.py 192.168.1.100:5555 15
```

### 2. MCP工具调用
```json
{
  "name": "wechat_listen_voice_messages",
  "arguments": {
    "deviceId": "192.168.1.100:5555",
    "timeout": 15
  }
}
```

### 3. 测试脚本
```bash
# 运行测试脚本
python test_phase1.py
```

## 使用步骤

1. **连接设备**
   - 使用USB连接Android设备
   - 开启USB调试模式
   - 确认ADB设备列表：`adb devices`

2. **准备测试环境**
   - 打开微信应用
   - 确保有一个语音消息可以测试
   - 将微信界面保持在聊天页面

3. **运行监听**
   - 运行命令或调用MCP工具
   - 脚本会自动点击语音消息并录制音频
   - 录制完成后自动进行转写

## 输出格式
```json
{
  "success": true,
  "transcription": {
    "text": "你好，这是一条测试语音消息",
    "confidence": 0.95,
    "language": "zh",
    "language_probability": 0.98
  },
  "duration": 2.5,
  "frames": 125
}
```

## 故障排除

### 常见问题

1. **找不到设备**
   - 确认USB调试已开启
   - 检查ADB设备列表：`adb devices`
   - 尝试重新连接设备

2. **音频采集失败**
   - 确认Windows音频设置中启用了"立体声混音"
   - 检查是否有其他应用占用音频设备
   - 尝试重启音频服务

3. **转写失败**
   - 确认faster-whisper模型已下载
   - 检查音频质量是否清晰
   - 尝试调整VAD灵敏度

### 调试信息
运行时使用以下命令查看详细日志：
```bash
python wechat_voice_listener.py <device_id> 2>&1 | tee debug.log
```

## 下一步计划
Phase 2将实现：
- 语音通话监听与实时转写
- 通话会话管理
- 实时字幕事件流

## 合规提醒
- 仅限本人设备与已授权账号使用
- 确保所有通话参与者知情同意
- 不进行隐蔽监听或破解行为
