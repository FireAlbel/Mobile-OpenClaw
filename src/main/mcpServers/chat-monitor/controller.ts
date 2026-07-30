import { spawn, type SpawnOptionsWithoutStdio, spawnSync } from 'child_process'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

import { toolPathManager } from '../../utils/tool-paths'
import { DeviceController, type ScrcpyOptions } from '../device-control/controller'

interface CommandResult {
  code: number | null
  stdout: string
  stderr: string
}

interface PythonCommand {
  command: string
  prefixArgs: string[]
}

export interface DependencyCheckResult {
  ready: boolean
  missing: string[]
  available: string[]
  installHints: string[]
  manualConfirmationRequired: boolean
  details: Record<string, unknown>
}

/**
 * ChatMonitorController
 *
 * 设计思路：
 * 1) 复用现有 DeviceController 负责设备连接、scrcpy 控制等能力；
 * 2) 通过运行已有 Python 脚本 wechat_automation.py 提供微信文字监听/发送；
 * 3) 通过 uiautomator2 输入与系统 TTS，提供“输入框回复”和“声卡播报回复”；
 * 4) 语音通话辅助先提供可运行骨架（依赖检查 + 状态管理 +执行建议），便于后续接入ASR链路。
 */
export class ChatMonitorController {
  private readonly deviceController = new DeviceController()
  private toolPathInitialized = false
  private cachedPythonCommand: PythonCommand | null | undefined
  private callAssistActive = false
  private callAssistConfig: Record<string, unknown> | null = null

  private async ensureToolPaths() {
    if (!this.toolPathInitialized) {
      await toolPathManager.initialize()
      this.toolPathInitialized = true
    }
  }

