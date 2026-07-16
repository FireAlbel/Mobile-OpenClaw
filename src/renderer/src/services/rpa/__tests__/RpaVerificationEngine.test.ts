import { describe, expect, it, vi } from 'vitest'

import type { RpaDeviceRuntime, RpaModuleResult } from '../RpaTypes'
import { RpaVerificationEngine } from '../RpaVerificationEngine'

function runtime(overrides: Partial<RpaDeviceRuntime> = {}): RpaDeviceRuntime {
  return {
    screenshot: vi.fn().mockResolvedValue({ success: true, message: 'screenshot ok', data: { imageBase64: 'png' } }),
    tap: vi.fn(),
    swipe: vi.fn(),
    key: vi.fn(),
    startApp: vi.fn(),
    getForegroundApp: vi.fn().mockResolvedValue({
      success: true,
      message: 'foreground ok',
      data: { packageName: 'com.example.app' }
    }),
    getScreenSize: vi.fn(),
    handlePermissionDialog: vi.fn(),
    visionInstruction: vi.fn(),
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
})
