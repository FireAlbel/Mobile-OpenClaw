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
    getScreenSize: vi.fn().mockResolvedValue({
      success: true,
      message: 'screen size',
      data: { width: 1080, height: 2400 }
    }),
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
    locateVisualTarget: vi.fn().mockResolvedValue({
      success: true,
      message: 'target found',
      data: { found: true, confidence: 0.95, reason: 'visible' }
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
    const locateVisualTarget = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        message: 'not found',
        data: { found: false, confidence: 0.9, reason: 'not visible' }
      })
      .mockResolvedValueOnce({
        success: true,
        message: 'found',
        data: { found: true, confidence: 0.95, reason: 'visible' }
      })
    const testRuntime = runtime({
      locateVisualTarget,
      swipe: vi.fn().mockResolvedValue({ success: true, message: 'swiped' })
    })

    const result = await swipeUntilVlmTargetModule.execute(context(testRuntime), {
      target: 'task card',
      direction: 'up',
      maxAttempts: 2
    })

    expect(result.success).toBe(true)
    expect(locateVisualTarget).toHaveBeenCalledTimes(2)
    expect(testRuntime.swipe).toHaveBeenCalledTimes(1)
  })

  it('fails when the target is still missing after bounded search', async () => {
    const testRuntime = runtime({
      locateVisualTarget: vi.fn().mockResolvedValue({
        success: true,
        message: 'not found',
        data: { found: false, confidence: 0.9, reason: 'not visible' }
      }),
      swipe: vi.fn().mockResolvedValue({ success: true, message: 'swiped' })
    })

    const result = await swipeUntilVlmTargetModule.execute(context(testRuntime), {
      target: 'task card',
      direction: 'up',
      maxAttempts: 2
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('not found after 2 attempts')
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
