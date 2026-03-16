import { loggerService } from '@logger'
import { ipcMain } from 'electron'

import { type DeviceInfo, deviceService } from '../services/DeviceService'

const logger = loggerService.withContext('DeviceIpcHandler')

export class DeviceIpcHandler {
  static registerHandlers(): void {
    // 扫描设备
    ipcMain.handle('device:scanDevices', async (): Promise<DeviceInfo[]> => {
      try {
        logger.info('Scanning devices via IPC', {})
        const devices = await deviceService.scanDevices()
        return devices
      } catch (error) {
        logger.error('Failed to scan devices via IPC:', { error })
        throw error
      }
    })

    // 执行ADB命令
    ipcMain.handle('device:executeAdbCommand', async (_event, deviceId: string, command: string): Promise<string> => {
      try {
        logger.info('Executing ADB command via IPC:', { deviceId, command })
        const result = await deviceService.executeAdbCommand(deviceId, command)
        return result
      } catch (error) {
        logger.error('Failed to execute ADB command via IPC:', { error })
        throw error
      }
    })

    // 启动Scrcpy
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

    // 停止Scrcpy
    ipcMain.handle('device:stopScrcpy', async (_event, deviceId: string): Promise<void> => {
      try {
        logger.info('Stopping Scrcpy via IPC:', { deviceId })
        await deviceService.stopScrcpy(deviceId)
      } catch (error) {
        logger.error('Failed to stop Scrcpy via IPC:', { error })
        throw error
      }
    })

    // 停止所有Scrcpy
    ipcMain.handle('device:stopAllScrcpy', async (): Promise<void> => {
      try {
        logger.info('Stopping all Scrcpy via IPC', {})
        await deviceService.stopAllScrcpy()
      } catch (error) {
        logger.error('Failed to stop all Scrcpy via IPC:', { error })
        throw error
      }
    })

    // 发送点击
    ipcMain.handle('device:sendTap', async (_event, deviceId: string, x: number, y: number): Promise<void> => {
      try {
        logger.info('Sending tap via IPC:', { deviceId, x, y })
        await deviceService.sendTap(deviceId, x, y)
      } catch (error) {
        logger.error('Failed to send tap via IPC:', { error })
        throw error
      }
    })

    // 发送滑动
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

    // 发送文本
    ipcMain.handle('device:sendText', async (_event, deviceId: string, text: string): Promise<void> => {
      try {
        logger.info('Sending text via IPC:', { deviceId, text })
        await deviceService.sendText(deviceId, text)
      } catch (error) {
        logger.error('Failed to send text via IPC:', { error })
        throw error
      }
    })

    // 发送按键事件
    ipcMain.handle('device:sendKeyEvent', async (_event, deviceId: string, keyCode: number): Promise<void> => {
      try {
        logger.info('Sending key event via IPC:', { deviceId, keyCode })
        await deviceService.sendKeyEvent(deviceId, keyCode)
      } catch (error) {
        logger.error('Failed to send key event via IPC:', { error })
        throw error
      }
    })

    // 检查设备状态
    ipcMain.handle(
      'device:checkDeviceStatus',
      async (_event, deviceId: string): Promise<'online' | 'offline' | 'unauthorized'> => {
        try {
          logger.info('Checking device status via IPC:', { deviceId })
          const status = await deviceService.checkDeviceStatus(deviceId)
          return status
        } catch (error) {
          logger.error('Failed to check device status via IPC:', { error })
          return 'offline'
        }
      }
    )

    // 检测工具路径
    ipcMain.handle('detect-tool-paths', async (): Promise<{ adbPath?: string; scrcpyPath?: string }> => {
      try {
        logger.info('Detecting tool paths via IPC', {})
        const paths = await deviceService.detectToolPaths()
        return paths
      } catch (error) {
        logger.error('Failed to detect tool paths via IPC:', { error })
        return {}
      }
    })
  }
}
