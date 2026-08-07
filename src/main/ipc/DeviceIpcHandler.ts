import { loggerService } from '@logger'
import {
  ScrcpyFrameStreamChannels,
  type ScrcpyFrameStreamOptions,
  type ScrcpyFrameStreamStatusEvent
} from '@shared/types/ScrcpyStream'
import { BrowserWindow, ipcMain } from 'electron'

import { type DeviceInfo, deviceService } from '../services/DeviceService'
import { scrcpyFrameStreamService } from '../services/ScrcpyFrameStreamService'
import { scrcpyWindowService } from '../services/ScrcpyWindowService'

const logger = loggerService.withContext('DeviceIpcHandler')

function readPngDimensions(image: Buffer): { width: number; height: number } {
  const pngSignature = '89504e470d0a1a0a'
  if (image.length < 24 || image.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error('ADB screenshot is not a valid PNG image')
  }

  const width = image.readUInt32BE(16)
  const height = image.readUInt32BE(20)
  if (width <= 0 || height <= 0) {
    throw new Error(`ADB screenshot has invalid dimensions: ${width}x${height}`)
  }
  return { width, height }
}

export class DeviceIpcHandler {
  private static isScrcpyStoppedForwarderRegistered = false
  private static isScrcpyFrameForwarderRegistered = false

