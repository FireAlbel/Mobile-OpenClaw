import { describe, expect, it, vi } from 'vitest'

import { tapPercentModule } from '../RpaBaseModules'
import type { RpaDeviceRuntime, RpaTask } from '../RpaTypes'

function runtime(): RpaDeviceRuntime {
  return {
    screenshot: vi.fn(),
    tap: vi.fn().mockResolvedValue({ success: true, message: 'tap ok', startedAt: 1, finishedAt: 2 }),
    swipe: vi.fn(),
    key: vi.fn(),
    startApp: vi.fn(),
    getForegroundApp: vi.fn(),
    getScreenSize: vi.fn().mockResolvedValue({
      success: true,
      message: 'size ok',
      data: { width: 1000, height: 2000 },
      startedAt: 1,
      finishedAt: 2
    })
  }
}

describe('RpaBaseModules', () => {
  it('maps percent tap coordinates to screen coordinates', async () => {
    const testRuntime = runtime()

    const result = await tapPercentModule.execute(
      {
        deviceId: 'device-1',
        task: { id: 'task', name: 'task', goal: 'goal', deviceIds: ['device-1'], steps: [], metadata: {} } as RpaTask,
        step: {
          id: 'step',
          name: 'tap',
          moduleId: 'tap_percent',
          params: { x: 0.25, y: 0.5 },
          continueOnFailure: false
        },
        attempt: 1,
        runtime: testRuntime
      },
      { x: 0.25, y: 0.5 }
    )

    expect(result.success).toBe(true)
    expect(testRuntime.tap).toHaveBeenCalledWith('device-1', 250, 1000)
  })
})
