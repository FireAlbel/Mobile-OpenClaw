import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendTapMock = vi.hoisted(() => vi.fn())
const sendSwipeMock = vi.hoisted(() => vi.fn())
const startAppMock = vi.hoisted(() => vi.fn())
const getScreenshotMock = vi.hoisted(() => vi.fn())
const captureScrcpyWindowMock = vi.hoisted(() => vi.fn())
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
    captureScrcpyWindow: captureScrcpyWindowMock,
    getScreenshot: getScreenshotMock,
    sendTap: sendTapMock,
    sendSwipe: sendSwipeMock,
    startApp: startAppMock
  }
}))

vi.mock('../DeviceVisionActionService', () => ({
  deviceVisionActionService: {
    runVisionAction: runVisionActionMock
  }
}))

import { DeviceActionRuntime } from '../DeviceActionRuntime'

describe('DeviceActionRuntime', () => {
  beforeEach(() => {
    sendTapMock.mockReset()
    sendSwipeMock.mockReset()
    startAppMock.mockReset()
    getScreenshotMock.mockReset()
    captureScrcpyWindowMock.mockReset()
    runVisionActionMock.mockReset()
  })

  it('executes tap actions against the requested device', async () => {
    const runtime = new DeviceActionRuntime()

    const result = await runtime.execute('device-1', { type: 'tap', params: { x: 10, y: 20 } })

    expect(result.success).toBe(true)
    expect(sendTapMock).toHaveBeenCalledWith('device-1', 10, 20)
  })

  it('falls back to adb screenshot when scrcpy capture fails', async () => {
    captureScrcpyWindowMock.mockRejectedValue(new Error('no window'))
    getScreenshotMock.mockResolvedValue({ imageBase64: 'adb' })
    const runtime = new DeviceActionRuntime()

    const result = await runtime.execute('device-1', { type: 'screenshot' })

    expect(result.success).toBe(true)
    expect(getScreenshotMock).toHaveBeenCalledWith('device-1')
  })

  it('rejects invalid package names before app start', async () => {
    const runtime = new DeviceActionRuntime()

    const result = await runtime.execute('device-1', { type: 'start_app', params: { packageName: 'bad;pkg' } })

    expect(result.success).toBe(false)
    expect(startAppMock).not.toHaveBeenCalled()
  })

  it('delegates VLM instructions to the vision action service', async () => {
    runVisionActionMock.mockResolvedValue({ ok: true })
    const runtime = new DeviceActionRuntime()

    const result = await runtime.execute('device-1', {
      type: 'vision_instruction',
      params: { instruction: 'tap the search box' }
    })

    expect(result.success).toBe(true)
    expect(runVisionActionMock).toHaveBeenCalledWith('device-1', 'tap the search box')
  })
})
