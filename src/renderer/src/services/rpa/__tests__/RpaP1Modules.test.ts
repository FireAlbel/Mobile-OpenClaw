import { describe, expect, it, vi } from 'vitest'

import { handlePopupModule, swipeUntilVlmTargetModule, tapByVlmTargetModule } from '../RpaP1Modules'
import type { RpaDeviceRuntime, RpaTask } from '../RpaTypes'

const visionModel = {
  id: 'qwen-vl-max',
  provider: 'qwen',
  name: 'Qwen VL Max',
  group: 'qwen'
}

function runtime(overrides: Partial<RpaDeviceRuntime> = {}): RpaDeviceRuntime {
  return {
    screenshot: vi.fn(),
    tap: vi.fn(),
    swipe: vi.fn(),
    key: vi.fn(),
    startApp: vi.fn(),
    getForegroundApp: vi.fn(),
    getScreenSize: vi.fn(),
    handlePermissionDialog: vi.fn().mockResolvedValue({
      success: true,
      message: 'handled',
      data: true
    }),
    visionInstruction: vi.fn().mockResolvedValue({
      success: true,
      message: 'vision ok',
      data: { action: 'tap' }
    }),
    ...overrides
  } as RpaDeviceRuntime
}

function context(testRuntime: RpaDeviceRuntime) {
  return {
    deviceId: 'device-1',
    task: {
      id: 'task',
      name: 'task',
      goal: 'goal',
      deviceIds: ['device-1'],
      steps: [],
      visionModel,
      metadata: {}
    } as RpaTask,
    step: {
      id: 'step',
      name: 'step',
      moduleId: 'module',
      params: {},
      continueOnFailure: false
    },
    attempt: 1,
    runtime: testRuntime
  }
}

describe('RpaP1Modules', () => {
  it('handles permission popups through runtime', async () => {
    const testRuntime = runtime()

    const result = await handlePopupModule.execute(context(testRuntime), { action: 'allow', required: false })

    expect(result.success).toBe(true)
    expect(testRuntime.handlePermissionDialog).toHaveBeenCalledWith('device-1', 'allow')
  })

  it('requests human intervention when a required popup is missing', async () => {
    const testRuntime = runtime({
      handlePermissionDialog: vi.fn().mockResolvedValue({ success: true, message: 'not found', data: false })
    })

    const result = await handlePopupModule.execute(context(testRuntime), { action: 'allow', required: true })

    expect(result.status).toBe('needs_human')
  })

  it('delegates tap target selection to VLM with tap-only action', async () => {
    const testRuntime = runtime()

    const result = await tapByVlmTargetModule.execute(context(testRuntime), { target: 'coin icon' })

    expect(result.success).toBe(true)
    expect(testRuntime.visionInstruction).toHaveBeenCalledWith(
      'device-1',
      'Find and tap this visual target: coin icon',
      ['tap'],
      visionModel,
      undefined
    )
  })

  it('runs bounded VLM swipe attempts', async () => {
    const testRuntime = runtime()

    const result = await swipeUntilVlmTargetModule.execute(context(testRuntime), {
      target: 'task card',
      direction: 'up',
      maxAttempts: 2
    })

    expect(result.success).toBe(true)
    expect(testRuntime.visionInstruction).toHaveBeenCalledTimes(2)
  })

  it('preserves vision requests that need human intervention', async () => {
    const testRuntime = runtime({
      visionInstruction: vi.fn().mockResolvedValue({
        success: false,
        message: 'VLM output could not be corrected',
        data: { needsHuman: true, rawResponse: 'invalid' }
      })
    })

    const result = await tapByVlmTargetModule.execute(context(testRuntime), { target: 'coin icon' })

    expect(result.status).toBe('needs_human')
  })
})
