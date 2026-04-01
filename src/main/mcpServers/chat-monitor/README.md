# Chat Monitor MCP 服务语音能力接入规划

## 1. 规划目标
在现有 `chat-monitor` 内置 MCP 服务基础上，新增并标准化以下能力：
- 微信语音消息监听与转写
- 微信语音通话监听与实时转写
- 基于大模型应答与声音克隆的语音回复

本规划作为工程落地说明，覆盖技术选型、模块拆分、MCP 工具设计、合规与分阶段实施计划。

## 2. 合规边界（必须满足）
- 仅用于本人设备与已授权账号。
- 仅在所有通话参与者明确知情同意下启用语音监听与录音相关能力。
- 不进行协议破解、加密流量解密、隐蔽监听、越权采集。
- 默认保守策略：先人工确认，再自动执行。

## 3. 当前基线能力（已实现）
目录：`src/main/mcpServers/chat-monitor`

当前已有能力：
- 依赖检查：`check_dependencies`
- 设备与微信启动：`list_devices`、`start_scrcpy`、`stop_scrcpy`、`start_wechat`
- 文字链路：`wechat_listen_text_messages`、`wechat_send_text_message`、`wechat_mark_as_read`
- 输入框写入：`wechat_send_text_via_input`（已改为 uiautomator2 输入，支持中文）
- 声卡播报：`play_tts_to_soundcard`
- 语音骨架：`wechat_send_voice_by_hold_to_talk`、`wechat_start_call_assist`、`wechat_stop_call_assist`

## 4. 目标架构（语音增强版）
`手机微信 -> 设备控制层 -> 音频采集层 -> VAD 分段 -> ASR 转写 -> LLM 决策 -> 声音克隆 TTS -> 手机发送`

分层说明：
- 设备控制层：ADB、scrcpy、uiautomator2（会话切换、点击、按住说话）。
- 音频采集层：系统环回音频、麦克风音频、虚拟声卡路由。
- 识别层：VAD + ASR，输出增量字幕与事件。
- 决策层：大模型结合上下文生成文字/语音回复。
- 合成层：声音克隆 TTS 生成目标音色音频。
- 执行层：点击“按住说话”并播放音频，或文字发送。

## 4.1 Phase 1 实现状态 ✅
- [x] `wechat_voice_listener.py` - 语音监听与转写脚本
- [x] `wechat_listen_voice_messages` - MCP工具实现
- [x] VAD + ASR集成（webrtcvad + faster-whisper）
- [x] 基础日志和错误回退机制
- [x] 依赖检查更新

## 5. 语音消息监听接入规划
适用场景：聊天中的语音条消息（点播放后识别）。

### 5.1 推荐方案
1. 通过 uiautomator2 定位并点击最新语音消息气泡。
2. 电脑侧采集系统输出音频（环回）。
3. 采用 VAD 按停顿切片，降低实时延迟。
4. 使用 ASR 模型转写并输出消息事件。
5. 结果写入统一事件总线，供 LLM 调用。

### 5.2 组件建议
- 音频采集：Windows WASAPI loopback。
- VAD：`webrtcvad` 或 `silero-vad`。
- ASR：`faster-whisper`（base 或 small 起步）。
- 可选说话人区分：`pyannote.audio`（后续迭代）。

### 5.3 代码落点建议
- `controller.ts`：新增 `listenVoiceMessages`、`collectSystemAudio`、`transcribeAudioChunks`。
- `tools.ts`：新增 `wechat_listen_voice_messages` 工具定义与处理器。
- Python 子脚本：新增 `wechat_voice_listener.py`（负责音频采集与分段，或由 Node 侧采集）。

## 6. 语音通话监听接入规划
适用场景：微信语音通话中的实时字幕与辅助回复。

### 6.1 推荐方案
1. 启动通话辅助会话，记录 sessionId。
2. 同时采集：
   - 远端声音：系统播放音频（loopback）
   - 本地声音：麦克风输入
3. 双流音频分别进行 VAD + ASR。
4. 汇总为时间轴事件：`call_transcript`。
5. 按策略触发 LLM 生成建议回复。

### 6.2 关键控制点
- 支持 `start/pause/resume/stop` 会话控制。
- 长会话采用环形缓冲，避免内存增长。
- 异常断流自动重连，失败次数超过阈值后自动停机。

