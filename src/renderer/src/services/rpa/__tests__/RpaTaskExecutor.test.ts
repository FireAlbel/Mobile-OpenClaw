import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import { RpaModuleRegistry } from '../RpaModuleRegistry'
import { RpaTaskExecutor } from '../RpaTaskExecutor'
import type { RpaActionModule, RpaDeviceRuntime, RpaTask } from '../RpaTypes'

function runtime(overrides: Partial<RpaDeviceRuntime> = {}): RpaDeviceRuntime {
  return {
    screenshot: vi.fn().mockResolvedValue({ success: true, message: 'screenshot ok', data: { imageBase64: 'png' } }),
    tap: vi.fn().mockResolvedValue({ success: true, message: 'tap ok' }),
    swipe: vi.fn(),
    key: vi.fn(),
    startApp: vi.fn(),
    getForegroundApp: vi.fn().mockResolvedValue({
      success: true,
      message: 'foreground ok',
      data: { packageName: 'com.example.app' }
    }),
    getScreenSize: vi.fn(),
    ...overrides
  } as RpaDeviceRuntime
}

function task(moduleId = 'ok_module'): RpaTask {
  return {
    id: 'task-1',
    name: 'Task',
    goal: 'Run task',
    deviceIds: ['device-1'],
    metadata: {},
    steps: [
      {
        id: 'step-1',
        name: 'Step',
        moduleId,
        params: {},
        continueOnFailure: false,
        retry: { maxAttempts: 2, backoffMs: 0, retryOn: ['failed', 'timeout', 'uncertain'] }
      }
    ]
  }
}

function moduleWithExecutor(execute: RpaActionModule['execute']): RpaActionModule {
  return {
    metadata: {
      id: 'ok_module',
      name: 'OK',
      description: 'Test module',
      riskLevel: 'low',
      defaultTimeoutMs: 1000,
      defaultRetry: { maxAttempts: 1, backoffMs: 0, retryOn: ['failed'] }
    },
    paramsSchema: z.object({}).default({}),
    execute
  }
}

describe('RpaTaskExecutor', () => {
  it('runs a validated task', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: true,
        status: 'passed',
        message: 'ok',
        startedAt: 1,
        finishedAt: 2
      }))
    )
    const executor = new RpaTaskExecutor({ registry, runtime: runtime() })

    const result = await executor.run(task(), 'device-1')

    expect(result.success).toBe(true)
    expect(result.status).toBe('completed')
    expect(result.events.some((event) => event.status === 'passed')).toBe(true)
  })

  it('retries failed steps', async () => {
    const registry = new RpaModuleRegistry()
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ success: false, status: 'failed', message: 'first failed', startedAt: 1, finishedAt: 2 })
      .mockResolvedValueOnce({ success: true, status: 'passed', message: 'second ok', startedAt: 3, finishedAt: 4 })
    registry.register(moduleWithExecutor(execute))
    const executor = new RpaTaskExecutor({ registry, runtime: runtime() })

    const result = await executor.run(task(), 'device-1')

    expect(result.success).toBe(true)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('supports foreground app verification', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: true,
        status: 'passed',
        message: 'ok',
        startedAt: 1,
        finishedAt: 2
      }))
    )
    const testTask = task()
    testTask.steps[0].verify = { type: 'foreground_app', packageName: 'com.example.app' }
    const executor = new RpaTaskExecutor({ registry, runtime: runtime() })

    const result = await executor.run(testTask, 'device-1')

    expect(result.success).toBe(true)
  })

  it('fails when the selected device is not assigned', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(moduleWithExecutor(vi.fn()))
    const executor = new RpaTaskExecutor({ registry, runtime: runtime() })

    await expect(executor.run(task(), 'device-2')).rejects.toThrow('not assigned')
  })
})
