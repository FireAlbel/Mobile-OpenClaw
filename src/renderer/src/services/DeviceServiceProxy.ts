import { loggerService } from '@logger'

const logger = loggerService.withContext('DeviceServiceProxy')

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

export interface ScrcpyStoppedPayload {
  deviceId: string
}

export interface ScrcpyWindowInfo {
  deviceId: string
  hwnd: string
  title: string
  width: number
  height: number
  x: number
  y: number
}

export interface ScrcpyWindowCapture extends ScrcpyWindowInfo {
  mime: 'image/png'
  imageBase64: string
}

export interface DeviceScreenshot {
  deviceId: string
  mime: 'image/png'
  imageBase64: string
}

export interface DeviceScreenSize {
  width: number
  height: number
}

export interface ForegroundAppInfo {
  packageName: string
  activity?: string
}

export class DeviceServiceProxy {
  async scanDevices(): Promise<DeviceInfo[]> {
    try {
      return await window.electron.ipcRenderer.invoke('device:scanDevices')
    } catch (error) {
      logger.error('Failed to scan devices', { error })
      throw error
    }
  }

  async executeAdbCommand(deviceId: string, command: string): Promise<string> {
    try {
      return await window.electron.ipcRenderer.invoke('device:executeAdbCommand', deviceId, command)
    } catch (error) {
      logger.error('Failed to execute ADB command', { error, deviceId })
      throw error
    }
  }

  async startScrcpy(
    deviceId: string,
    options?: {
      port?: number
      maxSize?: number
      bitRate?: number
      maxFps?: number
    }
  ): Promise<{ port: number }> {
    try {
      return await window.electron.ipcRenderer.invoke('device:startScrcpy', deviceId, options)
    } catch (error) {
      logger.error('Failed to start Scrcpy', { error, deviceId })
      throw error
    }
  }

  async stopScrcpy(deviceId: string): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:stopScrcpy', deviceId)
    } catch (error) {
      logger.error('Failed to stop Scrcpy', { error, deviceId })
      throw error
    }
  }

  async stopAllScrcpy(): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:stopAllScrcpy')
    } catch (error) {
      logger.error('Failed to stop all Scrcpy', { error })
    }
  }

  onScrcpyStopped(callback: (payload: ScrcpyStoppedPayload) => void): () => void {
    const channel = 'device:scrcpyStopped'
    return window.electron.ipcRenderer.on(channel, (_: unknown, payload: ScrcpyStoppedPayload) => callback(payload))
  }

  async getScrcpyWindow(deviceId: string): Promise<ScrcpyWindowInfo> {
    try {
      return await window.electron.ipcRenderer.invoke('device:getScrcpyWindow', deviceId)
    } catch (error) {
      logger.error('Failed to get Scrcpy window', { error, deviceId })
      throw error
    }
  }

  async captureScrcpyWindow(deviceId: string): Promise<ScrcpyWindowCapture> {
    try {
      return await window.electron.ipcRenderer.invoke('device:captureScrcpyWindow', deviceId)
    } catch (error) {
      logger.error('Failed to capture Scrcpy window', { error, deviceId })
      throw error
    }
  }

  async getScreenshot(deviceId: string): Promise<DeviceScreenshot> {
    try {
      return await window.electron.ipcRenderer.invoke('device:getScreenshot', deviceId)
    } catch (error) {
      logger.error('Failed to capture device screenshot', { error, deviceId })
      throw error
    }
  }

  async getScreenSize(deviceId: string): Promise<DeviceScreenSize> {
    try {
      return await window.electron.ipcRenderer.invoke('device:getScreenSize', deviceId)
    } catch (error) {
      logger.error('Failed to get device screen size', { error, deviceId })
      throw error
    }
  }

  async sendTap(deviceId: string, x: number, y: number): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:sendTap', deviceId, x, y)
    } catch (error) {
      logger.error('Failed to send tap', { error, deviceId, x, y })
      throw error
    }
  }

  async sendDoubleTap(deviceId: string, x: number, y: number, interval: number = 120): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:sendDoubleTap', deviceId, x, y, interval)
    } catch (error) {
      logger.error('Failed to send double tap', { error, deviceId, x, y, interval })
      throw error
    }
  }

  async sendLongPress(deviceId: string, x: number, y: number, duration: number = 800): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:sendLongPress', deviceId, x, y, duration)
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
      await window.electron.ipcRenderer.invoke('device:sendSwipe', deviceId, x1, y1, x2, y2, duration)
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
      await window.electron.ipcRenderer.invoke('device:sendDrag', deviceId, x1, y1, x2, y2, duration)
    } catch (error) {
      logger.error('Failed to send drag', { error, deviceId })
      throw error
    }
  }

  async sendText(deviceId: string, text: string): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:sendText', deviceId, text)
    } catch (error) {
      logger.error('Failed to send text', { error, deviceId })
      throw error
    }
  }

  async sendKeyEvent(deviceId: string, keyCode: number): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:sendKeyEvent', deviceId, keyCode)
    } catch (error) {
      logger.error('Failed to send key event', { error, deviceId, keyCode })
      throw error
    }
  }

  async startApp(deviceId: string, packageName: string): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:startApp', deviceId, packageName)
    } catch (error) {
      logger.error('Failed to start app', { error, deviceId, packageName })
      throw error
    }
  }

  async stopApp(deviceId: string, packageName: string): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:stopApp', deviceId, packageName)
    } catch (error) {
      logger.error('Failed to stop app', { error, deviceId, packageName })
      throw error
    }
  }

  async restartApp(deviceId: string, packageName: string): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:restartApp', deviceId, packageName)
    } catch (error) {
      logger.error('Failed to restart app', { error, deviceId, packageName })
      throw error
    }
  }

  async getForegroundApp(deviceId: string): Promise<ForegroundAppInfo> {
    try {
      return await window.electron.ipcRenderer.invoke('device:getForegroundApp', deviceId)
    } catch (error) {
      logger.error('Failed to get foreground app', { error, deviceId })
      throw error
    }
  }

  async handlePermissionDialog(deviceId: string, action: 'allow' | 'deny' | 'allow_once'): Promise<boolean> {
    try {
      return await window.electron.ipcRenderer.invoke('device:handlePermissionDialog', deviceId, action)
    } catch (error) {
      logger.error('Failed to handle permission dialog', { error, deviceId, action })
      throw error
    }
  }

  async checkDeviceStatus(deviceId: string): Promise<DeviceInfo['status']> {
    try {
      return await window.electron.ipcRenderer.invoke('device:checkDeviceStatus', deviceId)
    } catch (error) {
      logger.error('Failed to check device status', { error, deviceId })
      return 'offline'
    }
  }

  async getDevices(): Promise<DeviceInfo[]> {
    return this.scanDevices()
  }

  async installApk(deviceId: string, apkPath: string): Promise<boolean> {
    try {
      await this.executeAdbCommand(deviceId, `install "${apkPath}"`)
      return true
    } catch (error) {
      logger.error('Failed to install APK', { error, deviceId })
      return false
    }
  }

  async uninstallPackage(deviceId: string, packageName: string): Promise<boolean> {
    try {
      await this.executeAdbCommand(deviceId, `uninstall ${packageName}`)
      return true
    } catch (error) {
      logger.error('Failed to uninstall package', { error, deviceId, packageName })
      return false
    }
  }
}

export const deviceServiceProxy = new DeviceServiceProxy()
