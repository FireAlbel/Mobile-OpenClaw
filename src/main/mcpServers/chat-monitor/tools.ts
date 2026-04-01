import type { ChatMonitorController } from './controller'

/**
 * Chat Monitor MCP 工具定义
 *
 * 说明：
 * - 工具名按“设备准备 / 监听 / 回复 / 通话辅助”分组；
 * - 每个工具都附带 inputSchema，便于 Cherry Studio 按标准展示参数表单；
 * - 复杂业务（如通话ASR实时转写）先提供骨架工具，后续可渐进增强实现。
 */
export const toolDefinitions = [
  {
    name: 'check_dependencies',
    description: '检查 chat monitor 所需依赖是否就绪，并返回“需人工确认后安装”的建议项',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'list_devices',
    description: '列出当前已连接的 Android 设备（ADB）',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'start_scrcpy',
    description: '启动指定设备的 scrcpy 投屏，便于人工校准微信界面与坐标',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: '设备序列号，通常来自 list_devices'
        },
        options: {
          type: 'object',
          properties: {
            maxSize: { type: 'number', description: '最大投屏尺寸' },
            bitRate: { type: 'number', description: '视频码率，例如 8000000' },
            maxFps: { type: 'number', description: '最大帧率，例如 30' },
            noAudio: { type: 'boolean', description: '是否关闭 scrcpy 音频转发' },
            stayAwake: { type: 'boolean', description: '保持设备常亮' },
            alwaysOnTop: { type: 'boolean', description: '窗口置顶' }
          }
        }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'stop_scrcpy',
    description: '停止指定设备的 scrcpy 投屏',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: '设备序列号'
        }
      },
      required: ['deviceId']
    }
  },
  {
    name: 'start_wechat',
    description: '通过 ADB 启动手机微信应用（包名 com.tencent.mm）',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: '可选，不传则自动选择第一个在线设备'
        }
      }
    }
  },
  {
    name: 'wechat_listen_text_messages',
    description: '监听微信文字消息（基于 uiautomator2 脚本）',
    inputSchema: {
      type: 'object',
      properties: {
        contactName: {
          type: 'string',
          description: '联系人名称（可选）'
        },
        groupName: {
          type: 'string',
          description: '群聊名称（可选）'
        },
        keywords: {
          type: 'array',
          description: '关键词过滤（可选）',
          items: {
            type: 'string'
          }
        },
        timeout: {
          type: 'number',
          description: '监听超时秒数，默认 30'
        }
      }
    }
  },
  {
    name: 'wechat_send_text_message',
    description: '通过微信自动化脚本发送文字消息（进入会话后发送）',
    inputSchema: {
      type: 'object',
      properties: {
        contactName: {
          type: 'string',
          description: '联系人名称'
        },
        message: {
          type: 'string',
          description: '待发送文本'
        },
        groupName: {
          type: 'string',
          description: '群聊名称（可选，与 contactName 二选一）'
        }
      },
      required: ['contactName', 'message']
    }
  },
  {
    name: 'wechat_mark_as_read',
    description: '标记联系人/群聊消息为已读（自动进入后返回）',
    inputSchema: {
      type: 'object',
      properties: {
        contactName: {
          type: 'string',
          description: '联系人名称（可选）'
        },
        groupName: {
          type: 'string',
          description: '群聊名称（可选）'
        }
      }
    }
  },
  {
    name: 'wechat_listen_voice_messages',
    description: '监听微信语音消息：播放并转写为文字（Phase 1 MVP）',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: '设备序列号（可选，不传则自动选择第一个在线设备）'
        },
        timeout: {
          type: 'number',
          description: '监听超时秒数（默认15秒）'
        }
      }
    }
  },
  {
    name: 'wechat_send_text_via_input',
    description: '通过 uiautomator2 向微信输入框输入文本（支持中文），可选点击发送按钮',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: '设备序列号（可选）'
        },
        text: {
          type: 'string',
          description: '要输入的文本'
        },
        sendEnter: {
          type: 'boolean',
          description: '是否在输入后点击发送按钮（逻辑字段，非ADB回车）'
        },
        inputResourceId: {
          type: 'string',
          description: '输入框 resourceId，默认 com.tencent.mm:id/b4a'
        },
        sendButtonResourceId: {
          type: 'string',
          description: '发送按钮 resourceId，默认 com.tencent.mm:id/b8k'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'play_tts_to_soundcard',
    description: '将文本转语音后在电脑端声卡播报（用于通话辅助/语音回复）',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要播报的文本'
        },
        voiceName: {
          type: 'string',
          description: '可选语音名称（Windows 可用）'
        },
        rate: {
          type: 'number',
          description: '语速，范围建议 -10 到 10'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'wechat_send_voice_by_hold_to_talk',
    description: '模拟按住说话并同步声卡播报，实现“语音回复”骨架能力',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: '设备序列号（可选）'
        },
        text: {
          type: 'string',
          description: '待播报文本（先 TTS）'
        },
        holdX: {
          type: 'number',
          description: '按住说话区域中心点 X 坐标'
        },
        holdY: {
          type: 'number',
          description: '按住说话区域中心点 Y 坐标'
        },
        holdDurationMs: {
          type: 'number',
          description: '按住时长（毫秒），默认 3000'
        },
        voiceName: {
          type: 'string',
          description: '可选语音名称'
        },
        rate: {
          type: 'number',
          description: '可选语速'
        }
      },
      required: ['text', 'holdX', 'holdY']
    }
  },
  {
    name: 'wechat_start_call_assist',
    description: '启动语音通话辅助（当前为可执行骨架：状态+依赖检查+引导）',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: '设备序列号（可选）'
        },
        mode: {
          type: 'string',
          description: '模式，默认 speakerphone'
        },
        transcribeModel: {
          type: 'string',
          description: 'ASR模型标识（预留字段）'
        }
      }
    }
  },
  {
    name: 'wechat_stop_call_assist',
    description: '停止语音通话辅助',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
] as const

