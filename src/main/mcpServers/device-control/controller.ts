import { loggerService } from '@logger'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'

const logger = loggerService.withContext('DeviceControlController')
const execAsync = promisify(exec)

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

export interface ScrcpyOptions {
  maxSize?: number
  bitRate?: number
  maxFps?: number
  stayAwake?: boolean
  turnScreenOff?: boolean
  noAudio?: boolean
  showTouches?: boolean
  windowTitle?: string
  alwaysOnTop?: boolean
  fullscreen?: boolean
  borderless?: boolean
  windowX?: number
  windowY?: number
  windowWidth?: number
  windowHeight?: number
}

export class DeviceController {
  private adbPath: string = 'adb'
  private scrcpyPath: string = 'scrcpy'
  private scrcpyProcesses: Map<string, any> = new Map()

  async listDevices(): Promise<DeviceInfo[]> {
    try {
      const { stdout } = await execAsync(`${this.adbPath} devices -l`)
      const lines = stdout.trim().split('\n').slice(1) // Skip header

      const devices: DeviceInfo[] = []

      for (const line of lines) {
        const [id, status, ...details] = line.trim().split(/\s+/)
        if (id && status) {
          const deviceInfo: DeviceInfo = {
            id,
            name: id,
            status: status === 'device' ? 'online' : status === 'offline' ? 'offline' : 'unauthorized'
          }

          // Parse additional details
          for (const detail of details) {
            if (detail.startsWith('model:')) {
              deviceInfo.model = detail.substring(6)
            } else if (detail.startsWith('device:')) {
              deviceInfo.brand = detail.substring(7)
            }
          }

          devices.push(deviceInfo)
        }
      }

      return devices
    } catch (error) {
      logger.error('Failed to list devices', error as Error)
      throw new Error('Failed to list devices: ' + (error as Error).message)
    }
  }

  async getDeviceInfo(deviceId: string): Promise<Record<string, any>> {
    try {
      const commands = [
        `${this.adbPath} -s ${deviceId} shell getprop ro.product.model`,
        `${this.adbPath} -s ${deviceId} shell getprop ro.product.brand`,
        `${this.adbPath} -s ${deviceId} shell getprop ro.build.version.release`,
        `${this.adbPath} -s ${deviceId} shell wm size`,
        `${this.adbPath} -s ${deviceId} shell wm density`
      ]

      const results = await Promise.allSettled(
        commands.map((cmd) => execAsync(cmd).then((result) => result.stdout.trim()))
      )

      return {
        model: results[0].status === 'fulfilled' ? results[0].value : 'Unknown',
        brand: results[1].status === 'fulfilled' ? results[1].value : 'Unknown',
        androidVersion: results[2].status === 'fulfilled' ? results[2].value : 'Unknown',
        screenSize: results[3].status === 'fulfilled' ? results[3].value : 'Unknown',
        density: results[4].status === 'fulfilled' ? results[4].value : 'Unknown'
      }
    } catch (error) {
      logger.error('Failed to get device info', error as Error)
      throw new Error('Failed to get device info: ' + (error as Error).message)
    }
  }

