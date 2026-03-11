// 设备信息接口定义
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

// 设备服务代理，通过IPC与主进程通信
export class DeviceServiceProxy {
  async scanDevices(): Promise<DeviceInfo[]> {
    try {
      const result = await window.electron.ipcRenderer.invoke('device:scanDevices')
      return result
    } catch (error) {
      console.error('Failed to scan devices:', error)
      return []
    }
  }

  async executeAdbCommand(deviceId: string, command: string): Promise<string> {
    try {
      const result = await window.electron.ipcRenderer.invoke('device:executeAdbCommand', deviceId, command)
      return result
    } catch (error) {
      console.error('Failed to execute ADB command:', error)
      throw error
    }
  }

  async startScrcpy(deviceId: string, options?: {
    port?: number
    maxSize?: number
    bitRate?: number
    maxFps?: number
  }): Promise<{ port: number }> {
    try {
      const result = await window.electron.ipcRenderer.invoke('device:startScrcpy', deviceId, options)
      return result
    } catch (error) {
      console.error('Failed to start Scrcpy:', error)
      throw error
    }
  }

  async stopScrcpy(deviceId: string): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:stopScrcpy', deviceId)
    } catch (error) {
      console.error('Failed to stop Scrcpy:', error)
      throw error
    }
  }

  async stopAllScrcpy(): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:stopAllScrcpy')
    } catch (error) {
      console.error('Failed to stop all Scrcpy:', error)
    }
  }

  async sendTap(deviceId: string, x: number, y: number): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:sendTap', deviceId, x, y)
    } catch (error) {
      console.error('Failed to send tap:', error)
      throw error
    }
  }

  async sendSwipe(deviceId: string, x1: number, y1: number, x2: number, y2: number, duration: number = 500): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:sendSwipe', deviceId, x1, y1, x2, y2, duration)
    } catch (error) {
      console.error('Failed to send swipe:', error)
      throw error
    }
  }

  async sendText(deviceId: string, text: string): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:sendText', deviceId, text)
    } catch (error) {
      console.error('Failed to send text:', error)
      throw error
    }
  }

  async sendKeyEvent(deviceId: string, keyCode: number): Promise<void> {
    try {
      await window.electron.ipcRenderer.invoke('device:sendKeyEvent', deviceId, keyCode)
    } catch (error) {
      console.error('Failed to send key event:', error)
      throw error
    }
  }

  async checkDeviceStatus(deviceId: string): Promise<'online' | 'offline' | 'unauthorized'> {
    try {
      const result = await window.electron.ipcRenderer.invoke('device:checkDeviceStatus', deviceId)
      return result
    } catch (error) {
      console.error('Failed to check device status:', error)
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
      console.error('Failed to install APK:', error)
      return false
    }
  }

  async uninstallPackage(deviceId: string, packageName: string): Promise<boolean> {
    try {
      await this.executeAdbCommand(deviceId, `uninstall ${packageName}`)
      return true
    } catch (error) {
      console.error('Failed to uninstall package:', error)
      return false
    }
  }
}

export const deviceServiceProxy = new DeviceServiceProxy()