  static registerHandlers(): void {
    if (!DeviceIpcHandler.isScrcpyStoppedForwarderRegistered) {
      deviceService.onScrcpyStopped((payload) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('device:scrcpyStopped', payload)
        }
      })
      DeviceIpcHandler.isScrcpyStoppedForwarderRegistered = true
    }

    if (!DeviceIpcHandler.isScrcpyFrameForwarderRegistered) {
      scrcpyFrameStreamService.onPacket((packet) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(ScrcpyFrameStreamChannels.packet, packet)
        }
      })
      scrcpyFrameStreamService.onHealthChanged((health) => {
        const event: ScrcpyFrameStreamStatusEvent = { health }
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send(ScrcpyFrameStreamChannels.status, event)
        }
      })
      DeviceIpcHandler.isScrcpyFrameForwarderRegistered = true
    }

    ipcMain.handle('device:scanDevices', async (): Promise<DeviceInfo[]> => {
      try {
        return await deviceService.scanDevices()
      } catch (error) {
        logger.error('Failed to scan devices via IPC:', { error })
        throw error
      }
    })

    ipcMain.handle('device:executeAdbCommand', async (_event, deviceId: string, command: string): Promise<string> => {
      try {
        logger.info('Executing ADB command via IPC:', { deviceId, command })
        return await deviceService.executeAdbCommand(deviceId, command)
      } catch (error) {
        logger.error('Failed to execute ADB command via IPC:', { error })
        throw error
      }
    })

    ipcMain.handle(
      'device:startScrcpy',
      async (
        _event,
        deviceId: string,
        options: {
          port?: number
          maxSize?: number
          bitRate?: number
          maxFps?: number
        } = {}
      ): Promise<{ port: number }> => {
        try {
          logger.info('Starting Scrcpy via IPC:', { deviceId, options })
          const result = await deviceService.startScrcpy(deviceId, options)
          return { port: result.port }
        } catch (error) {
          logger.error('Failed to start Scrcpy via IPC:', { error })
          throw error
        }
      }
    )

    ipcMain.handle('device:stopScrcpy', async (_event, deviceId: string): Promise<void> => {
      try {
        logger.info('Stopping Scrcpy via IPC:', { deviceId })
        await deviceService.stopScrcpy(deviceId)
      } catch (error) {
        logger.error('Failed to stop Scrcpy via IPC:', { error })
        throw error
      }
    })

    ipcMain.handle('device:stopAllScrcpy', async (): Promise<void> => {
      try {
        logger.info('Stopping all Scrcpy via IPC', {})
        await deviceService.stopAllScrcpy()
      } catch (error) {
        logger.error('Failed to stop all Scrcpy via IPC:', { error })
        throw error
      }
    })

    ipcMain.handle('device:getScrcpyWindow', async (_event, deviceId: string) => {
      try {
        logger.info('Getting Scrcpy window via IPC:', { deviceId })
        return await scrcpyWindowService.getWindowInfo(deviceId)
      } catch (error) {
        logger.error('Failed to get Scrcpy window via IPC:', { error, deviceId })
        throw error
      }
    })

    ipcMain.handle('device:captureScrcpyWindow', async (_event, deviceId: string) => {
      try {
        logger.info('Capturing Scrcpy window via IPC:', { deviceId })
        return await scrcpyWindowService.captureWindow(deviceId)
      } catch (error) {
        logger.error('Failed to capture Scrcpy window via IPC:', { error, deviceId })
        throw error
      }
    })

    ipcMain.handle(
      ScrcpyFrameStreamChannels.start,
      async (_event, deviceId: string, options: ScrcpyFrameStreamOptions = {}) => {
        return await scrcpyFrameStreamService.start(deviceId, options)
      }
    )

    ipcMain.handle(ScrcpyFrameStreamChannels.stop, async (_event, deviceId: string): Promise<void> => {
      await scrcpyFrameStreamService.stop(deviceId)
    })

    ipcMain.handle(ScrcpyFrameStreamChannels.health, (_event, deviceId: string) => {
      return scrcpyFrameStreamService.getHealth(deviceId)
    })

    ipcMain.handle('device:getScreenshot', async (_event, deviceId: string) => {
      try {
        logger.info('Capturing device screenshot via IPC:', { deviceId })
        const image = await deviceService.getScreenshot(deviceId)
        const dimensions = readPngDimensions(image)
        return {
          deviceId,
          mime: 'image/png',
          imageBase64: image.toString('base64'),
          source: 'adb',
          ...dimensions
        }
      } catch (error) {
        logger.error('Failed to capture device screenshot via IPC:', { error, deviceId })
        throw error
      }
    })

    ipcMain.handle('device:getScreenSize', async (_event, deviceId: string) => {
      try {
        logger.info('Getting device screen size via IPC:', { deviceId })
        return await deviceService.getDeviceScreenSize(deviceId)
      } catch (error) {
        logger.error('Failed to get device screen size via IPC:', { error, deviceId })
        throw error
      }
    })

    ipcMain.handle('device:sendTap', async (_event, deviceId: string, x: number, y: number): Promise<void> => {
      try {
        logger.info('Sending tap via IPC:', { deviceId, x, y })
        await deviceService.sendTap(deviceId, x, y)
      } catch (error) {
        logger.error('Failed to send tap via IPC:', { error })
        throw error
      }
    })

    ipcMain.handle(
      'device:sendDoubleTap',
      async (_event, deviceId: string, x: number, y: number, interval?: number): Promise<void> => {
        try {
          logger.info('Sending double tap via IPC:', { deviceId, x, y, interval })
          await deviceService.sendDoubleTap(deviceId, x, y, interval)
        } catch (error) {
          logger.error('Failed to send double tap via IPC:', { error, deviceId })
          throw error
        }
      }
    )

    ipcMain.handle(
      'device:sendLongPress',
      async (_event, deviceId: string, x: number, y: number, duration?: number): Promise<void> => {
        try {
          logger.info('Sending long press via IPC:', { deviceId, x, y, duration })
          await deviceService.sendLongPress(deviceId, x, y, duration)
        } catch (error) {
          logger.error('Failed to send long press via IPC:', { error, deviceId })
          throw error
        }
      }
    )

    ipcMain.handle(
      'device:sendSwipe',
      async (
        _event,
        deviceId: string,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        duration: number
      ): Promise<void> => {
        try {
          logger.info('Sending swipe via IPC:', { deviceId, x1, y1, x2, y2, duration })
          await deviceService.sendSwipe(deviceId, x1, y1, x2, y2, duration)
        } catch (error) {
          logger.error('Failed to send swipe via IPC:', { error })
          throw error
        }
      }
    )

    ipcMain.handle(
      'device:sendDrag',
      async (
        _event,
        deviceId: string,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        duration?: number
      ): Promise<void> => {
        try {
          logger.info('Sending drag via IPC:', { deviceId, x1, y1, x2, y2, duration })
          await deviceService.sendDrag(deviceId, x1, y1, x2, y2, duration)
        } catch (error) {
          logger.error('Failed to send drag via IPC:', { error, deviceId })
          throw error
        }
      }
    )

    ipcMain.handle('device:sendText', async (_event, deviceId: string, text: string): Promise<void> => {
      try {
        logger.info('Sending text via IPC:', { deviceId, text })
        await deviceService.sendText(deviceId, text)
      } catch (error) {
        logger.error('Failed to send text via IPC:', { error })
        throw error
      }
    })

    ipcMain.handle('device:sendKeyEvent', async (_event, deviceId: string, keyCode: number): Promise<void> => {
      try {
        logger.info('Sending key event via IPC:', { deviceId, keyCode })
        await deviceService.sendKeyEvent(deviceId, keyCode)
      } catch (error) {
        logger.error('Failed to send key event via IPC:', { error })
        throw error
      }
    })

    ipcMain.handle('device:startApp', async (_event, deviceId: string, packageName: string): Promise<void> => {
      try {
        logger.info('Starting app via IPC:', { deviceId, packageName })
        await deviceService.startApp(deviceId, packageName)
      } catch (error) {
        logger.error('Failed to start app via IPC:', { error, deviceId, packageName })
        throw error
      }
    })

    ipcMain.handle(
      'device:resolveLauncherActivity',
      async (_event, deviceId: string, packageName: string): Promise<string | null> => {
        try {
          return await deviceService.resolveLauncherActivity(deviceId, packageName)
        } catch (error) {
          logger.error('Failed to resolve launcher activity via IPC:', { error, deviceId, packageName })
          throw error
        }
      }
    )

    ipcMain.handle('device:stopApp', async (_event, deviceId: string, packageName: string): Promise<void> => {
      try {
        logger.info('Stopping app via IPC:', { deviceId, packageName })
        await deviceService.stopApp(deviceId, packageName)
      } catch (error) {
        logger.error('Failed to stop app via IPC:', { error, deviceId, packageName })
        throw error
      }
    })

    ipcMain.handle('device:restartApp', async (_event, deviceId: string, packageName: string): Promise<void> => {
      try {
        logger.info('Restarting app via IPC:', { deviceId, packageName })
        await deviceService.restartApp(deviceId, packageName)
      } catch (error) {
        logger.error('Failed to restart app via IPC:', { error, deviceId, packageName })
        throw error
      }
    })

    ipcMain.handle('device:getForegroundApp', async (_event, deviceId: string) => {
      try {
        logger.info('Getting foreground app via IPC:', { deviceId })
        return await deviceService.getForegroundApp(deviceId)
      } catch (error) {
        logger.error('Failed to get foreground app via IPC:', { error, deviceId })
        throw error
      }
    })

    ipcMain.handle(
      'device:handlePermissionDialog',
      async (_event, deviceId: string, action: 'allow' | 'deny' | 'allow_once'): Promise<boolean> => {
        try {
          logger.info('Handling permission dialog via IPC:', { deviceId, action })
          return await deviceService.handlePermissionDialog(deviceId, action)
        } catch (error) {
          logger.error('Failed to handle permission dialog via IPC:', { error, deviceId, action })
          throw error
        }
      }
    )

    ipcMain.handle(
      'device:checkDeviceStatus',
      async (_event, deviceId: string): Promise<'online' | 'offline' | 'unauthorized'> => {
        try {
          logger.info('Checking device status via IPC:', { deviceId })
          return await deviceService.checkDeviceStatus(deviceId)
        } catch (error) {
          logger.error('Failed to check device status via IPC:', { error })
          return 'offline'
        }
      }
    )

    ipcMain.handle('detect-tool-paths', async (): Promise<{ adbPath?: string; scrcpyPath?: string }> => {
      try {
        logger.info('Detecting tool paths via IPC', {})
        return await deviceService.detectToolPaths()
      } catch (error) {
        logger.error('Failed to detect tool paths via IPC:', { error })
        return {}
      }
    })
  }
}
