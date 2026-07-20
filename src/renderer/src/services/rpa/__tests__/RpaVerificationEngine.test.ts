import { describe, expect, it, vi } from 'vitest'

import type { RpaModelClient } from '../RpaModelClient'
import type { RpaDeviceRuntime, RpaModuleResult } from '../RpaTypes'
import { RpaVerificationEngine } from '../RpaVerificationEngine'

function runtime(overrides: Partial<RpaDeviceRuntime> = {}): RpaDeviceRuntime {
  return {
    screenshot: vi.fn().mockResolvedValue({
      success: true,
      message: 'screenshot ok',
      data: { imageBase64: 'png', mime: 'image/png', width: 1080, height: 2400 }
    }),
    tap: vi.fn(),
    swipe: vi.fn(),
    key: vi.fn(),
    startApp: vi.fn(),
    getForegroundApp: vi.fn().mockResolvedValue({
      success: true,
      message: 'foreground ok',
      data: { packageName: 'com.example.app' }
    }),
    getScreenSize: vi.fn().mockResolvedValue({
      success: true,
      message: 'screen size',
      data: { width: 1080, height: 2400 }
    }),
    handlePermissionDialog: vi.fn(),
    visionInstruction: vi.fn(),
    locateVisualTarget: vi.fn(),
    ...overrides
  } as RpaDeviceRuntime
}

const successResult: RpaModuleResult = {
  success: true,
  status: 'passed',
  message: 'module ok',
  startedAt: 1,
  finishedAt: 2
}

describe('RpaVerificationEngine', () => {
  it('passes module result verification when the module succeeds', async () => {
    const engine = new RpaVerificationEngine({ runtime: runtime() })

    const result = await engine.verify({ type: 'module_result_success' }, successResult, 'device-1')

    expect(result.status).toBe('passed')
  })

  it('verifies foreground app with observation data', async () => {
    const engine = new RpaVerificationEngine({ runtime: runtime() })

    const result = await engine.verify(
      { type: 'foreground_app', packageName: 'com.example.app' },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('passed')
    expect(result.confidence).toBe(1)
  })

  it('includes foreground observation warning when foreground app is unavailable', async () => {
    const engine = new RpaVerificationEngine({
      runtime: runtime({
        getForegroundApp: vi.fn().mockResolvedValue({
          success: false,
          message: 'Unable to parse foreground app'
        })
      })
    })

    const result = await engine.verify(
      { type: 'foreground_app', packageName: 'com.example.app' },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('uncertain')
    expect(result.message).toContain('Unable to parse foreground app')
  })

  it('marks missing observation screenshot as uncertain', async () => {
    const engine = new RpaVerificationEngine({
      runtime: runtime({
        screenshot: vi.fn().mockResolvedValue({ success: false, message: 'missing screenshot' })
      })
    })

    const result = await engine.verify({ type: 'observation_has_screenshot' }, successResult, 'device-1')

    expect(result.status).toBe('uncertain')
  })

  it('fails a VLM business assertion when the expected screen state is absent', async () => {
    const complete = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ passed: false, confidence: 0.96, reason: 'The task list is not visible' }))
    const engine = new RpaVerificationEngine({
      runtime: runtime(),
      modelClient: { complete } as RpaModelClient
    })

    const result = await engine.verify(
      { type: 'vlm_assert', expectation: 'The coin task list is visible', minConfidence: 0.7, settleMs: 0 },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('failed')
    expect(result.confidence).toBe(0.96)
    expect(complete).toHaveBeenCalledOnce()
  })

  it('marks a low-confidence VLM assertion as uncertain', async () => {
    const engine = new RpaVerificationEngine({
      runtime: runtime(),
      modelClient: {
        complete: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify({ passed: true, confidence: 0.4, reason: 'The screen is partially obscured' })
          )
      } as RpaModelClient
    })

    const result = await engine.verify(
      { type: 'vlm_assert', expectation: 'The reward was credited', minConfidence: 0.7, settleMs: 0 },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('uncertain')
  })

  it('converts a VLM request error into an uncertain verification result', async () => {
    const engine = new RpaVerificationEngine({
      runtime: runtime(),
      modelClient: {
        complete: vi.fn().mockRejectedValue(new Error('model unavailable'))
      } as RpaModelClient
    })

    const result = await engine.verify(
      { type: 'vlm_assert', expectation: 'The reward was credited', minConfidence: 0.7, settleMs: 0 },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('uncertain')
    expect(result.message).toContain('model unavailable')
  })

  it('forces a visual assertion after a correction action group', async () => {
    const complete = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ passed: true, confidence: 0.97, reason: 'The popup is gone' }))
    const engine = new RpaVerificationEngine({
      runtime: runtime(),
      modelClient: { complete } as RpaModelClient
    })

    const result = await engine.verifyCorrection({
      deviceId: 'device-1',
      expectation: 'The popup is gone',
      actionResults: [successResult],
      settleMs: 0
    })

    expect(result.status).toBe('passed')
    expect(complete).toHaveBeenCalledOnce()
    expect(result.evidence).toMatchObject({ actionResults: [successResult] })
  })
})
