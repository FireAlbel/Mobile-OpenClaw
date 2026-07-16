import { describe, expect, it, vi } from 'vitest'

import { RpaObservationService } from '../RpaObservationService'
import type { RpaDeviceRuntime } from '../RpaTypes'

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
    getScreenSize: vi.fn().mockResolvedValue({
      success: true,
      message: 'size ok',
      data: { width: 1000, height: 2000 }
    }),
    handlePermissionDialog: vi.fn(),
    visionInstruction: vi.fn(),
    ...overrides
  } as RpaDeviceRuntime
}

describe('RpaObservationService', () => {
  it('captures screenshot, foreground app, and screen size', async () => {
    const service = new RpaObservationService(runtime())

    const observation = await service.capture('device-1')

    expect(observation.deviceId).toBe('device-1')
    expect(observation.screenshot).toEqual({ imageBase64: 'png' })
    expect(observation.foregroundApp).toEqual({ packageName: 'com.example.app' })
    expect(observation.screenSize).toEqual({ width: 1000, height: 2000 })
    expect(observation.warnings).toEqual([])
  })

  it('returns partial observations with warnings when one source fails', async () => {
    const service = new RpaObservationService(
      runtime({
        screenshot: vi.fn().mockResolvedValue({ success: false, message: 'no screenshot' })
      })
    )

    const observation = await service.capture('device-1')

    expect(observation.screenshot).toBeUndefined()
    expect(observation.foregroundApp).toEqual({ packageName: 'com.example.app' })
    expect(observation.warnings).toEqual([{ source: 'screenshot', message: 'no screenshot' }])
  })
})
