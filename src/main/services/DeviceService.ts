import { loggerService } from '@logger'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'

const logger = loggerService.withContext('DeviceService')

const execAsync = promisify(exec)

export interface AdbDevice {
  serial: string
  status: 'device' | 'offline' | 'unauthorized' | 'bootloader'
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
  process: any
  port: number
}

class DeviceService {
  private scrcpyProcesses: Map<string, ScrcpyProcess> = new Map()
  private adbPath: string = 'adb'
  private scrcpyPath: string = 'scrcpy'

  constructor() {
    this.initializePaths()
  }

  private async initializePaths(): Promise<void> {
    const locator = process.platform === 'win32' ? 'where' : 'which'

    try {
      const { stdout } = await execAsync(`${locator} adb`)
      const detectedAdbPath = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
      if (detectedAdbPath) {
        this.adbPath = detectedAdbPath
      }
      logger.info('ADB found', { adbPath: this.adbPath })
    } catch {
      logger.warn('ADB not found in PATH, will attempt fallback paths')
    }

    try {
      const { stdout } = await execAsync(`${locator} scrcpy`)
      const detectedScrcpyPath = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean)
      if (detectedScrcpyPath) {
        this.scrcpyPath = detectedScrcpyPath
      }
      logger.info('Scrcpy found', { scrcpyPath: this.scrcpyPath })
    } catch {
      logger.warn('Scrcpy not found in PATH, will attempt fallback paths')
    }

    const fallbackPaths = await this.detectToolPaths()
    if (this.adbPath === 'adb' && fallbackPaths.adbPath) {
      this.adbPath = fallbackPaths.adbPath
    }
    if (this.scrcpyPath === 'scrcpy' && fallbackPaths.scrcpyPath) {
      this.scrcpyPath = fallbackPaths.scrcpyPath
    }

