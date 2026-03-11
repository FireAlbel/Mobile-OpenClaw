#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  ToolSchema
} from '@modelcontextprotocol/sdk/types.js'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { loggerService } from '@logger'

const logger = loggerService.withContext('DeviceControlMCP')
const execAsync = promisify(exec)

interface DeviceInfo {
  id: string
  name: string
  status: 'online' | 'offline' | 'unauthorized'
  model?: string
  brand?: string
  androidVersion?: string
  screenSize?: string
  density?: string
}

interface ScrcpyOptions {
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

class DeviceControlMCPServer {
  private server: Server
  private adbPath: string = 'adb'
  private scrcpyPath: string = 'scrcpy'
  private scrcpyProcesses: Map<string, any> = new Map()

  constructor() {
    this.server = new Server(
      {
        name: 'device-control-mcp',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    )

    this.setupTools()
    this.server.onerror = (error) => logger.error('MCP Server Error:', error)
    process.on('SIGINT', async () => {
      await this.cleanup()
      process.exit(0)
    })
  }

  private setupTools() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_devices',
          description: 'List all connected Android devices',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'get_device_info',
          description: 'Get detailed information about a specific device',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: {
                type: 'string',
                description: 'The device serial number'
              }
            },
            required: ['deviceId']
          }
        },
        {
          name: 'start_scrcpy',
          description: 'Start screen mirroring for a device using scrcpy',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: {
                type: 'string',
                description: 'The device serial number'
              },
              options: {
                type: 'object',
                properties: {
                  maxSize: { type: 'number', description: 'Maximum size of the video (e.g., 1024)' },
                  bitRate: { type: 'number', description: 'Video bit rate in bits per second (e.g., 8000000)' },
                  maxFps: { type: 'number', description: 'Maximum frames per second (e.g., 30)' },
                  stayAwake: { type: 'boolean', description: 'Keep device awake' },
                  turnScreenOff: { type: 'boolean', description: 'Turn screen off when mirroring starts' },
                  noAudio: { type: 'boolean', description: 'Disable audio forwarding' },
                  showTouches: { type: 'boolean', description: 'Show touch events' },
                  windowTitle: { type: 'string', description: 'Set window title' },
                  alwaysOnTop: { type: 'boolean', description: 'Keep window always on top' },
                  fullscreen: { type: 'boolean', description: 'Start in fullscreen mode' },
                  borderless: { type: 'boolean', description: 'Start in borderless mode' },
                  windowX: { type: 'number', description: 'Window X position' },
                  windowY: { type: 'number', description: 'Window Y position' },
                  windowWidth: { type: 'number', description: 'Window width' },
                  windowHeight: { type: 'number', description: 'Window height' }
                }
              }
            },
            required: ['deviceId']
          }
        },
        {
          name: 'stop_scrcpy',
          description: 'Stop screen mirroring for a device',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: {
                type: 'string',
                description: 'The device serial number'
              }
            },
            required: ['deviceId']
          }
        },
        {
          name: 'send_tap',
          description: 'Send tap event to device',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: {
                type: 'string',
                description: 'The device serial number'
              },
              x: { type: 'number', description: 'X coordinate' },
              y: { type: 'number', description: 'Y coordinate' }
            },
            required: ['deviceId', 'x', 'y']
          }
        },
        {
          name: 'send_swipe',
          description: 'Send swipe event to device',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: {
                type: 'string',
                description: 'The device serial number'
              },
              startX: { type: 'number', description: 'Start X coordinate' },
              startY: { type: 'number', description: 'Start Y coordinate' },
              endX: { type: 'number', description: 'End X coordinate' },
              endY: { type: 'number', description: 'End Y coordinate' },
              duration: { type: 'number', description: 'Swipe duration in milliseconds (default: 500)' }
            },
            required: ['deviceId', 'startX', 'startY', 'endX', 'endY']
          }
        },
        {
          name: 'send_text',
          description: 'Send text input to device',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: {
                type: 'string',
                description: 'The device serial number'
              },
              text: { type: 'string', description: 'Text to input' }
            },
            required: ['deviceId', 'text']
          }
        },
        {
          name: 'send_key_event',
          description: 'Send key event to device',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: {
                type: 'string',
                description: 'The device serial number'
              },
              keyCode: { type: 'number', description: 'Android key code' }
            },
            required: ['deviceId', 'keyCode']
          }
        },
        {
          name: 'install_apk',
          description: 'Install APK on device',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: {
                type: 'string',
                description: 'The device serial number'
              },
              apkPath: { type: 'string', description: 'Path to APK file' }
            },
            required: ['deviceId', 'apkPath']
          }
        },
        {
          name: 'uninstall_package',
          description: 'Uninstall package from device',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: {
                type: 'string',
                description: 'The device serial number'
              },
              packageName: { type: 'string', description: 'Package name to uninstall' }
            },
            required: ['deviceId', 'packageName']
          }
        },
        {
          name: 'execute_adb_command',
          description: 'Execute raw ADB command',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: {
                type: 'string',
                description: 'The device serial number'
              },
              command: { type: 'string', description: 'ADB command to execute' }
            },
            required: ['deviceId', 'command']
          }
        },
        {
          name: 'get_screenshot',
          description: 'Take screenshot of device',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: {
                type: 'string',
                description: 'The device serial number'
              }
            },
            required: ['deviceId']
          }
        },
        {
          name: 'get_device_property',
          description: 'Get device property',
          inputSchema: {
            type: 'object',
            properties: {
              deviceId: {
                type: 'string',
                description: 'The device serial number'
              },
              property: { type: 'string', description: 'Property name (e.g., ro.product.model)' }
            },
            required: ['deviceId', 'property']
          }
        }
      ]
    }))

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      try {
        switch (name) {
          case 'list_devices':
            return await this.listDevices()

          case 'get_device_info':
            return await this.getDeviceInfo(args.deviceId)

          case 'start_scrcpy':
            return await this.startScrcpy(args.deviceId, args.options || {})

          case 'stop_scrcpy':
            return await this.stopScrcpy(args.deviceId)

          case 'send_tap':
            return await this.sendTap(args.deviceId, args.x, args.y)

          case 'send_swipe':
            return await this.sendSwipe(args.deviceId, args.startX, args.startY, args.endX, args.endY, args.duration)

          case 'send_text':
            return await this.sendText(args.deviceId, args.text)

          case 'send_key_event':
            return await this.sendKeyEvent(args.deviceId, args.keyCode)

          case 'install_apk':
            return await this.installApk(args.deviceId, args.apkPath)

          case 'uninstall_package':
            return await this.uninstallPackage(args.deviceId, args.packageName)

          case 'execute_adb_command':
            return await this.executeAdbCommand(args.deviceId, args.command)

          case 'get_screenshot':
            return await this.getScreenshot(args.deviceId)

          case 'get_device_property':
            return await this.getDeviceProperty(args.deviceId, args.property)

          default:
            throw new Error(`Unknown tool: ${name}`)
        }
      } catch (error) {
        logger.error(`Error executing tool ${name}:`, error)
        throw error
      }
    })
  }

  private async listDevices(): Promise<any> {
    try {
      const { stdout } = await execAsync(`${this.adbPath} devices -l`)
      const devices: DeviceInfo[] = []
      const lines = stdout.trim().split('\n')

      // Skip header line
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

            // Try to get additional device info
            try {
              const model = await this.getDeviceProperty(serial, 'ro.product.model')
              const brand = await this.getDeviceProperty(serial, 'ro.product.brand')
              const androidVersion = await this.getDeviceProperty(serial, 'ro.build.version.release')
              const screenSize = await this.getScreenSize(serial)
              const density = await this.getDeviceProperty(serial, 'ro.sf.lcd_density')

              deviceInfo.name = `${brand || 'Unknown'} ${model || 'Device'}`
              deviceInfo.model = model || undefined
              deviceInfo.brand = brand || undefined
              deviceInfo.androidVersion = androidVersion || undefined
              deviceInfo.screenSize = screenSize || undefined
              deviceInfo.density = density || undefined
            } catch (error) {
              logger.warn('Failed to get device details:', error)
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

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(devices, null, 2)
          }
        ]
      }
    } catch (error) {
      throw new Error(`Failed to list devices: ${error}`)
    }
  }

  private async getDeviceInfo(deviceId: string): Promise<any> {
    try {
      const deviceInfo: Partial<DeviceInfo> = { id: deviceId }

      // Get basic device properties
      const properties = [
        'ro.product.model',
        'ro.product.brand',
        'ro.product.name',
        'ro.build.version.release',
        'ro.build.version.sdk',
        'ro.build.version.incremental',
        'ro.build.fingerprint',
        'ro.sf.lcd_density',
        'ro.screen.density',
        'ro.product.cpu.abi'
      ]

      for (const prop of properties) {
        try {
          const value = await this.getDeviceProperty(deviceId, prop)
          if (value) {
            const key = prop.replace('ro.', '').replace(/\./g, '_')
            ;(deviceInfo as any)[key] = value
          }
        } catch (error) {
          logger.debug(`Failed to get property ${prop}:`, error)
        }
      }

      // Get screen size
      deviceInfo.screenSize = await this.getScreenSize(deviceId)

      // Get device status
      try {
        const { stdout } = await execAsync(`${this.adbPath} -s ${deviceId} get-state`)
        const status = stdout.trim()
        deviceInfo.status = status === 'device' ? 'online' : status === 'offline' ? 'offline' : 'unauthorized'
      } catch (error) {
        deviceInfo.status = 'offline'
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(deviceInfo, null, 2)
          }
        ]
      }
    } catch (error) {
      throw new Error(`Failed to get device info: ${error}`)
    }
  }

  private async startScrcpy(deviceId: string, options: ScrcpyOptions = {}): Promise<any> {
    try {
      // Check device status first
      const deviceStatus = await this.checkDeviceStatus(deviceId)
      if (deviceStatus !== 'online') {
        throw new Error(`Device is not online: ${deviceStatus}`)
      }

      // Stop existing scrcpy process for this device
      await this.stopScrcpy(deviceId)

      const scrcpyArgs = ['-s', deviceId]

      // Add scrcpy options
      if (options.maxSize) scrcpyArgs.push('--max-size', String(options.maxSize))
      if (options.bitRate) scrcpyArgs.push('--video-bit-rate', String(options.bitRate))
      if (options.maxFps) scrcpyArgs.push('--max-fps', String(options.maxFps))
      if (options.stayAwake) scrcpyArgs.push('--stay-awake')
      if (options.turnScreenOff) scrcpyArgs.push('--turn-screen-off')
      if (options.noAudio) scrcpyArgs.push('--no-audio')
      if (options.showTouches) scrcpyArgs.push('--show-touches')
      if (options.windowTitle) scrcpyArgs.push('--window-title', options.windowTitle)
      if (options.alwaysOnTop) scrcpyArgs.push('--always-on-top')
      if (options.fullscreen) scrcpyArgs.push('--fullscreen')
      if (options.borderless) scrcpyArgs.push('--borderless')
      if (options.windowX !== undefined) scrcpyArgs.push('--window-x', String(options.windowX))
      if (options.windowY !== undefined) scrcpyArgs.push('--window-y', String(options.windowY))
      if (options.windowWidth !== undefined) scrcpyArgs.push('--window-width', String(options.windowWidth))
      if (options.windowHeight !== undefined) scrcpyArgs.push('--window-height', String(options.windowHeight))

      logger.info('Starting Scrcpy with args:', { args: scrcpyArgs })

      const process = spawn(this.scrcpyPath, scrcpyArgs, {
        windowsHide: false,
        shell: false
      })

      let stderrOutput = ''
      let stdoutOutput = ''

      process.stderr?.on('data', (chunk) => {
        const text = String(chunk)
        stderrOutput += text
        if (text.trim()) {
          logger.info('Scrcpy stderr:', text.trim())
        }
      })

      process.stdout?.on('data', (chunk) => {
        const text = String(chunk)
        stdoutOutput += text
      })

      // Store process reference
      this.scrcpyProcesses.set(deviceId, process)

      // Wait a bit to see if process starts successfully
      await new Promise((resolve) => setTimeout(resolve, 1000))

      return {
        content: [
          {
            type: 'text',
            text: `Started Scrcpy for device ${deviceId}. Process PID: ${process.pid}`
          }
        ]
      }
    } catch (error) {
      throw new Error(`Failed to start Scrcpy: ${error}`)
    }
  }

  private async stopScrcpy(deviceId: string): Promise<any> {
    const process = this.scrcpyProcesses.get(deviceId)
    if (process) {
      try {
        process.kill()
        this.scrcpyProcesses.delete(deviceId)
        logger.info(`Stopped Scrcpy for device: ${deviceId}`)

        return {
          content: [
            {
              type: 'text',
              text: `Successfully stopped Scrcpy for device ${deviceId}`
            }
          ]
        }
      } catch (error) {
        logger.error(`Failed to stop Scrcpy:`, error)
        throw new Error(`Failed to stop Scrcpy: ${error}`)
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: `No Scrcpy process found for device ${deviceId}`
        }
      ]
    }
  }

  private async sendTap(deviceId: string, x: number, y: number): Promise<any> {
    try {
      const command = `${this.adbPath} -s ${deviceId} shell input tap ${x} ${y}`
      await execAsync(command)

      return {
        content: [
          {
            type: 'text',
            text: `Sent tap to device ${deviceId} at (${x}, ${y})`
          }
        ]
      }
    } catch (error) {
      throw new Error(`Failed to send tap: ${error}`)
    }
  }

  private async sendSwipe(deviceId: string, startX: number, startY: number, endX: number, endY: number, duration: number = 500): Promise<any> {
    try {
      const command = `${this.adbPath} -s ${deviceId} shell input swipe ${startX} ${startY} ${endX} ${endY} ${duration}`
      await execAsync(command)

      return {
        content: [
          {
            type: 'text',
            text: `Sent swipe to device ${deviceId} from (${startX}, ${startY}) to (${endX}, ${endY}) with duration ${duration}ms`
          }
        ]
      }
    } catch (error) {
      throw new Error(`Failed to send swipe: ${error}`)
    }
  }

  private async sendText(deviceId: string, text: string): Promise<any> {
    try {
      // Escape special characters
      const escapedText = text.replace(/"/g, '\\"')
      const command = `${this.adbPath} -s ${deviceId} shell input text "${escapedText}"`
      await execAsync(command)

      return {
        content: [
          {
            type: 'text',
            text: `Sent text to device ${deviceId}: ${text}`
          }
        ]
      }
    } catch (error) {
      throw new Error(`Failed to send text: ${error}`)
    }
  }

  private async sendKeyEvent(deviceId: string, keyCode: number): Promise<any> {
    try {
      const command = `${this.adbPath} -s ${deviceId} shell input keyevent ${keyCode}`
      await execAsync(command)

      return {
        content: [
          {
            type: 'text',
            text: `Sent key event to device ${deviceId}: ${keyCode}`
          }
        ]
      }
    } catch (error) {
      throw new Error(`Failed to send key event: ${error}`)
    }
  }

  private async installApk(deviceId: string, apkPath: string): Promise<any> {
    try {
      const command = `${this.adbPath} -s ${deviceId} install "${apkPath}"`
      const { stdout } = await execAsync(command)

      return {
        content: [
          {
            type: 'text',
            text: `Installed APK on device ${deviceId}: ${stdout}`
          }
        ]
      }
    } catch (error) {
      throw new Error(`Failed to install APK: ${error}`)
    }
  }

  private async uninstallPackage(deviceId: string, packageName: string): Promise<any> {
    try {
      const command = `${this.adbPath} -s ${deviceId} uninstall ${packageName}`
      const { stdout } = await execAsync(command)

      return {
        content: [
          {
            type: 'text',
            text: `Uninstalled package from device ${deviceId}: ${stdout}`
          }
        ]
      }
    } catch (error) {
      throw new Error(`Failed to uninstall package: ${error}`)
    }
  }

  private async executeAdbCommand(deviceId: string, command: string): Promise<any> {
    try {
      const fullCommand = `${this.adbPath} -s ${deviceId} ${command}`
      const { stdout, stderr } = await execAsync(fullCommand)

      return {
        content: [
          {
            type: 'text',
            text: `ADB command result:\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`
          }
        ]
      }
    } catch (error) {
      throw new Error(`Failed to execute ADB command: ${error}`)
    }
  }

  private async getScreenshot(deviceId: string): Promise<any> {
    try {
      const command = `${this.adbPath} -s ${deviceId} shell screencap -p`
      const { stdout } = await execAsync(command)

      // Convert binary to base64 for transport
      const screenshotBuffer = Buffer.from(stdout, 'binary')
      const base64Screenshot = screenshotBuffer.toString('base64')

      return {
        content: [
          {
            type: 'text',
            text: `Screenshot captured from device ${deviceId}`
          },
          {
            type: 'image',
            data: base64Screenshot,
            mimeType: 'image/png'
          }
        ]
      }
    } catch (error) {
      throw new Error(`Failed to get screenshot: ${error}`)
    }
  }

  private async getDeviceProperty(deviceId: string, property: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${deviceId} shell getprop ${property}`)
      return stdout.trim() || null
    } catch (error) {
      logger.debug(`Failed to get device property ${property}:`, error)
      return null
    }
  }

  private async getScreenSize(deviceId: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`${this.adbPath} -s ${deviceId} shell wm size`)
      const match = stdout.match(/Physical size: (\d+x\d+)/)
      return match ? match[1] : null
    } catch (error) {
      logger.debug('Failed to get screen size:', error)
      return null
    }
  }

  private async checkDeviceStatus(deviceId: string): Promise<'online' | 'offline' | 'unauthorized'> {
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
      logger.error('Failed to check device status:', error)
      return 'offline'
    }
  }

  private async cleanup(): Promise<void> {
    // Stop all scrcpy processes
    for (const [deviceId, process] of this.scrcpyProcesses) {
      try {
        process.kill()
        logger.info(`Cleaned up Scrcpy process for device: ${deviceId}`)
      } catch (error) {
        logger.error(`Failed to cleanup Scrcpy process for device ${deviceId}:`, error)
      }
    }
    this.scrcpyProcesses.clear()
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
    logger.info('Device Control MCP Server started')
  }
}

async function main() {
  const server = new DeviceControlMCPServer()
  await server.run()
}

main().catch((error) => {
  logger.error('Server error:', error)
  process.exit(1)
})