  async startScrcpy(deviceId: string, options: ScrcpyOptions = {}): Promise<{ success: boolean; message: string }> {
    try {
      // Check if scrcpy is already running for this device
      if (this.scrcpyProcesses.has(deviceId)) {
        return { success: false, message: 'Scrcpy is already running for this device' }
      }

      // Build scrcpy command
      const args = [`--serial=${deviceId}`]

      if (options.maxSize) args.push(`--max-size=${options.maxSize}`)
      if (options.bitRate) args.push(`--bit-rate=${options.bitRate}`)
      if (options.maxFps) args.push(`--max-fps=${options.maxFps}`)
      if (options.stayAwake) args.push('--stay-awake')
      if (options.turnScreenOff) args.push('--turn-screen-off')
      if (options.noAudio) args.push('--no-audio')
      if (options.showTouches) args.push('--show-touches')
      if (options.windowTitle) args.push(`--window-title=${options.windowTitle}`)
      if (options.alwaysOnTop) args.push('--always-on-top')
      if (options.fullscreen) args.push('--fullscreen')
      if (options.borderless) args.push('--borderless')
      if (options.windowX !== undefined) args.push(`--window-x=${options.windowX}`)
      if (options.windowY !== undefined) args.push(`--window-y=${options.windowY}`)
      if (options.windowWidth) args.push(`--window-width=${options.windowWidth}`)
      if (options.windowHeight) args.push(`--window-height=${options.windowHeight}`)

      // Start scrcpy process
      const scrcpyProcess = spawn(this.scrcpyPath, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      })

      this.scrcpyProcesses.set(deviceId, scrcpyProcess)

      scrcpyProcess.on('close', (code) => {
        logger.info(`Scrcpy process for device ${deviceId} closed with code ${code}`)
        this.scrcpyProcesses.delete(deviceId)
      })

      scrcpyProcess.on('error', (error) => {
        logger.error(`Scrcpy process error for device ${deviceId}`, error)
        this.scrcpyProcesses.delete(deviceId)
      })

      return { success: true, message: 'Scrcpy started successfully' }
    } catch (error) {
      logger.error('Failed to start scrcpy', error as Error)
      throw new Error('Failed to start scrcpy: ' + (error as Error).message)
    }
  }

  async stopScrcpy(deviceId: string): Promise<{ success: boolean; message: string }> {
    try {
      const process = this.scrcpyProcesses.get(deviceId)
      if (process) {
        process.kill('SIGTERM')
        this.scrcpyProcesses.delete(deviceId)
        return { success: true, message: 'Scrcpy stopped successfully' }
      }

      return { success: false, message: 'No scrcpy process found for this device' }
    } catch (error) {
      logger.error('Failed to stop scrcpy', error as Error)
      throw new Error('Failed to stop scrcpy: ' + (error as Error).message)
    }
  }

  async sendTap(deviceId: string, x: number, y: number): Promise<{ success: boolean; message: string }> {
    try {
      const command = `${this.adbPath} -s ${deviceId} shell input tap ${x} ${y}`
      await execAsync(command)
      return { success: true, message: 'Tap event sent successfully' }
    } catch (error) {
      logger.error('Failed to send tap', error as Error)
      throw new Error('Failed to send tap: ' + (error as Error).message)
    }
  }

  async sendSwipe(
    deviceId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    duration: number = 500
  ): Promise<{ success: boolean; message: string }> {
    try {
      const command = `${this.adbPath} -s ${deviceId} shell input swipe ${startX} ${startY} ${endX} ${endY} ${duration}`
      await execAsync(command)
      return { success: true, message: 'Swipe event sent successfully' }
    } catch (error) {
      logger.error('Failed to send swipe', error as Error)
      throw new Error('Failed to send swipe: ' + (error as Error).message)
    }
  }

  async sendText(deviceId: string, text: string): Promise<{ success: boolean; message: string }> {
    try {
      const command = `${this.adbPath} -s ${deviceId} shell input text "${text.replace(/"/g, '\\"')}"`
      await execAsync(command)
      return { success: true, message: 'Text sent successfully' }
    } catch (error) {
      logger.error('Failed to send text', error as Error)
      throw new Error('Failed to send text: ' + (error as Error).message)
    }
  }

  async sendKeyEvent(deviceId: string, keyCode: number): Promise<{ success: boolean; message: string }> {
    try {
      const command = `${this.adbPath} -s ${deviceId} shell input keyevent ${keyCode}`
      await execAsync(command)
      return { success: true, message: 'Key event sent successfully' }
    } catch (error) {
      logger.error('Failed to send key event', error as Error)
      throw new Error('Failed to send key event: ' + (error as Error).message)
    }
  }

  async installApk(deviceId: string, apkPath: string): Promise<{ success: boolean; message: string }> {
    try {
      const command = `${this.adbPath} -s ${deviceId} install "${apkPath}"`
      const { stderr } = await execAsync(command)

      if (stderr && !stderr.includes('Success')) {
        throw new Error(stderr)
      }

      return { success: true, message: 'APK installed successfully' }
    } catch (error) {
      logger.error('Failed to install APK', error as Error)
      throw new Error('Failed to install APK: ' + (error as Error).message)
    }
  }

  async uninstallPackage(deviceId: string, packageName: string): Promise<{ success: boolean; message: string }> {
    try {
      const command = `${this.adbPath} -s ${deviceId} uninstall ${packageName}`
      const { stderr } = await execAsync(command)

      if (stderr && !stderr.includes('Success')) {
        throw new Error(stderr)
      }

      return { success: true, message: 'Package uninstalled successfully' }
    } catch (error) {
      logger.error('Failed to uninstall package', error as Error)
      throw new Error('Failed to uninstall package: ' + (error as Error).message)
    }
  }

  async executeAdbCommand(
    deviceId: string,
    command: string
  ): Promise<{ success: boolean; output: string; error?: string }> {
    try {
      // 验证 deviceId
      if (!deviceId || deviceId === 'undefined') {
        throw new Error('Invalid deviceId: deviceId is required and cannot be undefined')
      }

      // 检查 command 是否包含了 adb 命令前缀，如果是则提取实际的命令部分
      let actualCommand = command
      const adbPrefixMatch = command.match(/^adb\s+-s\s+\S+\s+(.+)$/)
      if (adbPrefixMatch) {
        logger.warn('Command contains adb prefix, extracting actual command:', { command })
        actualCommand = adbPrefixMatch[1]
      }

      const fullCommand = `${this.adbPath} -s ${deviceId} ${actualCommand}`
      logger.info('Executing ADB command:', { deviceId, command: actualCommand, fullCommand })
      const { stdout, stderr } = await execAsync(fullCommand)

      return {
        success: true,
        output: stdout,
        error: stderr || undefined
      }
    } catch (error) {
      logger.error('Failed to execute ADB command', error as Error)
      throw new Error('Failed to execute ADB command: ' + (error as Error).message)
    }
  }

  async getScreenshot(deviceId: string): Promise<{ success: boolean; base64Image?: string; message?: string }> {
    try {
      // Take screenshot and save to device
      const screenshotPath = '/sdcard/screenshot.png'
      await execAsync(`${this.adbPath} -s ${deviceId} shell screencap -p ${screenshotPath}`)

      // Pull screenshot from device
      const localPath = `/tmp/screenshot_${deviceId}_${Date.now()}.png`
      await execAsync(`${this.adbPath} -s ${deviceId} pull ${screenshotPath} ${localPath}`)

      // Read file and convert to base64
      const fs = require('fs')
      const imageBuffer = fs.readFileSync(localPath)
      const base64Image = imageBuffer.toString('base64')

      // Clean up
      fs.unlinkSync(localPath)
      await execAsync(`${this.adbPath} -s ${deviceId} shell rm ${screenshotPath}`)

      return {
        success: true,
        base64Image: `data:image/png;base64,${base64Image}`
      }
    } catch (error) {
      logger.error('Failed to get screenshot', error as Error)
      throw new Error('Failed to get screenshot: ' + (error as Error).message)
    }
  }

  async getDeviceProperty(deviceId: string, property: string): Promise<{ success: boolean; value: string }> {
    try {
      const command = `${this.adbPath} -s ${deviceId} shell getprop ${property}`
      const { stdout } = await execAsync(command)

      return {
        success: true,
        value: stdout.trim()
      }
    } catch (error) {
      logger.error('Failed to get device property', error as Error)
      throw new Error('Failed to get device property: ' + (error as Error).message)
    }
  }

  async cleanup(): Promise<void> {
    // Clean up all scrcpy processes
    for (const [deviceId, process] of this.scrcpyProcesses) {
      try {
        process.kill('SIGTERM')
        logger.info(`Cleaned up scrcpy process for device ${deviceId}`)
      } catch (error) {
        logger.error(`Failed to clean up scrcpy process for device ${deviceId}`, error as Error)
      }
    }
    this.scrcpyProcesses.clear()
  }
}