/**
 * Chat Monitor 工具处理器
 *
 * 设计说明：
 * - 统一将 controller 返回值封装为 MCP content text；
 * - 便于上层大模型直接 JSON.parse 文本结果后做策略判断；
 * - 这里不吞异常，交由上层统一错误处理。
 */
export const toolHandlers: Record<string, (controller: ChatMonitorController, args: any) => Promise<any>> = {
  check_dependencies: async (controller: ChatMonitorController) => {
    const result = await controller.checkDependencies()
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  list_devices: async (controller: ChatMonitorController) => {
    const result = await controller.listDevices()
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  start_scrcpy: async (controller: ChatMonitorController, args: any) => {
    const result = await controller.startScrcpy(args.deviceId, args.options ?? {})
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  stop_scrcpy: async (controller: ChatMonitorController, args: any) => {
    const result = await controller.stopScrcpy(args.deviceId)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  start_wechat: async (controller: ChatMonitorController, args: any) => {
    const result = await controller.startWeChat(args?.deviceId)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  wechat_listen_text_messages: async (controller: ChatMonitorController, args: any) => {
    const result = await controller.listenTextMessages({
      contactName: args?.contactName,
      groupName: args?.groupName,
      keywords: Array.isArray(args?.keywords) ? args.keywords : undefined,
      timeout: args?.timeout
    })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  wechat_send_text_message: async (controller: ChatMonitorController, args: any) => {
    const result = await controller.sendTextMessage({
      contactName: args.contactName,
      message: args.message,
      groupName: args?.groupName
    })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  wechat_mark_as_read: async (controller: ChatMonitorController, args: any) => {
    const result = await controller.markAsRead({
      contactName: args?.contactName,
      groupName: args?.groupName
    })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  wechat_listen_voice_messages: async (controller: ChatMonitorController, args: any) => {
    const result = await controller.listenVoiceMessages({
      deviceId: args?.deviceId,
      timeout: args?.timeout
    })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  wechat_send_text_via_input: async (controller: ChatMonitorController, args: any) => {
    const result = await controller.sendTextViaInput({
      deviceId: args?.deviceId,
      text: args.text,
      sendEnter: args?.sendEnter,
      inputResourceId: args?.inputResourceId,
      sendButtonResourceId: args?.sendButtonResourceId
    })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  play_tts_to_soundcard: async (controller: ChatMonitorController, args: any) => {
    const result = await controller.playTtsToSoundcard({
      text: args.text,
      voiceName: args?.voiceName,
      rate: args?.rate
    })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  wechat_send_voice_by_hold_to_talk: async (controller: ChatMonitorController, args: any) => {
    const result = await controller.sendVoiceByHoldToTalk({
      deviceId: args?.deviceId,
      text: args.text,
      holdX: args.holdX,
      holdY: args.holdY,
      holdDurationMs: args?.holdDurationMs,
      voiceName: args?.voiceName,
      rate: args?.rate
    })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  wechat_start_call_assist: async (controller: ChatMonitorController, args: any) => {
    const result = await controller.startCallAssist({
      deviceId: args?.deviceId,
      mode: args?.mode,
      transcribeModel: args?.transcribeModel
    })
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  wechat_stop_call_assist: async (controller: ChatMonitorController) => {
    const result = await controller.stopCallAssist()
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  }
}