  private async executeCommand(
    command: string,
    args: string[],
    timeoutMs = 60000,
    options: SpawnOptionsWithoutStdio = {}
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const process = spawn(command, args, {
        ...options,
        windowsHide: true
      })

      let stdout = ''
      let stderr = ''

      process.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })

      process.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })

      const timeout = setTimeout(() => {
        process.kill('SIGTERM')
        reject(new Error(`命令执行超时: ${command} ${args.join(' ')}`))
      }, timeoutMs)

      process.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })

      process.on('close', (code) => {
        clearTimeout(timeout)
        resolve({ code, stdout, stderr })
      })
    })
  }

  private getWeChatAutomationScriptPath(): string | null {
    const candidates = [
      join(process.cwd(), 'src', 'main', 'mcpServers', 'chat-monitor', 'wechat_automation.py'),
      join(app.getAppPath(), 'src', 'main', 'mcpServers', 'chat-monitor', 'wechat_automation.py'),
      join(
        process.resourcesPath,
        'app.asar.unpacked',
        'src',
        'main',
        'mcpServers',
        'chat-monitor',
        'wechat_automation.py'
      )
    ]

    const found = candidates.find((filePath) => existsSync(filePath))
    return found ?? null
  }

  private resolvePythonCommand(): PythonCommand | null {
    if (this.cachedPythonCommand !== undefined) {
      return this.cachedPythonCommand
    }

    const envPython = process.env.CHAT_MONITOR_PYTHON_PATH
    const candidates: PythonCommand[] = [
      ...(envPython ? [{ command: envPython, prefixArgs: [] }] : []),
      { command: 'python', prefixArgs: [] },
      { command: 'python3', prefixArgs: [] },
      { command: 'py', prefixArgs: ['-3'] }
    ]

    for (const candidate of candidates) {
      try {
        const result = spawnSync(candidate.command, [...candidate.prefixArgs, '--version'], {
          windowsHide: true,
          stdio: 'pipe'
        })

        if (result.status === 0) {
          this.cachedPythonCommand = candidate
          return candidate
        }
      } catch {
        // ignore
      }
    }

    this.cachedPythonCommand = null
    return null
  }

  private async runPythonWeChatScript(action: string, args: string[] = [], timeoutMs = 60000) {
    const scriptPath = this.getWeChatAutomationScriptPath()
    if (!scriptPath) {
      throw new Error('未找到 wechat_automation.py 脚本，请确认项目文件完整')
    }

    const python = this.resolvePythonCommand()
    if (!python) {
      throw new Error('未找到 Python 运行环境，请先人工确认后安装 Python 3')
    }

    const result = await this.executeCommand(
      python.command,
      [...python.prefixArgs, scriptPath, action, ...args],
      timeoutMs,
      {
        cwd: process.cwd(),
        env: {
          ...process.env
        }
      }
    )

    const trimmedStdout = result.stdout.trim()
    if (!trimmedStdout) {
      return {
        success: result.code === 0,
        raw: result
      }
    }

    try {
      return JSON.parse(trimmedStdout)
    } catch {
      return {
        success: result.code === 0,
        message: trimmedStdout,
        raw: result
      }
    }
  }

  private getVoiceListenerScriptPath(): string | null {
    const candidates = [
      // 开发态
      join(process.cwd(), 'src', 'main', 'mcpServers', 'chat-monitor', 'wechat_voice_listener.py'),
      // 运行时 appPath
      join(app.getAppPath(), 'src', 'main', 'mcpServers', 'chat-monitor', 'wechat_voice_listener.py'),
      // 打包后常见解包目录
      join(
        process.resourcesPath,
        'app.asar.unpacked',
        'src',
        'main',
        'mcpServers',
        'chat-monitor',
        'wechat_voice_listener.py'
      )
    ]

    const found = candidates.find((filePath) => existsSync(filePath))
    return found ?? null
  }

  private async runVoiceListenerScript(deviceId?: string, timeout = 15) {
    const scriptPath = this.getVoiceListenerScriptPath()
    if (!scriptPath) {
      throw new Error('未找到 wechat_voice_listener.py 脚本，请确认项目文件完整')
    }

    const python = this.resolvePythonCommand()
    if (!python) {
      throw new Error('未找到 Python 运行环境，请先人工确认后安装 Python 3')
    }

    const result = await this.executeCommand(
      python.command,
      [...python.prefixArgs, scriptPath, deviceId ?? 'null', String(timeout)],
      (timeout + 10) * 1000,
      {
        cwd: process.cwd(),
        env: {
          ...process.env
        }
      }
    )

    const trimmedStdout = result.stdout.trim()
    if (!trimmedStdout) {
      return {
        success: result.code === 0,
        raw: result
      }
    }

    try {
      return JSON.parse(trimmedStdout)
    } catch {
      return {
        success: result.code === 0,
        message: trimmedStdout,
        raw: result
      }
    }
  }

  private async resolveDeviceId(deviceId?: string): Promise<string> {
    if (deviceId) return deviceId

    const devices = await this.deviceController.listDevices()
    const online = devices.find((d) => d.status === 'online')
    if (!online) {
      throw new Error('未检测到在线Android设备，请先连接手机并开启ADB调试')
    }
    return online.id
  }

  private async runAdbWithDevice(deviceId: string | undefined, args: string[], timeoutMs = 30000) {
    await this.ensureToolPaths()
    const resolvedDeviceId = await this.resolveDeviceId(deviceId)
    const adbPath = toolPathManager.getToolPaths().adbPath
    const result = await this.executeCommand(adbPath, ['-s', resolvedDeviceId, ...args], timeoutMs)
    return {
      deviceId: resolvedDeviceId,
      ...result
    }
  }

  /**
   * 依赖检查工具：
   * - 检查 adb / scrcpy / Python / Python包
   * - 不自动安装，仅返回建议命令，并强制要求人工确认后再安装
   */
  async checkDependencies(): Promise<DependencyCheckResult> {
    await this.ensureToolPaths()

    const available: string[] = []
    const missing: string[] = []
    const installHints: string[] = []

    const toolPaths = toolPathManager.getToolPaths()
    const adbAvailable = await toolPathManager.validateTool(toolPaths.adbPath, 'adb')
    const scrcpyAvailable = await toolPathManager.validateTool(toolPaths.scrcpyPath, 'scrcpy')

    if (adbAvailable) available.push('adb')
    else {
      missing.push('adb')
      installHints.push('请人工确认后安装 Android Platform Tools（adb）')
    }

    if (scrcpyAvailable) available.push('scrcpy')
    else {
      missing.push('scrcpy')
      installHints.push('请人工确认后安装 scrcpy')
    }

    const python = this.resolvePythonCommand()
    if (!python) {
      missing.push('python3')
      installHints.push('请人工确认后安装 Python 3.x（建议 3.9+）')
    } else {
      available.push(`python(${python.command})`)
      const pythonPkgs = ['uiautomator2', 'faster_whisper', 'webrtcvad', 'pyaudio', 'numpy']
      for (const pkg of pythonPkgs) {
        try {
          const check = await this.executeCommand(python.command, [...python.prefixArgs, '-c', `import ${pkg}`], 15000)

          if (check.code === 0) {
            available.push(`python-package:${pkg}`)
          } else {
            missing.push(`python-package:${pkg}`)
            installHints.push(`请人工确认后安装: pip install -U ${pkg}`)
          }
        } catch {
          missing.push(`python-package:${pkg}`)
          installHints.push(`请人工确认后安装: pip install -U ${pkg}`)
        }
      }
    }

    const scriptPath = this.getWeChatAutomationScriptPath()
    if (scriptPath) {
      available.push('wechat_automation.py')
    } else {
      missing.push('wechat_automation.py')
      installHints.push('缺少 wechat_automation.py，请确认仓库文件或打包资源路径')
    }

    const voiceScriptPath = this.getVoiceListenerScriptPath()
    if (voiceScriptPath) {
      available.push('wechat_voice_listener.py')
    } else {
      missing.push('wechat_voice_listener.py')
      installHints.push('缺少 wechat_voice_listener.py，请确认仓库文件或打包资源路径')
    }

    return {
      ready: missing.length === 0,
      missing,
      available,
      installHints,
      manualConfirmationRequired: missing.length > 0,
      details: {
        adbPath: toolPaths.adbPath,
        scrcpyPath: toolPaths.scrcpyPath,
        scriptPath,
        voiceScriptPath
      }
    }
  }

  async listDevices() {
    return this.deviceController.listDevices()
  }

  async startScrcpy(deviceId: string, options: ScrcpyOptions = {}) {
    await this.ensureToolPaths()
    return this.deviceController.startScrcpy(deviceId, options)
  }

  async stopScrcpy(deviceId: string) {
    return this.deviceController.stopScrcpy(deviceId)
  }

  async startWeChat(deviceId?: string) {
    const result = await this.runAdbWithDevice(deviceId, [
      'shell',
      'monkey',
      '-p',
      'com.tencent.mm',
      '-c',
      'android.intent.category.LAUNCHER',
      '1'
    ])

    return {
      success: result.code === 0,
      deviceId: result.deviceId,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim()
    }
  }

  async listenTextMessages(args: { contactName?: string; groupName?: string; keywords?: string[]; timeout?: number }) {
    const timeout = args.timeout ?? 30
    return this.runPythonWeChatScript(
      'listen',
      [args.contactName ?? '', args.groupName ?? '', (args.keywords ?? []).join(','), String(timeout)],
      (timeout + 10) * 1000
    )
  }

  async listenVoiceMessages(args: { deviceId?: string; timeout?: number }) {
    const timeout = args.timeout ?? 15
    return this.runVoiceListenerScript(args.deviceId, timeout)
  }

  async sendTextMessage(args: { contactName: string; message: string; groupName?: string }) {
    return this.runPythonWeChatScript('send', [args.contactName, args.message, args.groupName ?? ''], 60000)
  }

  async markAsRead(args: { contactName?: string; groupName?: string }) {
    return this.runPythonWeChatScript('mark_read', [args.contactName ?? '', args.groupName ?? ''], 45000)
  }

  /**
   * 通过 uiautomator2 在当前聊天输入框写入文本，支持中文稳定输入。
   *
   * 实现思路：
   * 1) 主进程内动态执行 Python 片段，调用 uiautomator2.connect；
   * 2) 定位输入框控件并 set_text（不走 adb input）；
   * 3) 可选点击发送按钮，完成“输入并发送”。
   */
  async sendTextViaInput(args: {
    deviceId?: string
    text: string
    sendEnter?: boolean
    inputResourceId?: string
    sendButtonResourceId?: string
  }) {
    const python = this.resolvePythonCommand()
    if (!python) {
      throw new Error('未找到 Python 运行环境，请先人工确认后安装 Python 3')
    }

    const payload = {
      deviceId: args.deviceId ?? null,
      text: args.text,
      send: !!args.sendEnter,
      inputResourceId: args.inputResourceId ?? 'com.tencent.mm:id/b4a',
      sendButtonResourceId: args.sendButtonResourceId ?? 'com.tencent.mm:id/b8k'
    }

    const payloadJson = JSON.stringify(payload)

    const pythonScript = `
import json
import sys
import uiautomator2 as u2

data = json.loads(sys.argv[1])
device_id = data.get("deviceId")
text = data.get("text", "")
input_id = data.get("inputResourceId") or "com.tencent.mm:id/b4a"
send_id = data.get("sendButtonResourceId") or "com.tencent.mm:id/b8k"

if not text:
    raise ValueError("text is required")

d = u2.connect(device_id) if device_id else u2.connect()
field = d(resourceId=input_id)

if not field.exists(timeout=5):
    raise RuntimeError(f"input box not found: {input_id}")

field.click()
field.set_text(text)

sent = False
if data.get("send"):
    btn = d(resourceId=send_id)
    if btn.exists(timeout=2):
        btn.click()
        sent = True

print(json.dumps({
    "success": True,
    "deviceId": device_id,
    "inputResourceId": input_id,
    "sendButtonResourceId": send_id,
    "sent": sent,
    "textLength": len(text)
}, ensure_ascii=False))
`.trim()

    const result = await this.executeCommand(
      python.command,
      [...python.prefixArgs, '-c', pythonScript, payloadJson],
      60000,
      {
        cwd: process.cwd(),
        env: {
          ...process.env
        }
      }
    )

    const trimmedStdout = result.stdout.trim()
    let parsed: Record<string, unknown> = {}

    if (trimmedStdout) {
      try {
        parsed = JSON.parse(trimmedStdout)
      } catch {
        parsed = { message: trimmedStdout }
      }
    }

    return {
      success: result.code === 0,
      ...parsed,
      stderr: result.stderr.trim()
    }
  }

  /**
   * 声卡播报（TTS）：
   * - Windows: PowerShell + System.Speech
   * - macOS: say
   * - Linux: espeak
   */
  async playTtsToSoundcard(args: { text: string; voiceName?: string; rate?: number }) {
    if (process.platform === 'win32') {
      const text = args.text.replace(/'/g, "''")
      const voiceName = (args.voiceName ?? '').replace(/'/g, "''")
      const rate = Math.max(-10, Math.min(10, args.rate ?? 0))

      const script = [
        'Add-Type -AssemblyName System.Speech;',
        '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
        voiceName ? `$synth.SelectVoice('${voiceName}');` : '',
        `$synth.Rate = ${rate};`,
        `$synth.Speak('${text}');`
      ]
        .filter(Boolean)
        .join(' ')

      const result = await this.executeCommand('powershell', ['-NoProfile', '-Command', script], 120000)
      return {
        success: result.code === 0,
        platform: process.platform,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim()
      }
    }

    if (process.platform === 'darwin') {
      const result = await this.executeCommand('say', [args.text], 120000)
      return { success: result.code === 0, platform: process.platform, stdout: result.stdout, stderr: result.stderr }
    }

    const result = await this.executeCommand('espeak', [args.text], 120000)
    return { success: result.code === 0, platform: process.platform, stdout: result.stdout, stderr: result.stderr }
  }

  /**
   * “按住说话 + 声卡播报”骨架实现：
   * 同时执行：
   * 1) ADB 长按（input swipe x y x y duration）模拟“按住说话”
   * 2) 本机 TTS 播放，声音经声卡进入手机端麦克风链路（需用户自行配置音频路由）
   */
  async sendVoiceByHoldToTalk(args: {
    deviceId?: string
    text: string
    holdX: number
    holdY: number
    holdDurationMs?: number
    voiceName?: string
    rate?: number
  }) {
    const duration = args.holdDurationMs ?? 3000

    const [holdResult, ttsResult] = await Promise.all([
      this.runAdbWithDevice(args.deviceId, [
        'shell',
        'input',
        'swipe',
        String(args.holdX),
        String(args.holdY),
        String(args.holdX),
        String(args.holdY),
        String(duration)
      ]),
      this.playTtsToSoundcard({
        text: args.text,
        voiceName: args.voiceName,
        rate: args.rate
      })
    ])

    return {
      success: holdResult.code === 0 && ttsResult.success,
      deviceId: holdResult.deviceId,
      hold: {
        code: holdResult.code,
        stderr: holdResult.stderr.trim()
      },
      tts: ttsResult
    }
  }

  /**
   * 通话辅助启动（当前为可执行骨架）：
   * - 记录会话状态；
   * - 返回依赖检查结果与下一步动作；
   * - 后续可在此处接入 WASAPI Loopback + VAD + ASR 实时转写链路。
   */
  async startCallAssist(args: { deviceId?: string; mode?: string; transcribeModel?: string }) {
    const dependency = await this.checkDependencies()
    this.callAssistActive = true
    this.callAssistConfig = {
      deviceId: args.deviceId,
      mode: args.mode ?? 'speakerphone',
      transcribeModel: args.transcribeModel ?? 'faster-whisper-base'
    }

    return {
      success: true,
      active: this.callAssistActive,
      config: this.callAssistConfig,
      dependency,
      implementationStatus: 'scaffold',
      nextSteps: [
        '人工确认后安装缺失依赖（如有）',
        '将手机切为外放模式并确保电脑可采集系统音频',
        '后续可接入实时ASR脚本实现 call_transcript 事件流'
      ]
    }
  }

  async stopCallAssist() {
    this.callAssistActive = false
    const previous = this.callAssistConfig
    this.callAssistConfig = null
    return {
      success: true,
      active: false,
      previousConfig: previous
    }
  }

  async cleanup() {
    await this.deviceController.cleanup()
  }
}
