import { loggerService } from '@logger'
import { exec, execFile, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { promisify } from 'util'

import { initializeToolPaths, toolPathManager } from '../utils/tool-paths'

const logger = loggerService.withContext('DeviceService')

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
const SCREENSHOT_MAX_BUFFER = 50 * 1024 * 1024
const ADB_TEXT_MAX_BUFFER = 16 * 1024 * 1024

export type AdbRawStatus = 'device' | 'offline' | 'unauthorized' | 'bootloader' | 'unknown'

export interface AdbDevice {
  serial: string
  status: AdbRawStatus
  transportId?: string
}

export interface DeviceInfo {
  id: string
  name: string
  status: 'online' | 'offline' | 'unauthorized'
  model?: string
  brand?: string
  androidVersion?: string
  screenSize?: string
  density?: string
}

export interface ScrcpyProcess {
  deviceId: string
  process: ReturnType<typeof spawn>
  port: number
  windowTitle: string
}

export interface DeviceScreenSize {
  width: number
  height: number
}

export interface ForegroundAppInfo {
  packageName: string
  activity?: string
}

type PermissionDialogAction = 'allow' | 'deny' | 'allow_once'

export function normalizeAdbStatus(status: string): DeviceInfo['status'] {
  switch (status) {
    case 'device':
      return 'online'
    case 'unauthorized':
      return 'unauthorized'
    case 'offline':
    case 'bootloader':
    default:
      return 'offline'
  }
}

export function parseAdbDevicesOutput(output: string): AdbDevice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices') && !line.startsWith('*'))
    .map((line) => {
      const parts = line.split(/\s+/)
      const serial = parts[0]
      const status = (parts[1] || 'unknown') as AdbRawStatus
      const transportPart = parts.find((part) => part.startsWith('transport_id:'))

      return {
        serial,
        status,
        transportId: transportPart?.split(':')[1]
      }
    })
    .filter((device) => Boolean(device.serial))
}

export function parseForegroundAppInfo(output: string): ForegroundAppInfo | null {
  const patterns = [
    /topResumedActivity=.*?\s([a-zA-Z0-9_.]+)\/([^\s}]+)/i,
    /mResumedActivity:.*?\s([a-zA-Z0-9_.]+)\/([^\s}]+)/i,
    /ResumedActivity:.*?\s([a-zA-Z0-9_.]+)\/([^\s}]+)/i,
    /topActivity=ComponentInfo\{([a-zA-Z0-9_.]+)\/([^\s}]+)\}/i,
    /topActivity=.*?\s([a-zA-Z0-9_.]+)\/([^\s}]+)/i,
    /mCurrentFocus=Window\{.*?\s([a-zA-Z0-9_.]+)\/([^\s}]+)\}/i,
    /mFocusedApp=.*?\s([a-zA-Z0-9_.]+)\/([^\s}]+)/i
  ]

  for (const pattern of patterns) {
    const match = output.match(pattern)
    if (match) {
      return normalizeForegroundApp(match[1], match[2])
    }
  }

  for (const line of output.split(/\r?\n/)) {
    const activityMatch = line.match(/^\s*ACTIVITY\s+([a-zA-Z0-9_.]+)\/([^\s]+).*?\spid=(?!\(not running\))\S+/)
    if (activityMatch) {
      return normalizeForegroundApp(activityMatch[1], activityMatch[2])
    }
  }

  return null
}

export function parseResolvedActivity(output: string): string | null {
  const componentLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^[a-zA-Z0-9_.]+\/[a-zA-Z0-9_.$]+$/.test(line))

  return componentLine ?? null
}

function normalizeForegroundApp(packageName: string, activity: string): ForegroundAppInfo {
  return {
    packageName,
    activity: activity.replace(/[),]+$/, '')
  }
}

function assertSafePackageName(packageName: string): void {
  if (!/^[a-zA-Z0-9_.]+$/.test(packageName)) {
    throw new Error(`Invalid Android package name: ${packageName}`)
  }
}

