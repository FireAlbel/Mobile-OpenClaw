#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微信语音消息监听与转写脚本
Phase 1 MVP 实现：播放语音消息并转写为文字

功能：
1. 通过uiautomator2点击最新语音消息
2. 采集系统音频（Windows环回音频）
3. 使用VAD检测语音活动
4. 使用faster-whisper进行语音识别
5. 返回转写结果

依赖：
- uiautomator2
- pyaudio
- webrtcvad
- faster-whisper
- numpy

使用：
python wechat_voice_listener.py <device_id> <timeout_seconds>
"""

import sys
import json
import time
import threading
import numpy as np
import pyaudio
import webrtcvad
from faster_whisper import WhisperModel
import uiautomator2 as u2
import logging

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class WeChatVoiceListener:
    def __init__(self, device_id=None):
        self.device_id = device_id
        self.device = None
        self.model = None
        self.vad = None
        self.audio_stream = None
        self.is_recording = False
        self.audio_data = []

    def connect_device(self):
        """连接Android设备"""
        try:
            if self.device_id:
                self.device = u2.connect(self.device_id)
            else:
                self.device = u2.connect()
            logger.info(f"已连接到设备: {self.device.serial}")
            return True
        except Exception as e:
            logger.error(f"连接设备失败: {e}")
            return False

    def click_latest_voice_message(self):
        """点击最新的语音消息气泡"""
        try:
            # 查找语音消息气泡（通常有播放图标）
            voice_messages = self.device(className="android.widget.TextView", resourceId="com.tencent.mm:id/b8g")
            if voice_messages.exists:
                # 点击最后一个语音消息
                voice_messages[-1].click()
                logger.info("已点击最新语音消息")
                return True
            else:
                logger.warning("未找到语音消息")
                return False
        except Exception as e:
            logger.error(f"点击语音消息失败: {e}")
            return False

    def init_audio_capture(self):
        """初始化音频采集"""
        try:
            self.audio = pyaudio.PyAudio()

            # 查找环回音频设备（Windows）
            device_index = None
            for i in range(self.audio.get_device_count()):
                info = self.audio.get_device_info_by_index(i)
                if 'stereo mix' in info['name'].lower() or '环回' in info['name'].lower():
                    device_index = i
                    break

            if device_index is None:
                logger.warning("未找到环回音频设备，使用默认输出设备")
                device_index = self.audio.get_default_output_device_info()['index']

            # 打开音频流
            self.audio_stream = self.audio.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=16000,
                input=True,
                input_device_index=device_index,
                frames_per_buffer=320  # 20ms at 16kHz
            )

            logger.info(f"音频采集已初始化，设备: {device_index}")
            return True
        except Exception as e:
            logger.error(f"初始化音频采集失败: {e}")
            return False

    def init_vad_and_whisper(self):
        """初始化VAD和Whisper模型"""
        try:
            # 初始化VAD
            self.vad = webrtcvad.Vad(2)  # 灵敏度级别 0-3，2为中等

            # 初始化Whisper模型
            self.model = WhisperModel("base", device="cpu", compute_type="int8")
            logger.info("VAD和Whisper模型初始化完成")
            return True
        except Exception as e:
            logger.error(f"初始化VAD和Whisper失败: {e}")
            return False

    def record_audio(self, timeout=10):
        """录制音频，直到超时或检测到静音"""
        self.is_recording = True
        self.audio_data = []

        silence_frames = 0
        max_silence_frames = 50  # 1秒静音

        start_time = time.time()

        try:
            while self.is_recording and (time.time() - start_time) < timeout:
                # 读取音频数据
                data = self.audio_stream.read(320, exception_on_overflow=False)
                self.audio_data.append(data)

                # 检查是否为语音
                if len(data) == 320:
                    is_speech = self.vad.is_speech(data, 16000)
                    if is_speech:
                        silence_frames = 0
                    else:
                        silence_frames += 1

                # 如果静音持续超过阈值，停止录制
                if silence_frames > max_silence_frames:
                    logger.info("检测到长时间静音，停止录制")
                    break

        except Exception as e:
            logger.error(f"录制音频时出错: {e}")

        self.is_recording = False
        logger.info(f"录制完成，共收集 {len(self.audio_data)} 帧音频数据")

    def transcribe_audio(self):
        """转录音频数据"""
        try:
            if not self.audio_data:
                return {"text": "", "confidence": 0.0}

            # 合并音频数据
            audio_bytes = b''.join(self.audio_data)

            # 转换为numpy数组
            audio_array = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0

            # 使用Whisper转写
            segments, info = self.model.transcribe(audio_array, beam_size=5, language="zh")

            # 合并所有片段
            full_text = ""
            confidence_sum = 0
            segment_count = 0

            for segment in segments:
                full_text += segment.text
                confidence_sum += segment.avg_logprob if hasattr(segment, 'avg_logprob') else 0.8
                segment_count += 1

            avg_confidence = confidence_sum / max(segment_count, 1)

            result = {
                "text": full_text.strip(),
                "confidence": round(avg_confidence, 2),
                "language": info.language,
                "language_probability": info.language_probability
            }

            logger.info(f"转写结果: {result}")
            return result

        except Exception as e:
            logger.error(f"转录音频失败: {e}")
            return {"text": "", "confidence": 0.0, "error": str(e)}

    def cleanup(self):
        """清理资源"""
        self.is_recording = False

        if self.audio_stream:
            self.audio_stream.stop_stream()
            self.audio_stream.close()

        if hasattr(self, 'audio'):
            self.audio.terminate()

        logger.info("资源已清理")

    def listen_voice_message(self, timeout=15):
        """监听并转写语音消息"""
        try:
            # 连接设备
            if not self.connect_device():
                return {"success": False, "error": "无法连接设备"}

            # 初始化模型
            if not self.init_vad_and_whisper():
                return {"success": False, "error": "无法初始化VAD和Whisper模型"}

            # 初始化音频采集
            if not self.init_audio_capture():
                return {"success": False, "error": "无法初始化音频采集"}

            # 点击语音消息
            if not self.click_latest_voice_message():
                return {"success": False, "error": "无法点击语音消息"}

            # 等待语音开始播放
            time.sleep(0.5)

            # 录制音频
            self.record_audio(timeout=timeout)

            # 转录音频
            transcription = self.transcribe_audio()

            result = {
                "success": True,
                "transcription": transcription,
                "duration": len(self.audio_data) * 0.02,  # 每帧20ms
                "frames": len(self.audio_data)
            }

            return result

        except Exception as e:
            logger.error(f"监听语音消息失败: {e}")
            return {"success": False, "error": str(e)}
        finally:
            self.cleanup()

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "缺少参数: device_id [timeout]"}, ensure_ascii=False))
        sys.exit(1)

    device_id = sys.argv[1] if sys.argv[1] != "null" else None
    timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 15

    listener = WeChatVoiceListener(device_id)
    result = listener.listen_voice_message(timeout)

    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