### 6.3 代码落点建议
- `controller.ts`：
  - 扩展 `startCallAssist`，增加真实采集与转写流程
  - 新增 `pauseCallAssist`、`resumeCallAssist`、`getCallAssistStatus`
- `tools.ts`：新增对应 MCP 工具。
- 新增 `call-assist/` 子目录：会话管理、转写流水线、缓冲区实现。

## 7. 声音克隆回复接入规划
目标：大模型生成回复文本后，按指定声纹合成语音并回发。

### 7.1 模型路线
推荐按“本地优先，可切换云端”双路线：
- 本地候选：`OpenVoice v2`、`CosyVoice2`、`XTTS-v2`、`Fish-Speech`
- 云端候选：具备声音克隆 API 的商业 TTS 服务

### 7.2 最小闭环
1. 准备授权声纹样本（10 秒到 60 秒）。
2. 构建 speaker profile（本地缓存 + 哈希索引）。
3. LLM 输出回复文本。
4. TTS 克隆音色生成 wav。
5. 调用“按住说话”执行器发送到手机微信。

### 7.3 质量与安全策略
- 音频后处理：限幅、降噪、静音头尾裁剪。
- 失败回退：克隆失败时回退系统 TTS。
- 鉴权：每个 speaker profile 绑定授权记录与用途说明。

## 8. MCP 工具扩展建议
在现有工具基础上新增：
- `wechat_listen_voice_messages`
- `wechat_start_voice_stream`
- `wechat_stop_voice_stream`
- `wechat_start_call_transcription`
- `wechat_stop_call_transcription`
- `wechat_get_call_transcripts`
- `voice_clone_register_profile`
- `voice_clone_list_profiles`
- `voice_clone_synthesize_reply`
- `wechat_send_voice_reply_with_profile`

建议统一返回字段：
- `sessionId`
- `eventId`
- `type`（voice_message / call_transcript / reply_audio）
- `text`
- `audioPath`
- `confidence`
- `latencyMs`
- `isError`

## 9. 安装与人工确认机制
保持当前策略：不自动安装任何依赖，只返回待确认清单。

建议将依赖检查分层：
- 基础层：adb、scrcpy、python、uiautomator2
- 语音层：ffmpeg、virtual-audio-cable、音频驱动可用性
- ASR 层：faster-whisper、VAD 依赖
- 声音克隆层：对应模型权重与推理依赖

由 MCP 工具返回：
- `manualConfirmationRequired: true`
- `missingDependencies`
- `installHints`
- `estimatedDiskUsage`

## 10. 分阶段实施计划

### Phase 1（1 到 2 周）✅ 已完成
- [x] 语音消息监听 MVP（播放后转写）
- [x] `wechat_listen_voice_messages` 工具可用
- [x] 基础日志与错误回退
- [x] 依赖检查与安装提示

### Phase 2（1 到 2 周）
- 通话监听双流转写（loopback + mic）
- 通话会话管理与状态查询
- 实时字幕事件流

### Phase 3（2 周）
- 声音克隆资料注册与合成
- 语音回复链路打通（TTS -> 按住说话发送）
- 克隆失败回退策略

### Phase 4（持续）
- 多机型适配与资源占用优化
- 风控策略增强与审计看板
- 质量评测自动化

## 11. 验收指标建议
- 语音消息转写延迟：短语音平均小于 2.5 秒。
- 通话字幕端到端延迟：平均小于 1.5 秒。
- 克隆语音可懂度：主观评测达到可用等级。
- 回复成功率：语音回复链路成功率大于 95%。
- 稳定性：连续运行 2 小时无严重异常。

## 12. 不在本期范围
- 绕过平台安全机制的自动化操作。
- 未授权语音采集与监听。
- 协议逆向与加密流解密。
- 伪造身份、欺骗场景下的声音克隆使用。

## 13. 下一步落地建议
1. 先实现 `wechat_listen_voice_messages` 与 `wechat_start_call_transcription` 两个核心工具。
2. 再接入 `voice_clone_register_profile` 与 `voice_clone_synthesize_reply`。
3. 最后把“语音监听 -> LLM -> 克隆回复 -> 按住说话发送”串成端到端闭环。