    logger.info('Device tool paths initialized', {
      adbPath: this.adbPath,
      scrcpyPath: this.scrcpyPath
    })
  }

  async scanDevices(): Promise<DeviceInfo[]> {
    try {
      const { stdout } = await execAsync(`${this.adbPath} devices -l`)
      logger.info('ADB devices output:', { output: stdout })

      const devices: DeviceInfo[] = []
      const lines = stdout.trim().split('\n')

      // 跳过第一行标题
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim()
        if (line && !line.startsWith('*')) {
          const parts = line.split(/\s+/)
          const serial = parts[0]
          const status = parts[1] as 'device' | 'offline' | 'unauthorized' | 'bootloader'

          if (status === 'device') {
            const deviceInfo: DeviceInfo = {
              id: serial,
              name: serial,
              status: 'online'
            }

            // 尝试获取设备详细信息
            try {
              const deviceName = await this.getDeviceName(serial)
              const model = await this.getDeviceProperty(serial, 'ro.product.model')
              const brand = await this.getDeviceProperty(serial, 'ro.product.brand')
              const androidVersion = await this.getDeviceProperty(serial, 'ro.build.version.release')
              const screenSize = await this.getScreenSize(serial)
              const density = await this.getDeviceProperty(serial, 'ro.sf.lcd_density')

              deviceInfo.name = deviceName || `${brand || 'Unknown'} ${model || 'Device'}`
              deviceInfo.model = model || undefined
              deviceInfo.brand = brand || undefined
              deviceInfo.androidVersion = androidVersion || undefined
              deviceInfo.screenSize = screenSize || undefined
              deviceInfo.density = density || undefined
            } catch (error) {
              logger.warn('Failed to get device details:', { error })
            }

            devices.push(deviceInfo)
          } else {
            devices.push({
              id: serial,
              name: serial,
              status: status as 'offline' | 'unauthorized'
            })
          }
        }
      }

      logger.info('Found devices:', { devices })
      return devices
    } catch (error) {
      logger.error('Failed to scan devices:', { error })
      return []
    }
  }

  private async getDeviceName(serial: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${serial} shell getprop ro.product.model`)
      return stdout.trim()
    } catch {
      return null
    }
  }

  private async getDeviceProperty(serial: string, property: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${serial} shell getprop ${property}`)
      return stdout.trim() || null
    } catch {
      return null
    }
  }

  private async getScreenSize(serial: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${serial} shell wm size`)
      const match = stdout.match(/Physical size: (\d+x\d+)/)
      return match ? match[1] : null
    } catch {
      return null
    }
  }

  async executeAdbCommand(deviceId: string, command: string): Promise<string> {
    try {
      const fullCommand = `${this.adbPath} -s ${deviceId} ${command}`
      logger.info('Executing ADB command:', { command: fullCommand })
      const { stdout, stderr } = await execAsync(fullCommand)

      if (stderr) {
        logger.warn('ADB command stderr:', { stderr })
      }

      return stdout.trim()
    } catch (error) {
      logger.error('ADB command failed:', { error })
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
  ): Promise<{ port: number; process: any }> {
    try {
      const port = options.port || 8080
      const maxSize = options.maxSize || 1024
      const bitRate = options.bitRate || 8000000
      const maxFps = options.maxFps || 30

      const deviceStatus = await this.checkDeviceStatus(deviceId)
      if (deviceStatus !== 'online') {
        throw new Error(`Device is not online: ${deviceStatus}`)
      }

      // 杀死可能存在的旧进程
      await this.stopScrcpy(deviceId)

      const scrcpyArgs = [
        '-s',
        deviceId,
        '--max-size',
        String(maxSize),
        '--video-bit-rate',
        String(bitRate),
        '--max-fps',
        String(maxFps)
        // 移除可能导致问题的参数，使用最简配置
      ]

      const fullCommand = `${this.scrcpyPath} ${scrcpyArgs.join(' ')}`
      logger.info('Starting Scrcpy with args:', { command: this.scrcpyPath, args: scrcpyArgs, fullCommand })

      // 使用直接执行方式，避免shell转义问题
      const process = spawn(this.scrcpyPath, scrcpyArgs, {
        windowsHide: false,  // 不隐藏窗口
        shell: false  // 不使用shell执行
      })

      let stderrOutput = ''
      let stdoutOutput = ''

      process.stderr?.on('data', (chunk) => {
        const text = String(chunk)
        stderrOutput = `${stderrOutput}${text}`.slice(-2000)
        if (text.trim()) {
          logger.warn('Scrcpy stderr:', { deviceId, stderr: text.trim() })
        }
      })

      process.stdout?.on('data', (chunk) => {
        const text = String(chunk)
        stdoutOutput = `${stdoutOutput}${text}`.slice(-2000)
      })

      const startup = await new Promise<{ started: boolean; errorMessage?: string }>((resolve) => {
        const timer = setTimeout(() => {
          cleanup()
          resolve({ started: true })
        }, 1200)

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

        process.once('error', onError)
        process.once('exit', onExit)
      })

      if (!startup.started) {
        try {
          process.kill()
        } catch {
          // ignore
        }
        throw new Error(startup.errorMessage || 'Scrcpy startup failed')
      }

      const scrcpyProcess: ScrcpyProcess = {
        deviceId,
        process,
        port
      }

      this.scrcpyProcesses.set(deviceId, scrcpyProcess)
      return { port, process }
    } catch (error) {
      logger.error('Failed to start Scrcpy:', { error, deviceId })
      throw error
    }
  }

  async stopScrcpy(deviceId: string): Promise<void> {
    const existingProcess = this.scrcpyProcesses.get(deviceId)
    if (existingProcess) {
      try {
        existingProcess.process.kill()
        this.scrcpyProcesses.delete(deviceId)
        logger.info('Stopped Scrcpy for device:', { deviceId })
      } catch (error) {
        logger.error('Failed to stop Scrcpy:', { error })
      }
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
      logger.error('Failed to send tap:', { error })
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
      logger.info('Sent swipe to device', { deviceId, x1, y1, x2, y2 })
    } catch (error) {
      logger.error('Failed to send swipe:', { error })
      throw error
    }
  }

  async sendText(deviceId: string, text: string): Promise<void> {
    try {
      // 转义特殊字符
      const escapedText = text.replace(/"/g, '\\"')
      await this.executeAdbCommand(deviceId, `shell input text "${escapedText}"`)
      logger.info('Sent text to device', { deviceId, text })
    } catch (error) {
      logger.error('Failed to send text:', { error })
      throw error
    }
  }

  async sendKeyEvent(deviceId: string, keyCode: number): Promise<void> {
    try {
      await this.executeAdbCommand(deviceId, `shell input keyevent ${keyCode}`)
      logger.info('Sent key event to device', { deviceId, keyCode })
    } catch (error) {
      logger.error('Failed to send key event:', { error })
      throw error
    }
  }

  async getScreenshot(deviceId: string): Promise<Buffer> {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${deviceId} shell screencap -p`)
      return Buffer.from(stdout, 'binary')
    } catch (error) {
      logger.error('Failed to get screenshot:', { error })
      throw error
    }
  }

  async checkDeviceStatus(deviceId: string): Promise<'online' | 'offline' | 'unauthorized'> {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${deviceId} get-state`)
      const status = stdout.trim()

      if (status === 'device') {
        return 'online'
      } else if (status === 'offline') {
        return 'offline'
      } else {
        return 'unauthorized'
      }
    } catch (error) {
      logger.error('Failed to check device status:', { error })
      return 'offline'
    }
  }

  async detectToolPaths(): Promise<{ adbPath?: string; scrcpyPath?: string }> {
    const paths: { adbPath?: string; scrcpyPath?: string } = {}

    try {
      // 检测ADB路径
      const adbPathsToCheck = [
        'adb',
        'D:\\goProject\\scrcpyPlugin\\platform-tools\\adb.exe',
        `${process.env.USERPROFILE}\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe`,
        'C:\\Program Files (x86)\\Android\\android-sdk\\platform-tools\\adb.exe'
      ]

      for (const path of adbPathsToCheck) {
        try {
          const result = await execAsync(`"${path}" version`)
          if (result.stdout && result.stdout.includes('Android Debug Bridge')) {
            paths.adbPath = path
            break
          }
        } catch (error) {
          // 继续尝试下一个路径
        }
      }

      // 检测Scrcpy路径
      const scrcpyPathsToCheck = [
        'scrcpy',
        'D:\\goProject\\scrcpyPlugin\\scrcpy.exe',
        'C:\\Program Files\\scrcpy\\scrcpy.exe',
        'C:\\Program Files (x86)\\scrcpy\\scrcpy.exe'
      ]

      for (const path of scrcpyPathsToCheck) {
        try {
          const result = await execAsync(`"${path}" --version`)
          if (result.stdout && result.stdout.includes('scrcpy')) {
            paths.scrcpyPath = path
            break
          }
        } catch (error) {
          // 继续尝试下一个路径
        }
      }

      logger.info('Detected tool paths:', { paths })
    } catch (error) {
      logger.error('Failed to detect tool paths:', { error })
    }

    return paths
  }
}

export const deviceService = new DeviceService()
