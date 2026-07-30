import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RpaDeviceActionRuntimeAdapter } from '../RpaDeviceActionRuntimeAdapter'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  handlePermissionDialog: vi.fn(),
  executeAdbCommand: vi.fn()
}))

vi.mock('../../DeviceActionRuntime', () => ({
  deviceActionRuntime: { execute: mocks.execute }
}))

vi.mock('../../DeviceServiceProxy', () => ({
  deviceServiceProxy: {
    handlePermissionDialog: mocks.handlePermissionDialog,
    executeAdbCommand: mocks.executeAdbCommand
  }
}))

describe('RpaDeviceActionRuntimeAdapter', () => {
  beforeEach(() => {
    mocks.execute.mockReset()
    mocks.handlePermissionDialog.mockReset()
    mocks.executeAdbCommand.mockReset()
  })

  it('compiles a whitelisted tap into the device action runtime', async () => {
    mocks.execute.mockResolvedValue({
      success: true,
      message: 'tap complete',
      startedAt: 1,
      finishedAt: 2
    })
    const adapter = new RpaDeviceActionRuntimeAdapter()
    const action = { id: 'tap-close', type: 'tap' as const, x: 10, y: 20 }

    const result = await adapter.executeCorrectionAction('device-1', action)

    expect(mocks.execute).toHaveBeenCalledWith('device-1', {
      type: 'tap',
      params: { x: expect.any(Number), y: expect.any(Number) }
    })
    expect(result.data).toMatchObject({ transport: 'device_action_runtime', action })
    expect(result.data).toMatchObject({ result: { humanization: { kind: 'tap', requested: { x: 10, y: 20 } } } })
  })

  it('prefers a fresh scrcpy frame but allows the ADB screenshot fallback', async () => {
    mocks.execute.mockResolvedValue({ success: true, message: 'captured', startedAt: 1, finishedAt: 2 })
    const adapter = new RpaDeviceActionRuntimeAdapter()

    await adapter.screenshot('device-1')

    expect(mocks.execute).toHaveBeenCalledWith('device-1', {
      type: 'screenshot',
      params: { requireScrcpy: false, maxAgeMs: 1_000 }
    })
  })

  it('routes deterministic app restarts through the device action runtime', async () => {
    mocks.execute.mockResolvedValue({ success: true, message: 'restarted', startedAt: 1, finishedAt: 2 })
    const adapter = new RpaDeviceActionRuntimeAdapter()

    await adapter.restartApp('device-1', 'com.example.app')

    expect(mocks.execute).toHaveBeenCalledWith('device-1', {
      type: 'restart_app',
      params: { packageName: 'com.example.app' }
    })
  })

  it('routes permission actions through the constrained permission service', async () => {
    mocks.handlePermissionDialog.mockResolvedValue(true)
    const adapter = new RpaDeviceActionRuntimeAdapter()

    const result = await adapter.executeCorrectionAction('device-1', {
      id: 'allow-dialog',
      type: 'permission_action',
      action: 'allow'
    })

    expect(mocks.handlePermissionDialog).toHaveBeenCalledWith('device-1', 'allow')
    expect(result.data).toMatchObject({ transport: 'android_permission_service' })
  })

  it('executes a Bezier swipe through Android motion events and records the path', async () => {
    let uiTreeCalls = 0
    mocks.executeAdbCommand.mockImplementation(async (_deviceId, command) => {
      if (command.includes('shell cat')) {
        uiTreeCalls += 1
        return `<hierarchy><node text="${uiTreeCalls === 1 ? 'before' : 'after'}" /></hierarchy>`
      }
      return ''
    })
    mocks.execute
      .mockResolvedValueOnce({
        success: true,
        message: 'before',
        data: { imageBase64: 'before-screen' },
        startedAt: 1,
        finishedAt: 2
      })
      .mockResolvedValueOnce({
        success: true,
        message: 'after',
        data: { imageBase64: 'after-screen' },
        startedAt: 1,
        finishedAt: 2
      })
    const adapter = new RpaDeviceActionRuntimeAdapter()

    const result = await adapter.swipe('device-1', 500, 1800, 500, 500, 600, {
      enabled: false,
      seed: 'test-swipe',
      pathSamples: 6
    })

    expect(mocks.executeAdbCommand).toHaveBeenCalledWith(
      'device-1',
      expect.stringContaining('input touchscreen motionevent DOWN 500 1800')
    )
    expect(result.data).toMatchObject({
      transport: 'adb_motionevent_bezier',
      screenChanged: true,
      humanization: { kind: 'swipe', path: expect.any(Array) }
    })
  })

  it('falls back to a standard ADB swipe when motion events do not change the screen', async () => {
    let uiTreeCalls = 0
    mocks.executeAdbCommand.mockImplementation(async (_deviceId, command) => {
      if (command.includes('shell cat')) {
        uiTreeCalls += 1
        return `<hierarchy><node text="${uiTreeCalls < 3 ? 'same' : 'changed'}" /></hierarchy>`
      }
      return ''
    })
    mocks.execute.mockImplementation(async (_deviceId, request) => {
      if (request.type === 'screenshot') {
        const screenshotCalls = mocks.execute.mock.calls.filter((call) => call[1].type === 'screenshot').length
        return {
          success: true,
          message: 'captured',
          data: { imageBase64: screenshotCalls < 3 ? 'same-screen' : 'changed-screen' },
          startedAt: 1,
          finishedAt: 2
        }
      }
      return { success: true, message: 'fallback complete', startedAt: 1, finishedAt: 2 }
    })
    const adapter = new RpaDeviceActionRuntimeAdapter()

    const result = await adapter.swipe('device-1', 10, 20, 30, 40, 500, { enabled: false })

    expect(mocks.execute).toHaveBeenCalledWith('device-1', {
      type: 'swipe',
      params: { x1: 10, y1: 20, x2: 30, y2: 40, duration: 500 }
    })
    expect(result).toMatchObject({ success: true, data: { transport: 'adb_swipe_fallback', screenChanged: true } })
  })

  it('reports an ineffective standard ADB swipe when the screen remains unchanged', async () => {
    mocks.executeAdbCommand.mockImplementation(async (_deviceId, command) =>
      command.includes('shell cat') ? '<hierarchy><node text="same" /></hierarchy>' : ''
    )
    mocks.execute.mockImplementation(async (_deviceId, request) =>
      request.type === 'screenshot'
        ? {
            success: true,
            message: 'captured',
            data: { imageBase64: 'same-screen' },
            startedAt: 1,
            finishedAt: 2
          }
        : { success: true, message: 'fallback complete', startedAt: 1, finishedAt: 2 }
    )
    const adapter = new RpaDeviceActionRuntimeAdapter()

    const result = await adapter.swipe('device-1', 10, 20, 30, 40, 500, { enabled: false })

    expect(result).toMatchObject({
      success: false,
      message: 'ADB swipe completed without an observable screen change',
      data: { transport: 'adb_swipe_fallback', screenChanged: false }
    })
  })

  it('ignores transient focus changes when validating swipe progress', async () => {
    mocks.executeAdbCommand.mockImplementation(async (_deviceId, command) =>
      command.includes('shell cat')
        ? `<hierarchy><node text="Settings" focused="${mocks.executeAdbCommand.mock.calls.length < 4}" /></hierarchy>`
        : ''
    )
    mocks.execute.mockImplementation(async (_deviceId, request) =>
      request.type === 'screenshot'
        ? {
            success: true,
            message: 'captured',
            data: { imageBase64: `${mocks.execute.mock.calls.length}-animated-status-bar` },
            startedAt: 1,
            finishedAt: 2
          }
        : { success: true, message: 'fallback complete', startedAt: 1, finishedAt: 2 }
    )
    const adapter = new RpaDeviceActionRuntimeAdapter()

    const result = await adapter.swipe('device-1', 10, 20, 30, 40, 500, { enabled: false })

    expect(result).toMatchObject({
      success: false,
      data: { transport: 'adb_swipe_fallback', screenChanged: false }
    })
  })

  it('records a bounded ADB swipe fallback when motion events are unavailable', async () => {
    mocks.executeAdbCommand.mockRejectedValue(new Error('motionevent unavailable'))
    mocks.execute.mockResolvedValue({ success: true, message: 'fallback complete', startedAt: 1, finishedAt: 2 })
    const adapter = new RpaDeviceActionRuntimeAdapter()

    const result = await adapter.swipe('device-1', 10, 20, 30, 40, 500, { enabled: false })

    expect(mocks.execute).toHaveBeenCalledWith('device-1', {
      type: 'swipe',
      params: { x1: 10, y1: 20, x2: 30, y2: 40, duration: 500 }
    })
    expect(result.data).toMatchObject({ transport: 'adb_swipe_fallback' })
  })

  it('serializes actions independently for each device', async () => {
    let active = 0
    let maxActive = 0
    mocks.execute.mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
      return { success: true, message: 'tap complete', startedAt: 1, finishedAt: 2 }
    })
    const adapter = new RpaDeviceActionRuntimeAdapter()

    await Promise.all([
      adapter.tap('device-1', 10, 20, { enabled: false }),
      adapter.tap('device-1', 30, 40, { enabled: false })
    ])

    expect(maxActive).toBe(1)

    maxActive = 0
    await Promise.all([
      adapter.tap('device-1', 10, 20, { enabled: false }),
      adapter.tap('device-2', 30, 40, { enabled: false })
    ])

    expect(maxActive).toBe(2)
  })
})
