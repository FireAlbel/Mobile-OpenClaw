import type { DeviceController } from './controller'

export const toolDefinitions = [
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

export const toolHandlers: Record<string, (controller: DeviceController, args: any) => Promise<any>> = {
  list_devices: async (controller: DeviceController) => {
    const devices = await controller.listDevices()
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(devices, null, 2)
        }
      ]
    }
  },

  get_device_info: async (controller: DeviceController, args: any) => {
    const info = await controller.getDeviceInfo(args.deviceId)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(info, null, 2)
        }
      ]
    }
  },

  start_scrcpy: async (controller: DeviceController, args: any) => {
    const result = await controller.startScrcpy(args.deviceId, args.options || {})
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  stop_scrcpy: async (controller: DeviceController, args: any) => {
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

  send_tap: async (controller: DeviceController, args: any) => {
    const result = await controller.sendTap(args.deviceId, args.x, args.y)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  send_swipe: async (controller: DeviceController, args: any) => {
    const result = await controller.sendSwipe(
      args.deviceId,
      args.startX,
      args.startY,
      args.endX,
      args.endY,
      args.duration
    )
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  send_text: async (controller: DeviceController, args: any) => {
    const result = await controller.sendText(args.deviceId, args.text)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  send_key_event: async (controller: DeviceController, args: any) => {
    const result = await controller.sendKeyEvent(args.deviceId, args.keyCode)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  install_apk: async (controller: DeviceController, args: any) => {
    const result = await controller.installApk(args.deviceId, args.apkPath)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  uninstall_package: async (controller: DeviceController, args: any) => {
    const result = await controller.uninstallPackage(args.deviceId, args.packageName)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  execute_adb_command: async (controller: DeviceController, args: any) => {
    // Support both deviceId (single) and deviceIds (array) parameters
    const deviceId = args.deviceId || (args.deviceIds && args.deviceIds[0])
    if (!deviceId) {
      throw new Error('deviceId or deviceIds is required')
    }
    const result = await controller.executeAdbCommand(deviceId, args.command)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  get_screenshot: async (controller: DeviceController, args: any) => {
    const result = await controller.getScreenshot(args.deviceId)
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  },

  get_device_property: async (controller: DeviceController, args: any) => {
    const result = await controller.getDeviceProperty(args.deviceId, args.property)
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
