import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendTapMock = vi.hoisted(() => vi.fn())
const sendSwipeMock = vi.hoisted(() => vi.fn())
const startAppMock = vi.hoisted(() => vi.fn())
const getScreenshotMock = vi.hoisted(() => vi.fn())
const captureScrcpyWindowMock = vi.hoisted(() => vi.fn())
const runVisionActionMock = vi.hoisted(() => vi.fn())
const getLatestFrameMock = vi.hoisted(() => vi.fn())

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
  VisionActionNeedsHumanError: class VisionActionNeedsHumanError extends Error {
    constructor(readonly intervention: unknown) {
      super('Needs human')
    }
  },
  deviceVisionActionService: {
    runVisionAction: runVisionActionMock
  }
}))

vi.mock('../ScrcpyFrameService', () => ({
  scrcpyFrameService: { getLatestFrame: getLatestFrameMock }
}))

import { DeviceActionRuntime } from '../DeviceActionRuntime'
import { VisionActionNeedsHumanError } from '../DeviceVisionActionService'

describe('DeviceActionRuntime', () => {
  beforeEach(() => {
    sendTapMock.mockReset()
    sendSwipeMock.mockReset()
    startAppMock.mockReset()
    getScreenshotMock.mockReset()
    captureScrcpyWindowMock.mockReset()
    runVisionActionMock.mockReset()
    getLatestFrameMock.mockReset()
  })

  it('executes tap actions against the requested device', async () => {
    const runtime = new DeviceActionRuntime()

    const result = await runtime.execute('device-1', { type: 'tap', params: { x: 10, y: 20 } })

    expect(result.success).toBe(true)
    expect(sendTapMock).toHaveBeenCalledWith('device-1', 10, 20)
  })

  it('captures screenshots from the scrcpy frame stream', async () => {
    getLatestFrameMock.mockResolvedValue({
      imageBase64: 'stream',
      source: 'scrcpy_stream',
      width: 100,
      height: 200
    })
    const runtime = new DeviceActionRuntime()

    const result = await runtime.execute('device-1', { type: 'screenshot' })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ source: 'scrcpy_stream', imageBase64: 'stream' })
    expect(getLatestFrameMock).toHaveBeenCalledWith('device-1', { maxAgeMs: 1_000 })
    expect(getScreenshotMock).not.toHaveBeenCalled()
    expect(captureScrcpyWindowMock).not.toHaveBeenCalled()
  })

  it('falls back to ADB when the scrcpy frame stream is unavailable', async () => {
    getLatestFrameMock.mockRejectedValue(new Error('stream unavailable'))
    getScreenshotMock.mockResolvedValue({ imageBase64: 'adb', source: 'adb', width: 100, height: 200 })
    const runtime = new DeviceActionRuntime()

    const result = await runtime.execute('device-1', { type: 'screenshot' })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ source: 'adb', imageBase64: 'adb' })
  })

  it('does not fall back to ADB when scrcpy evidence is required', async () => {
    getLatestFrameMock.mockRejectedValue(new Error('stream unavailable'))
    const runtime = new DeviceActionRuntime()

    const result = await runtime.execute('device-1', {
      type: 'screenshot',
      params: { requireScrcpy: true, maxAgeMs: 500 }
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('stream unavailable')
    expect(getLatestFrameMock).toHaveBeenCalledWith('device-1', { maxAgeMs: 500 })
    expect(getScreenshotMock).not.toHaveBeenCalled()
  })

  it('rejects invalid package names before app start', async () => {
    const runtime = new DeviceActionRuntime()

    const result = await runtime.execute('device-1', { type: 'start_app', params: { packageName: 'bad;pkg' } })

    expect(result.success).toBe(false)
    expect(startAppMock).not.toHaveBeenCalled()
  })

  it('returns the requested package name after app start succeeds', async () => {
    const runtime = new DeviceActionRuntime()

    const result = await runtime.execute('device-1', {
      type: 'start_app',
      params: { packageName: 'com.sankuai.meituan' }
    })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ packageName: 'com.sankuai.meituan' })
    expect(startAppMock).toHaveBeenCalledWith('device-1', 'com.sankuai.meituan')
  })

  it('delegates VLM instructions to the vision action service', async () => {
    runVisionActionMock.mockResolvedValue({ ok: true })
    const runtime = new DeviceActionRuntime()

    const result = await runtime.execute('device-1', {
      type: 'vision_instruction',
      params: { instruction: 'tap the search box' }
    })

    expect(result.success).toBe(true)
    expect(runVisionActionMock).toHaveBeenCalledWith(
      'device-1',
      'tap the search box',
      ['tap', 'swipe'],
      undefined,
      undefined
    )
  })

  it('passes the abort signal to the vision action service', async () => {
    runVisionActionMock.mockResolvedValue({ ok: true })
    const controller = new AbortController()
    const runtime = new DeviceActionRuntime()

    await runtime.execute('device-1', {
      type: 'vision_instruction',
      params: { instruction: 'tap the search box', signal: controller.signal }
    })

    expect(runVisionActionMock).toHaveBeenCalledWith(
      'device-1',
      'tap the search box',
      ['tap', 'swipe'],
      undefined,
      controller.signal
    )
  })

  it('preserves human intervention details from vision actions', async () => {
    const intervention = { needsHuman: true, code: 'vision_output_invalid', rawResponse: 'invalid' }
    runVisionActionMock.mockRejectedValue(new VisionActionNeedsHumanError(intervention as never))
    const runtime = new DeviceActionRuntime()

    const result = await runtime.execute('device-1', {
      type: 'vision_instruction',
      params: { instruction: 'tap the search box' }
    })

    expect(result.success).toBe(false)
    expect(result.data).toEqual(intervention)
  })
})
