import { loggerService } from '@logger'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import { exec } from 'child_process'
import { promisify } from 'util'
import * as z from 'zod'

import { toolPathManager } from '../../utils/tool-paths'

const logger = loggerService.withContext('MCPServer:UiAutomator2')
const execAsync = promisify(exec)

// Define schemas for tool inputs
const ConnectDeviceSchema = z.object({
  deviceId: z
    .string()
    .optional()
    .describe('Device serial number (optional, uses first available device if not specified)'),
  host: z.string().optional().default('localhost').describe('Host for uiautomator2 server'),
  port: z.number().optional().default(9008).describe('Port for uiautomator2 server')
})

const FindElementSchema = z.object({
  selector: z
    .object({
      text: z.string().optional(),
      resourceId: z.string().optional(),
      className: z.string().optional(),
      description: z.string().optional(),
      packageName: z.string().optional()
    })
    .describe('Element selector criteria'),
  timeout: z.number().optional().default(10000).describe('Timeout in milliseconds')
})

const ClickElementSchema = z.object({
  selector: z
    .object({
      text: z.string().optional(),
      resourceId: z.string().optional(),
      className: z.string().optional(),
      description: z.string().optional(),
      packageName: z.string().optional()
    })
    .describe('Element selector criteria'),
  timeout: z.number().optional().default(10000).describe('Timeout in milliseconds'),
  offset: z
    .object({
      x: z.number().optional().default(0.5),
      y: z.number().optional().default(0.5)
    })
    .optional()
    .describe('Click offset (0-1) relative to element bounds'),
  randomize: z.boolean().optional().default(true).describe('Add randomness to click position to avoid bot detection')
})

const InputTextSchema = z.object({
  selector: z
    .object({
      text: z.string().optional(),
      resourceId: z.string().optional(),
      className: z.string().optional(),
      description: z.string().optional(),
      packageName: z.string().optional()
    })
    .describe('Element selector criteria'),
  text: z.string().describe('Text to input'),
  clearFirst: z.boolean().optional().default(true).describe('Whether to clear existing text before input'),
  useUiAutomator2: z
    .boolean()
    .optional()
    .default(true)
    .describe('Use UiAutomator2 for text input to avoid Chinese input issues')
})

const SwipeSchema = z.object({
  startX: z.number().describe('Start X coordinate'),
  startY: z.number().describe('Start Y coordinate'),
  endX: z.number().describe('End X coordinate'),
  endY: z.number().describe('End Y coordinate'),
  duration: z.number().optional().default(500).describe('Swipe duration in milliseconds'),
  randomize: z.boolean().optional().default(true).describe('Add randomness to swipe path to avoid bot detection')
})

const AppControlSchema = z.object({
  packageName: z.string().describe('Android package name'),
  activity: z.string().optional().describe('Activity name (optional)'),
  stop: z.boolean().optional().default(false).describe('Whether to stop the app before starting')
})

const ScreenshotSchema = z.object({
  filename: z.string().optional().describe('Filename for screenshot (optional)')
})

const InstallUiAutomator2Schema = z.object({
  deviceId: z.string().optional().describe('Device serial number (optional)')
})

/**
 * UiAutomator2 MCP Server for Android device automation
 * Uses direct ADB commands with uiautomator2 instead of uiautomator2-ts library
 */
class UiAutomator2Server {
  public server: Server
  private deviceId: string | null = null
  private pythonPath: string = 'python'