function assertSafeComponentName(componentName: string): void {
  if (!/^[a-zA-Z0-9_.]+\/[a-zA-Z0-9_.$]+$/.test(componentName)) {
    throw new Error(`Invalid Android component name: ${componentName}`)
  }
}

function getBoundsCenter(bounds: string): { x: number; y: number } | null {
  const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
  if (!match) return null

  return {
    x: Math.round((Number(match[1]) + Number(match[3])) / 2),
    y: Math.round((Number(match[2]) + Number(match[4])) / 2)
  }
}

function findPermissionButtonCenter(uiXml: string, action: PermissionDialogAction): { x: number; y: number } | null {
  const patterns: Record<PermissionDialogAction, RegExp> = {
    allow: /(允许|同意|始终允许|仅在使用中允许|ALLOW|Allow|While using)/i,
    allow_once: /(仅本次允许|仅此一次|Only this time)/i,
    deny: /(拒绝|不允许|DENY|Deny|Don'?t allow)/i
  }
  const targetPattern = patterns[action]
  const nodePattern = /<node\b[^>]*>/g

  for (const nodeMatch of uiXml.matchAll(nodePattern)) {
    const node = nodeMatch[0]
    const text = `${node.match(/\btext="([^"]*)"/)?.[1] ?? ''} ${node.match(/\bcontent-desc="([^"]*)"/)?.[1] ?? ''}`
    const bounds = node.match(/\bbounds="([^"]+)"/)?.[1]
    if (bounds && targetPattern.test(text)) {
      return getBoundsCenter(bounds)
    }
  }

  return null
}

class DeviceService {
  private scrcpyProcesses: Map<string, ScrcpyProcess> = new Map()
  private toolPathsReady: Promise<void> | null = null
  private scrcpyStoppedListeners = new Set<(payload: { deviceId: string }) => void>()
  private scrcpyWindowTitlePrefix = 'Mobile-OpenClaw'

  private async ensureToolPathsInitialized(): Promise<void> {
    this.toolPathsReady ??= initializeToolPaths()
    await this.toolPathsReady
  }

  private getAdbPath(): string {
    return toolPathManager.getToolPaths().adbPath
  }

  private getScrcpyPath(): string {
    return toolPathManager.getToolPaths().scrcpyPath
  }

  private createScrcpyWindowTitle(deviceId: string): string {
    return `${this.scrcpyWindowTitlePrefix}:${deviceId}:${randomUUID().slice(0, 8)}`
  }

  onScrcpyStopped(listener: (payload: { deviceId: string }) => void): () => void {
    this.scrcpyStoppedListeners.add(listener)
    return () => {
      this.scrcpyStoppedListeners.delete(listener)
    }
  }

  private notifyScrcpyStopped(deviceId: string): void {
    for (const listener of this.scrcpyStoppedListeners) {
      listener({ deviceId })
    }
  }

  async scanDevices(): Promise<DeviceInfo[]> {
    try {
      await this.ensureToolPathsInitialized()

      const { stdout } = await execFileAsync(this.getAdbPath(), ['devices', '-l'])
      const adbDevices = parseAdbDevicesOutput(stdout)
      const devices: DeviceInfo[] = []

      for (const adbDevice of adbDevices) {
        const deviceInfo: DeviceInfo = {
          id: adbDevice.serial,
          name: adbDevice.serial,
          status: normalizeAdbStatus(adbDevice.status)
        }

        if (deviceInfo.status === 'online') {
          try {
            const [model, brand, androidVersion, screenSize, density] = await Promise.all([
              this.getDeviceProperty(adbDevice.serial, 'ro.product.model'),
              this.getDeviceProperty(adbDevice.serial, 'ro.product.brand'),
              this.getDeviceProperty(adbDevice.serial, 'ro.build.version.release'),
              this.getScreenSize(adbDevice.serial),
              this.getDeviceProperty(adbDevice.serial, 'ro.sf.lcd_density')
            ])

            deviceInfo.model = model || undefined
            deviceInfo.brand = brand || undefined
            deviceInfo.androidVersion = androidVersion || undefined
            deviceInfo.screenSize = screenSize || undefined
            deviceInfo.density = density || undefined
            deviceInfo.name = [brand, model].filter(Boolean).join(' ') || adbDevice.serial
          } catch (error) {
            logger.warn('Failed to get device details', { deviceId: adbDevice.serial, error })
          }
        }

        devices.push(deviceInfo)
      }

      return devices
    } catch (error) {
      logger.error('Failed to scan devices', { error, adbPath: this.getAdbPath() })
      throw error
    }
  }

