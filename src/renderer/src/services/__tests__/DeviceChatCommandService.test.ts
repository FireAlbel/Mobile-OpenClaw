import { beforeEach, describe, expect, it, vi } from 'vitest'

const scanDevicesMock = vi.hoisted(() => vi.fn())
const getScreenshotMock = vi.hoisted(() => vi.fn())
const getScreenSizeMock = vi.hoisted(() => vi.fn())
const sendKeyEventMock = vi.hoisted(() => vi.fn())
const sendSwipeMock = vi.hoisted(() => vi.fn())
const sendDoubleTapMock = vi.hoisted(() => vi.fn())
const sendLongPressMock = vi.hoisted(() => vi.fn())
const sendDragMock = vi.hoisted(() => vi.fn())
const startAppMock = vi.hoisted(() => vi.fn())
const stopAppMock = vi.hoisted(() => vi.fn())
const restartAppMock = vi.hoisted(() => vi.fn())
const getForegroundAppMock = vi.hoisted(() => vi.fn())
const handlePermissionDialogMock = vi.hoisted(() => vi.fn())
const getScrcpyWindowMock = vi.hoisted(() => vi.fn())
const startScrcpyMock = vi.hoisted(() => vi.fn())
const runVisionActionMock = vi.hoisted(() => vi.fn())

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    })
  }
}))

vi.mock('../DeviceServiceProxy', () => ({
  deviceServiceProxy: {
    getScreenshot: getScreenshotMock,
    getScreenSize: getScreenSizeMock,
    getScrcpyWindow: getScrcpyWindowMock,
    scanDevices: scanDevicesMock,
    sendDoubleTap: sendDoubleTapMock,
    sendDrag: sendDragMock,
    sendKeyEvent: sendKeyEventMock,
    sendLongPress: sendLongPressMock,
    sendSwipe: sendSwipeMock,
    startApp: startAppMock,
    startScrcpy: startScrcpyMock,
    stopApp: stopAppMock,
    restartApp: restartAppMock,
    getForegroundApp: getForegroundAppMock,
    handlePermissionDialog: handlePermissionDialogMock
  }
}))

vi.mock('../DeviceVisionActionService', () => ({
  deviceVisionActionService: {
    runVisionAction: runVisionActionMock
  }
}))

import { deviceChatCommandService } from '../DeviceChatCommandService'

describe('DeviceChatCommandService', () => {
  beforeEach(() => {
    scanDevicesMock.mockReset()
    getScreenshotMock.mockReset()
    getScreenSizeMock.mockReset()
    sendKeyEventMock.mockReset()
    sendSwipeMock.mockReset()
    sendDoubleTapMock.mockReset()
    sendLongPressMock.mockReset()
    sendDragMock.mockReset()
    startAppMock.mockReset()
    stopAppMock.mockReset()
    restartAppMock.mockReset()
    getForegroundAppMock.mockReset()
    handlePermissionDialogMock.mockReset()
    getScrcpyWindowMock.mockReset()
    startScrcpyMock.mockReset()
    runVisionActionMock.mockReset()
    getScreenSizeMock.mockResolvedValue({ width: 1000, height: 2000 })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  it('detects Chinese and English device command prefixes', () => {
    expect(deviceChatCommandService.isDeviceCommand('设备 截图')).toBe(true)
    expect(deviceChatCommandService.isDeviceCommand('@手机 返回')).toBe(true)
    expect(deviceChatCommandService.isDeviceCommand('device screenshot')).toBe(true)
    expect(deviceChatCommandService.isDeviceCommand('普通聊天')).toBe(false)
  })

  it('downloads a screenshot for the only online device', async () => {
    scanDevicesMock.mockResolvedValue([{ id: 'serial-1', name: 'Pixel', status: 'online' }])
    getScreenshotMock.mockResolvedValue({ deviceId: 'serial-1', imageBase64: 'abc', mime: 'image/png' })

    const result = await deviceChatCommandService.run('设备 截图')

    expect(getScreenshotMock).toHaveBeenCalledWith('serial-1')
    expect(result).toContain('serial-1')
  })

  it('uses an explicit device id when multiple devices are online', async () => {
    scanDevicesMock.mockResolvedValue([
      { id: 'serial-1', name: 'Pixel', status: 'online' },
      { id: 'serial-2', name: 'OnePlus', status: 'online' }
    ])

    await deviceChatCommandService.run('设备 serial-2 返回')

    expect(sendKeyEventMock).toHaveBeenCalledWith('serial-2', 4)
  })

  it('asks for an explicit device id when multiple devices are online', async () => {
    scanDevicesMock.mockResolvedValue([
      { id: 'serial-1', name: 'Pixel', status: 'online' },
      { id: 'serial-2', name: 'OnePlus', status: 'online' }
    ])

    await expect(deviceChatCommandService.run('设备 返回')).rejects.toThrow('明确设备 ID')
  })

  it('runs double tap with percentage coordinates', async () => {
    scanDevicesMock.mockResolvedValue([{ id: 'serial-1', name: 'Pixel', status: 'online' }])

    await deviceChatCommandService.run('设备 双击 50% 80% 150')

    expect(sendDoubleTapMock).toHaveBeenCalledWith('serial-1', 500, 1600, 150)
  })

  it('runs long press with coordinates', async () => {
    scanDevicesMock.mockResolvedValue([{ id: 'serial-1', name: 'Pixel', status: 'online' }])

    await deviceChatCommandService.run('设备 长按 200 300 900')

    expect(sendLongPressMock).toHaveBeenCalledWith('serial-1', 200, 300, 900)
  })

  it('runs drag with coordinates', async () => {
    scanDevicesMock.mockResolvedValue([{ id: 'serial-1', name: 'Pixel', status: 'online' }])

    await deviceChatCommandService.run('设备 拖拽 10% 80% 90% 20% 1000')

    expect(sendDragMock).toHaveBeenCalledWith('serial-1', 100, 1600, 900, 400, 1000)
  })

  it('starts an app by package name', async () => {
    scanDevicesMock.mockResolvedValue([{ id: 'serial-1', name: 'Pixel', status: 'online' }])

    await deviceChatCommandService.run('设备 启动应用 com.example.app')

    expect(startAppMock).toHaveBeenCalledWith('serial-1', 'com.example.app')
  })

  it('reads the current foreground app', async () => {
    scanDevicesMock.mockResolvedValue([{ id: 'serial-1', name: 'Pixel', status: 'online' }])
    getForegroundAppMock.mockResolvedValue({ packageName: 'com.example.app', activity: '.MainActivity' })

    const result = await deviceChatCommandService.run('设备 当前前台应用')

    expect(getForegroundAppMock).toHaveBeenCalledWith('serial-1')
    expect(result).toContain('com.example.app/.MainActivity')
  })

  it('handles permission dialog actions', async () => {
    scanDevicesMock.mockResolvedValue([{ id: 'serial-1', name: 'Pixel', status: 'online' }])
    handlePermissionDialogMock.mockResolvedValue(true)

    await deviceChatCommandService.run('设备 权限允许')

    expect(handlePermissionDialogMock).toHaveBeenCalledWith('serial-1', 'allow')
  })
})