  constructor() {
    this.server = new Server(
      {
        name: 'uiautomator2-server',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    )

    this.setupRequestHandlers()
  }

  private setupRequestHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'install_uiautomator2',
            description: 'Install uiautomator2 on the connected Android device',
            inputSchema: {
              type: 'object',
              properties: {
                deviceId: {
                  type: 'string',
                  description: 'Device serial number (optional, uses first available device if not specified)'
                }
              }
            }
          },
          {
            name: 'connect_device',
            description: 'Connect to an Android device via uiautomator2',
            inputSchema: {
              type: 'object',
              properties: {
                deviceId: {
                  type: 'string',
                  description: 'Device serial number (optional, uses first available device if not specified)'
                },
                host: {
                  type: 'string',
                  description: 'Host for uiautomator2 server',
                  default: 'localhost'
                },
                port: {
                  type: 'number',
                  description: 'Port for uiautomator2 server',
                  default: 9008
                }
              }
            }
          },
          {
            name: 'find_element',
            description: 'Find an element on the screen using various selector criteria',
            inputSchema: {
              type: 'object',
              properties: {
                selector: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: 'Element text' },
                    resourceId: { type: 'string', description: 'Element resource ID' },
                    className: { type: 'string', description: 'Element class name' },
                    description: { type: 'string', description: 'Element description' },
                    packageName: { type: 'string', description: 'Element package name' }
                  },
                  description: 'Element selector criteria'
                },
                timeout: {
                  type: 'number',
                  description: 'Timeout in milliseconds',
                  default: 10000
                }
              },
              required: ['selector']
            }
          },
          {
            name: 'click_element',
            description: 'Click on an element found by selector criteria with human-like randomness',
            inputSchema: {
              type: 'object',
              properties: {
                selector: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: 'Element text' },
                    resourceId: { type: 'string', description: 'Element resource ID' },
                    className: { type: 'string', description: 'Element class name' },
                    description: { type: 'string', description: 'Element description' },
                    packageName: { type: 'string', description: 'Element package name' }
                  },
                  description: 'Element selector criteria'
                },
                timeout: {
                  type: 'number',
                  description: 'Timeout in milliseconds',
                  default: 10000
                },
                offset: {
                  type: 'object',
                  properties: {
                    x: { type: 'number', description: 'X offset (0-1)', default: 0.5 },
                    y: { type: 'number', description: 'Y offset (0-1)', default: 0.5 }
                  },
                  description: 'Click offset relative to element bounds'
                },
                randomize: {
                  type: 'boolean',
                  description: 'Add randomness to click position to avoid bot detection',
                  default: true
                }
              },
              required: ['selector']
            }
          },
          {
            name: 'input_text',
            description: 'Input text into an element using UiAutomator2 to avoid Chinese input issues',
            inputSchema: {
              type: 'object',
              properties: {
                selector: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: 'Element text' },
                    resourceId: { type: 'string', description: 'Element resource ID' },
                    className: { type: 'string', description: 'Element class name' },
                    description: { type: 'string', description: 'Element description' },
                    packageName: { type: 'string', description: 'Element package name' }
                  },
                  description: 'Element selector criteria'
                },
                text: {
                  type: 'string',
                  description: 'Text to input'
                },
                clearFirst: {
                  type: 'boolean',
                  description: 'Whether to clear existing text before input',
                  default: true
                },
                useUiAutomator2: {
                  type: 'boolean',
                  description: 'Use UiAutomator2 for text input to avoid Chinese input issues',
                  default: true
                }
              },
              required: ['selector', 'text']
            }
          },
          {
            name: 'swipe',
            description: 'Perform a swipe gesture on the screen with human-like fluidity',
            inputSchema: {
              type: 'object',
              properties: {
                startX: { type: 'number', description: 'Start X coordinate' },
                startY: { type: 'number', description: 'Start Y coordinate' },
                endX: { type: 'number', description: 'End X coordinate' },
                endY: { type: 'number', description: 'End Y coordinate' },
                duration: {
                  type: 'number',
                  description: 'Swipe duration in milliseconds',
                  default: 500
                },
                randomize: {
                  type: 'boolean',
                  description: 'Add randomness to swipe path to avoid bot detection',
                  default: true
                }
              },
              required: ['startX', 'startY', 'endX', 'endY']
            }
          },
          {
            name: 'start_app',
            description: 'Start an Android application',
            inputSchema: {
              type: 'object',
              properties: {
                packageName: { type: 'string', description: 'Android package name' },
                activity: { type: 'string', description: 'Activity name (optional)' },
                stop: {
                  type: 'boolean',
                  description: 'Whether to stop the app before starting',
                  default: false
                }
              },
              required: ['packageName']
            }
          },
          {
            name: 'stop_app',
            description: 'Stop an Android application',
            inputSchema: {
              type: 'object',
              properties: {
                packageName: { type: 'string', description: 'Android package name' }
              },
              required: ['packageName']
            }
          },
          {
            name: 'screenshot',
            description: 'Take a screenshot of the device screen',
            inputSchema: {
              type: 'object',
              properties: {
                filename: {
                  type: 'string',
                  description: 'Filename for screenshot (optional)'
                }
              }
            }
          },
          {
            name: 'get_device_info',
            description: 'Get device information',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: 'get_app_current',
            description: 'Get current running application information',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          }
        ]
      }
    })

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params

      try {
        switch (name) {
          case 'install_uiautomator2':
            return await this.installUiAutomator2(args)
          case 'connect_device':
            return await this.connectDevice(args)
          case 'find_element':
            return await this.findElement(args)
          case 'click_element':
            return await this.clickElement(args)
          case 'input_text':
            return await this.inputText(args)
          case 'swipe':
            return await this.swipe(args)
          case 'start_app':
            return await this.startApp(args)
          case 'stop_app':
            return await this.stopApp(args)
          case 'screenshot':
            return await this.screenshot(args)
          case 'get_device_info':
            return await this.getDeviceInfo()
          case 'get_app_current':
            return await this.getAppCurrent()
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`)
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error(`UiAutomator2 operation error: ${errorMessage}`)

        throw new McpError(ErrorCode.InternalError, `UiAutomator2 operation failed: ${errorMessage}`)
      }
    })
  }

  private async installUiAutomator2(args: any) {
    const { deviceId } = InstallUiAutomator2Schema.parse(args)

    try {
      const targetDeviceId = deviceId || (await this.getFirstDeviceId())
      if (!targetDeviceId) {
        throw new Error('No Android device found')
      }

      // Install uiautomator2 using pip
      const installCommand = `${this.pythonPath} -m pip install uiautomator2`
      await execAsync(installCommand)

      // Initialize uiautomator2 on the device
      const initCommand = `${this.pythonPath} -m uiautomator2 init --serial ${targetDeviceId}`
      await execAsync(initCommand)

      return {
        content: [
          {
            type: 'text',
            text: `Successfully installed and initialized uiautomator2 on device ${targetDeviceId}`
          }
        ]
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to install uiautomator2: ${errorMessage}`)
    }
  }

  private async connectDevice(args: any) {
    const { deviceId, host, port } = ConnectDeviceSchema.parse(args)

    try {
      const targetDeviceId = deviceId || (await this.getFirstDeviceId())
      if (!targetDeviceId) {
        throw new Error('No Android device found')
      }

      this.deviceId = targetDeviceId

      // Start uiautomator2 server on the device
      const startCommand = `${this.pythonPath} -m uiautomator2 --serial ${targetDeviceId} server --host ${host} --port ${port}`
      await execAsync(startCommand)

      return {
        content: [
          {
            type: 'text',
            text: `Successfully connected to device ${targetDeviceId} via uiautomator2 at ${host}:${port}`
          }
        ]
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to connect to device: ${errorMessage}`)
    }
  }

  private async findElement(args: any) {
    if (!this.deviceId) {
      throw new Error('Device not connected. Please use connect_device first.')
    }

    const { selector, timeout } = FindElementSchema.parse(args)

    try {
      const selectorStr = this.buildSelectorString(selector)
      const command = `${this.pythonPath} -c "import uiautomator2 as u2; d = u2.connect(); print(d(${selectorStr}).exists(timeout=${timeout / 1000}))"`
      const { stdout } = await execAsync(command)

      const exists = stdout.trim() === 'True'

      if (exists) {
        const infoCommand = `${this.pythonPath} -c "import uiautomator2 as u2; d = u2.connect(); import json; print(json.dumps(d(${selectorStr}).info))"`
        const { stdout: infoStdout } = await execAsync(infoCommand)
        const info = JSON.parse(infoStdout)

        return {
          content: [
            {
              type: 'text',
              text: `Element found: ${JSON.stringify(info, null, 2)}`
            }
          ]
        }
      } else {
        return {
          content: [
            {
              type: 'text',
              text: 'Element not found'
            }
          ]
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to find element: ${errorMessage}`)
    }
  }

  private async clickElement(args: any) {
    if (!this.deviceId) {
      throw new Error('Device not connected. Please use connect_device first.')
    }

    const { selector, offset, randomize } = ClickElementSchema.parse(args)

    try {
      const selectorStr = this.buildSelectorString(selector)

      // Build click command with human-like randomness
      let clickScript = `
import uiautomator2 as u2
import random
d = u2.connect()
element = d(${selectorStr})
`

      if (randomize) {
        clickScript += `
# Add randomness to avoid bot detection
bounds = element.info['bounds']
random_x = random.uniform(${offset?.x || 0.5} - 0.1, ${offset?.x || 0.5} + 0.1)
random_y = random.uniform(${offset?.y || 0.5} - 0.1, ${offset?.y || 0.5} + 0.1)
x = int(bounds['left'] + (bounds['right'] - bounds['left']) * random_x)
y = int(bounds['top'] + (bounds['bottom'] - bounds['top']) * random_y)
d.click(x, y)
`
      } else {
        clickScript += `
element.click(offset=(${offset?.x || 0.5}, ${offset?.y || 0.5}))
`
      }

      await execAsync(`${this.pythonPath} -c "${clickScript}"`)

      return {
        content: [
          {
            type: 'text',
            text: 'Click successful'
          }
        ]
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to click element: ${errorMessage}`)
    }
  }

  private async inputText(args: any) {
    if (!this.deviceId) {
      throw new Error('Device not connected. Please use connect_device first.')
    }

    const { selector, text, clearFirst, useUiAutomator2 } = InputTextSchema.parse(args)

    try {
      if (useUiAutomator2) {
        // Use UiAutomator2's set_text method to avoid Chinese input issues
        const selectorStr = this.buildSelectorString(selector)
        let inputScript = `
import uiautomator2 as u2
d = u2.connect()
element = d(${selectorStr})
`

        if (clearFirst) {
          inputScript += `element.clear_text()\n`
        }

        inputScript += `element.set_text("${text.replace(/"/g, '\\"')}")`

        await execAsync(`${this.pythonPath} -c "${inputScript}"`)
      } else {
        // Fallback to ADB input (not recommended for Chinese text)
        await this.adbInput(text)
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully input text: "${text}"`
          }
        ]
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to input text: ${errorMessage}`)
    }
  }

  private async swipe(args: any) {
    if (!this.deviceId) {
      throw new Error('Device not connected. Please use connect_device first.')
    }

    const { startX, startY, endX, endY, duration, randomize } = SwipeSchema.parse(args)

    try {
      let swipeScript = `
import uiautomator2 as u2
import random
d = u2.connect()
`

      if (randomize) {
        // Add human-like randomness to swipe gesture
        swipeScript += `
# Add randomness to avoid bot detection
random_start_x = random.randint(${startX} - 5, ${startX} + 5)
random_start_y = random.randint(${startY} - 5, ${startY} + 5)
random_end_x = random.randint(${endX} - 5, ${endX} + 5)
random_end_y = random.randint(${endY} - 5, ${endY} + 5)
d.swipe(random_start_x, random_start_y, random_end_x, random_end_y, duration=${duration})
`
      } else {
        swipeScript += `
d.swipe(${startX}, ${startY}, ${endX}, ${endY}, duration=${duration})
`
      }

      await execAsync(`${this.pythonPath} -c "${swipeScript}"`)

      return {
        content: [
          {
            type: 'text',
            text: 'Swipe gesture completed successfully'
          }
        ]
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to perform swipe: ${errorMessage}`)
    }
  }

  private async startApp(args: any) {
    if (!this.deviceId) {
      throw new Error('Device not connected. Please use connect_device first.')
    }

    const { packageName, activity, stop } = AppControlSchema.parse(args)

    try {
      const command = `${this.pythonPath} -c "import uiautomator2 as u2; d = u2.connect(); d.app_start('${packageName}'${activity ? `, '${activity}'` : ''}${stop ? ', stop=True' : ''})"`
      await execAsync(command)

      return {
        content: [
          {
            type: 'text',
            text: `Successfully started app: ${packageName}${activity ? `/${activity}` : ''}`
          }
        ]
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to start app: ${errorMessage}`)
    }
  }

  private async stopApp(args: any) {
    if (!this.deviceId) {
      throw new Error('Device not connected. Please use connect_device first.')
    }

    const { packageName } = AppControlSchema.parse(args)

    try {
      const command = `${this.pythonPath} -c "import uiautomator2 as u2; d = u2.connect(); d.app_stop('${packageName}')"`
      await execAsync(command)

      return {
        content: [
          {
            type: 'text',
            text: `Successfully stopped app: ${packageName}`
          }
        ]
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to stop app: ${errorMessage}`)
    }
  }

  private async screenshot(args: any) {
    if (!this.deviceId) {
      throw new Error('Device not connected. Please use connect_device first.')
    }

    const { filename } = ScreenshotSchema.parse(args)

    try {
      const screenshotPath = filename || `screenshot_${Date.now()}.png`
      const command = `${this.pythonPath} -c "import uiautomator2 as u2; d = u2.connect(); d.screenshot('${screenshotPath}')"`
      await execAsync(command)

      return {
        content: [
          {
            type: 'text',
            text: `Screenshot saved as: ${screenshotPath}`
          }
        ]
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to take screenshot: ${errorMessage}`)
    }
  }

  private async getDeviceInfo() {
    if (!this.deviceId) {
      throw new Error('Device not connected. Please use connect_device first.')
    }

    try {
      const command = `${this.pythonPath} -c "import uiautomator2 as u2; d = u2.connect(); import json; print(json.dumps(d.device_info))"`
      const { stdout } = await execAsync(command)
      const info = JSON.parse(stdout)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(info, null, 2)
          }
        ]
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to get device info: ${errorMessage}`)
    }
  }

  private async getAppCurrent() {
    if (!this.deviceId) {
      throw new Error('Device not connected. Please use connect_device first.')
    }

    try {
      const command = `${this.pythonPath} -c "import uiautomator2 as u2; d = u2.connect(); import json; print(json.dumps(d.app_current()))"`
      const { stdout } = await execAsync(command)
      const appInfo = JSON.parse(stdout)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(appInfo, null, 2)
          }
        ]
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to get current app info: ${errorMessage}`)
    }
  }

  // Helper methods
  private async getFirstDeviceId(): Promise<string | null> {
    try {
      const toolPaths = toolPathManager.getToolPaths()
      const { stdout } = await execAsync(`"${toolPaths.adbPath}" devices`)
      const lines = stdout.trim().split('\n')
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim()
        if (line && !line.startsWith('*')) {
          const [deviceId] = line.split(/\s+/)
          if (deviceId && !deviceId.includes('offline') && !deviceId.includes('unauthorized')) {
            return deviceId
          }
        }
      }
      return null
    } catch {
      return null
    }
  }

  private buildSelectorString(selector: any): string {
    const parts: string[] = []

    if (selector.text) {
      parts.push(`text="${selector.text}"`)
    }
    if (selector.resourceId) {
      parts.push(`resourceId="${selector.resourceId}"`)
    }
    if (selector.className) {
      parts.push(`className="${selector.className}"`)
    }
    if (selector.description) {
      parts.push(`description="${selector.description}"`)
    }
    if (selector.packageName) {
      parts.push(`packageName="${selector.packageName}"`)
    }

    if (parts.length === 0) {
      throw new Error('At least one selector criterion must be provided')
    }

    return parts.join(', ')
  }

  private async adbInput(text: string) {
    const toolPaths = toolPathManager.getToolPaths()
    const escapedText = text.replace(/"/g, '\\"')
    const command = `"${toolPaths.adbPath}" -s ${this.deviceId} shell input text "${escapedText}"`
    await execAsync(command)
  }
}

export default UiAutomator2Server