  private async getDeviceProperty(serial: string, property: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(this.getAdbPath(), ['-s', serial, 'shell', 'getprop', property])
      return stdout.trim() || null
    } catch (error) {
      logger.debug('Failed to read device property', { serial, property, error })
      return null
    }
  }

  private async getScreenSize(serial: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(this.getAdbPath(), ['-s', serial, 'shell', 'wm', 'size'])
      const match = stdout.match(/Physical size: (\d+x\d+)/)
      return match ? match[1] : null
    } catch (error) {
      logger.debug('Failed to read screen size', { serial, error })
      return null
    }
  }

  async getDeviceScreenSize(deviceId: string): Promise<DeviceScreenSize> {
    try {
      const output = await this.executeAdbCommand(deviceId, 'shell wm size')
      const match = output.match(/(\d+)\s*x\s*(\d+)/)
      if (!match) {
        throw new Error(`Unable to parse device screen size: ${output}`)
      }

      return {
        width: Number(match[1]),
        height: Number(match[2])
      }
    } catch (error) {
      logger.error('Failed to get device screen size', { error, deviceId })
      throw error
    }
  }

  async executeAdbCommand(deviceId: string, command: string, options: { maxBuffer?: number } = {}): Promise<string> {
    try {
      await this.ensureToolPathsInitialized()

      if (!deviceId || deviceId === 'undefined') {
        throw new Error('Invalid deviceId: deviceId is required and cannot be undefined')
      }

      let actualCommand = command
      const adbPrefixMatch = command.match(/^adb\s+-s\s+\S+\s+(.+)$/)
      if (adbPrefixMatch) {
        logger.warn('Command contains adb prefix, extracting actual command', { command })
        actualCommand = adbPrefixMatch[1]
      }

      const fullCommand = `"${this.getAdbPath()}" -s ${deviceId} ${actualCommand}`
      logger.info('Executing ADB command', { deviceId, command: actualCommand, fullCommand })
      const { stdout, stderr } = await execAsync(fullCommand, {
        maxBuffer: options.maxBuffer
      })

      if (stderr) {
        logger.warn('ADB command stderr', { stderr })
      }

      return stdout.trim()
    } catch (error) {
      logger.error('ADB command failed', { error, deviceId, command })
      throw error
    }
  }

  async startScrcpy(
    deviceId: string,
    options: {
      port?: number
      maxSize?: number
      bitRate?: number
      maxFps?: number
    } = {}
  ): Promise<{ port: number; process: ReturnType<typeof spawn> }> {
    try {
      await this.ensureToolPathsInitialized()

      const port = options.port || 8080
      const maxSize = options.maxSize || 1024
      const bitRate = options.bitRate || 8000000
      const maxFps = options.maxFps || 30
      const windowTitle = this.createScrcpyWindowTitle(deviceId)

      const deviceStatus = await this.checkDeviceStatus(deviceId)
      if (deviceStatus !== 'online') {
        throw new Error(`Device is not online: ${deviceStatus}`)
      }

      await this.stopScrcpy(deviceId)

      const scrcpyArgs = [
        '-s',
        deviceId,
        '--window-title',
        windowTitle,
        '--max-size',
        String(maxSize),
        '--video-bit-rate',
        String(bitRate),
        '--max-fps',
        String(maxFps),
        '--no-audio'
      ]

      const scrcpyPath = this.getScrcpyPath()
      logger.info('Starting Scrcpy', { command: scrcpyPath, args: scrcpyArgs })

      const process = spawn(scrcpyPath, scrcpyArgs, {
        windowsHide: false,
        shell: false
      })

      let stderrOutput = ''
      let stdoutOutput = ''

      process.stderr?.on('data', (chunk) => {
        const text = String(chunk)
        stderrOutput = `${stderrOutput}${text}`.slice(-2000)
        if (text.trim()) {
          logger.warn('Scrcpy stderr', { deviceId, stderr: text.trim() })
        }
      })

      process.stdout?.on('data', (chunk) => {
        const text = String(chunk)
        stdoutOutput = `${stdoutOutput}${text}`.slice(-2000)
      })

      const startup = await new Promise<{ started: boolean; errorMessage?: string }>((resolve) => {
        const cleanup = () => {
          clearTimeout(timer)
          process.off('error', onError)
          process.off('exit', onExit)
        }

        const onError = (error: Error) => {
          cleanup()
          resolve({ started: false, errorMessage: `Scrcpy process error: ${error.message}` })
        }

        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup()
          const output = (stderrOutput || stdoutOutput || '').trim()
          resolve({
            started: false,
            errorMessage: `Scrcpy exited early (code=${code ?? 'null'}, signal=${signal ?? 'null'})${output ? `: ${output}` : ''}`
          })
        }

        const timer = setTimeout(() => {
          cleanup()
          resolve({ started: true })
        }, 1200)

        process.once('error', onError)
        process.once('exit', onExit)
      })

      if (!startup.started) {
        try {
          process.kill()
        } catch {
          // Process already exited.
        }
        throw new Error(startup.errorMessage || 'Scrcpy startup failed')
      }

      const scrcpyProcess: ScrcpyProcess = {
        deviceId,
        process,
        port,
        windowTitle
      }

      this.scrcpyProcesses.set(deviceId, scrcpyProcess)

      const handleProcessStopped = (reason: {
        code?: number | null
        signal?: NodeJS.Signals | null
        error?: Error
      }) => {
        const currentProcess = this.scrcpyProcesses.get(deviceId)
        if (currentProcess?.process !== process) return

        this.scrcpyProcesses.delete(deviceId)
        logger.info('Scrcpy process stopped', { deviceId, ...reason })
        this.notifyScrcpyStopped(deviceId)
      }

      process.once('exit', (code, signal) => {
        handleProcessStopped({ code, signal })
      })

      process.once('error', (error) => {
        handleProcessStopped({ error })
      })

      return { port, process }
    } catch (error) {
      logger.error('Failed to start Scrcpy', { error, deviceId })
      throw error
    }
  }

  async stopScrcpy(deviceId: string): Promise<void> {
    const existingProcess = this.scrcpyProcesses.get(deviceId)
    if (!existingProcess) return

    try {
      existingProcess.process.kill()
      this.scrcpyProcesses.delete(deviceId)
      logger.info('Stopped Scrcpy for device', { deviceId })
      this.notifyScrcpyStopped(deviceId)
    } catch (error) {
      logger.error('Failed to stop Scrcpy', { error, deviceId })
    }
  }

  async stopAllScrcpy(): Promise<void> {
    for (const [deviceId] of this.scrcpyProcesses) {
      await this.stopScrcpy(deviceId)
    }
  }

  async sendTap(deviceId: string, x: number, y: number): Promise<void> {
    try {
      await this.executeAdbCommand(deviceId, `shell input tap ${x} ${y}`)
      logger.info('Sent tap to device', { deviceId, x, y })
    } catch (error) {
      logger.error('Failed to send tap', { error, deviceId, x, y })
      throw error
    }
  }

  async sendDoubleTap(deviceId: string, x: number, y: number, interval: number = 120): Promise<void> {
    try {
      await this.sendTap(deviceId, x, y)
      await new Promise((resolve) => setTimeout(resolve, Math.max(30, Math.min(interval, 1000))))
      await this.sendTap(deviceId, x, y)
      logger.info('Sent double tap to device', { deviceId, x, y, interval })
    } catch (error) {
      logger.error('Failed to send double tap', { error, deviceId, x, y, interval })
      throw error
    }
  }

  async sendLongPress(deviceId: string, x: number, y: number, duration: number = 800): Promise<void> {
    try {
      await this.sendSwipe(deviceId, x, y, x, y, Math.max(300, Math.min(duration, 10000)))
      logger.info('Sent long press to device', { deviceId, x, y, duration })
    } catch (error) {
      logger.error('Failed to send long press', { error, deviceId, x, y, duration })
      throw error
    }
  }

  async sendSwipe(
    deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number = 500
  ): Promise<void> {
    try {
      await this.executeAdbCommand(deviceId, `shell input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`)
      logger.info('Sent swipe to device', { deviceId, x1, y1, x2, y2, duration })
    } catch (error) {
      logger.error('Failed to send swipe', { error, deviceId })
      throw error
    }
  }

  async sendDrag(
    deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number = 700
  ): Promise<void> {
    try {
      await this.sendSwipe(deviceId, x1, y1, x2, y2, Math.max(100, Math.min(duration, 10000)))
      logger.info('Sent drag to device', { deviceId, x1, y1, x2, y2, duration })
    } catch (error) {
      logger.error('Failed to send drag', { error, deviceId, x1, y1, x2, y2, duration })
      throw error
    }
  }

  async sendText(deviceId: string, text: string): Promise<void> {
    try {
      if (/^[\x20-\x7e]*$/.test(text)) {
        const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s/g, '%s')
        await this.executeAdbCommand(deviceId, `shell input text "${escapedText}"`)
      } else {
        await this.sendUnicodeText(deviceId, text)
      }
      logger.info('Sent text to device', { deviceId })
    } catch (error) {
      logger.error('Failed to send text', { error, deviceId })
      throw error
    }
  }

  private async sendUnicodeText(deviceId: string, text: string): Promise<void> {
    const inputMethods = await this.executeAdbCommand(deviceId, 'shell ime list -s')
    const adbKeyboardIme = inputMethods
      .split(/\r?\n/)
      .map((ime) => ime.trim())
      .find((ime) => /adbkeyboard|ADBKeyboard/i.test(ime))

    if (!adbKeyboardIme) {
      throw new Error(
        'Chinese input requires ADB Keyboard or another supported Unicode input bridge. Install and enable ADB Keyboard, then retry.'
      )
    }

    const currentImeOutput = await this.executeAdbCommand(deviceId, 'shell settings get secure default_input_method')
    const previousIme = currentImeOutput.trim()
    const textBase64 = Buffer.from(text, 'utf8').toString('base64')

    try {
      await this.executeAdbCommand(deviceId, `shell ime set ${adbKeyboardIme}`)
      await this.executeAdbCommand(deviceId, `shell am broadcast -a ADB_INPUT_B64 --es msg ${textBase64}`)
    } finally {
      if (previousIme && previousIme !== 'null' && previousIme !== adbKeyboardIme) {
        try {
          await this.executeAdbCommand(deviceId, `shell ime set ${previousIme}`)
        } catch (restoreError) {
          logger.warn('Failed to restore previous input method', { restoreError, deviceId, previousIme })
        }
      }
    }
  }

  async sendKeyEvent(deviceId: string, keyCode: number): Promise<void> {
    try {
      await this.executeAdbCommand(deviceId, `shell input keyevent ${keyCode}`)
      logger.info('Sent key event to device', { deviceId, keyCode })
    } catch (error) {
      logger.error('Failed to send key event', { error, deviceId, keyCode })
      throw error
    }
  }

  async startApp(deviceId: string, packageName: string): Promise<void> {
    try {
      assertSafePackageName(packageName)
      const resolvedActivityOutput = await this.executeAdbCommand(
        deviceId,
        `shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${packageName}`
      )
      const componentName = parseResolvedActivity(resolvedActivityOutput)

      if (componentName) {
        assertSafeComponentName(componentName)
        await this.executeAdbCommand(
          deviceId,
          `shell am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n ${componentName}`
        )
      } else {
        await this.executeAdbCommand(deviceId, `shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`)
      }

      logger.info('Started app on device', { deviceId, packageName })
    } catch (error) {
      logger.error('Failed to start app', { error, deviceId, packageName })
      throw error
    }
  }

  async stopApp(deviceId: string, packageName: string): Promise<void> {
    try {
      assertSafePackageName(packageName)
      await this.executeAdbCommand(deviceId, `shell am force-stop ${packageName}`)
      logger.info('Stopped app on device', { deviceId, packageName })
    } catch (error) {
      logger.error('Failed to stop app', { error, deviceId, packageName })
      throw error
    }
  }

  async restartApp(deviceId: string, packageName: string): Promise<void> {
    await this.stopApp(deviceId, packageName)
    await new Promise((resolve) => setTimeout(resolve, 500))
    await this.startApp(deviceId, packageName)
    logger.info('Restarted app on device', { deviceId, packageName })
  }

  async getForegroundApp(deviceId: string): Promise<ForegroundAppInfo> {
    const commands = ['shell dumpsys activity activities', 'shell dumpsys window windows', 'shell dumpsys activity top']
    const failures: string[] = []

    for (const command of commands) {
      try {
        const output = await this.executeAdbCommand(deviceId, command, { maxBuffer: ADB_TEXT_MAX_BUFFER })
        const info = parseForegroundAppInfo(output)
        if (info) return info
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${command}: ${message}`)
        logger.warn('Failed to parse foreground app from ADB source', { error, deviceId, command })
      }
    }

    const error = new Error(
      failures.length
        ? `Unable to parse foreground app from dumpsys output. Sources failed: ${failures.join('; ')}`
        : 'Unable to parse foreground app from dumpsys output'
    )
    logger.error('Failed to get foreground app', { error, deviceId })
    throw error
  }

  async handlePermissionDialog(deviceId: string, action: PermissionDialogAction): Promise<boolean> {
    try {
      await this.executeAdbCommand(deviceId, 'shell uiautomator dump /sdcard/mobile_openclaw_window.xml')
      const uiXml = await this.executeAdbCommand(deviceId, 'shell cat /sdcard/mobile_openclaw_window.xml')
      const center = findPermissionButtonCenter(uiXml, action)
      if (!center) {
        logger.info('No matching permission dialog button found', { deviceId, action })
        return false
      }

      await this.sendTap(deviceId, center.x, center.y)
      logger.info('Handled permission dialog', { deviceId, action, center })
      return true
    } catch (error) {
      logger.error('Failed to handle permission dialog', { error, deviceId, action })
      throw error
    }
  }

  async getScreenshot(deviceId: string): Promise<Buffer> {
    try {
      await this.ensureToolPathsInitialized()
      const { stdout } = await execFileAsync(this.getAdbPath(), ['-s', deviceId, 'exec-out', 'screencap', '-p'], {
        encoding: 'buffer',
        maxBuffer: SCREENSHOT_MAX_BUFFER
      })
      return Buffer.from(stdout)
    } catch (error) {
      logger.error('Failed to get screenshot', { error, deviceId })
      throw error
    }
  }

  getScrcpyWindowTitle(deviceId: string): string | null {
    const process = this.scrcpyProcesses.get(deviceId)
    return process?.windowTitle ?? null
  }

  async checkDeviceStatus(deviceId: string): Promise<DeviceInfo['status']> {
    try {
      await this.ensureToolPathsInitialized()
      const { stdout } = await execFileAsync(this.getAdbPath(), ['-s', deviceId, 'get-state'])
      return normalizeAdbStatus(stdout.trim())
    } catch (error) {
      logger.error('Failed to check device status', { error, deviceId })
      return 'offline'
    }
  }

  async detectToolPaths(): Promise<{ adbPath?: string; scrcpyPath?: string }> {
    try {
      await this.ensureToolPathsInitialized()
      return {
        adbPath: this.getAdbPath(),
        scrcpyPath: this.getScrcpyPath()
      }
    } catch (error) {
      logger.error('Failed to detect tool paths', { error })
      return {}
    }
  }
}

export const deviceService = new DeviceService()
