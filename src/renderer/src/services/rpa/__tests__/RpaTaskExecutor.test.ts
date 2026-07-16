import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import { RpaModuleRegistry } from '../RpaModuleRegistry'
import type { RpaObservationService } from '../RpaObservationService'
import type { RpaReplanResult, RpaReplanService } from '../RpaReplanService'
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
    handlePermissionDialog: vi.fn(),
    visionInstruction: vi.fn(),
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

function recoveryDependencies(decisions: RpaReplanResult[]) {
  const capture = vi.fn().mockResolvedValue({
    deviceId: 'device-1',
    capturedAt: 10,
    screenshot: { imageBase64: 'png', mime: 'image/png' },
    warnings: [],
    artifacts: {}
  })
  const replan = vi.fn()
  for (const decision of decisions) replan.mockResolvedValueOnce(decision)
  return {
    observationService: { capture } as unknown as RpaObservationService,
    replanService: { replan } as unknown as RpaReplanService,
    capture,
    replan
  }
}

function recoveryResult(status: RpaReplanResult['status'], steps: RpaReplanResult['steps'] = []): RpaReplanResult {
  return {
    status,
    steps,
    issues: [],
    message: `${status} decision`,
    confidence: status === 'needs_human' ? 0.4 : 0.9
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

  it('stops retrying when a step needs human intervention', async () => {
    const registry = new RpaModuleRegistry()
    const execute = vi.fn().mockResolvedValue({
      success: false,
      status: 'needs_human',
      message: 'Manual review required',
      data: { needsHuman: true },
      startedAt: 1,
      finishedAt: 2
    })
    registry.register(moduleWithExecutor(execute))
    const recovery = recoveryDependencies([recoveryResult('needs_human')])
    const executor = new RpaTaskExecutor({ registry, runtime: runtime(), ...recovery })

    const result = await executor.run(task(), 'device-1')

    expect(result.status).toBe('needs_human')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('retries the original step when VLM selects retry', async () => {
    const registry = new RpaModuleRegistry()
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ success: false, status: 'failed', message: 'blocked', startedAt: 1, finishedAt: 2 })
      .mockResolvedValueOnce({ success: true, status: 'passed', message: 'recovered', startedAt: 3, finishedAt: 4 })
    registry.register(moduleWithExecutor(execute))
    const testTask = task()
    testTask.steps[0].retry = { maxAttempts: 1, backoffMs: 0, retryOn: ['failed'] }
    const recovery = recoveryDependencies([recoveryResult('retry')])
    const executor = new RpaTaskExecutor({ registry, runtime: runtime(), ...recovery })

    const result = await executor.run(testTask, 'device-1')

    expect(result.status).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(recovery.replan).toHaveBeenCalledTimes(1)
  })

  it('executes temporary recovery steps before retrying the original step', async () => {
    const registry = new RpaModuleRegistry()
    const originalExecute = vi
      .fn()
      .mockResolvedValueOnce({ success: false, status: 'failed', message: 'blocked', startedAt: 1, finishedAt: 2 })
      .mockResolvedValueOnce({ success: true, status: 'passed', message: 'recovered', startedAt: 5, finishedAt: 6 })
    const temporaryExecute = vi.fn().mockResolvedValue({
      success: true,
      status: 'passed',
      message: 'popup closed',
      startedAt: 3,
      finishedAt: 4
    })
    registry.register(moduleWithExecutor(originalExecute))
    registry.register({
      ...moduleWithExecutor(temporaryExecute),
      metadata: { ...moduleWithExecutor(temporaryExecute).metadata, id: 'temporary_module', name: 'Temporary' }
    })
    const testTask = task()
    testTask.steps[0].retry = { maxAttempts: 1, backoffMs: 0, retryOn: ['failed'] }
    const temporaryStep = {
      id: 'recovery-1',
      name: 'Close popup',
      moduleId: 'temporary_module',
      params: {},
      continueOnFailure: false
    }
    const recovery = recoveryDependencies([recoveryResult('corrected', [temporaryStep])])
    const executor = new RpaTaskExecutor({ registry, runtime: runtime(), ...recovery })

    const result = await executor.run(testTask, 'device-1')

    expect(result.status).toBe('completed')
    expect(temporaryExecute).toHaveBeenCalledTimes(1)
    expect(originalExecute).toHaveBeenCalledTimes(2)
  })

  it('requires human intervention after recovery attempts are exhausted', async () => {
    const registry = new RpaModuleRegistry()
    const execute = vi.fn().mockResolvedValue({
      success: false,
      status: 'failed',
      message: 'still blocked',
      startedAt: 1,
      finishedAt: 2
    })
    registry.register(moduleWithExecutor(execute))
    const testTask = task()
    testTask.steps[0].retry = { maxAttempts: 1, backoffMs: 0, retryOn: ['failed'] }
    const recovery = recoveryDependencies([recoveryResult('retry'), recoveryResult('retry')])
    const executor = new RpaTaskExecutor({ registry, runtime: runtime(), ...recovery, maxRecoveryAttempts: 2 })

    const result = await executor.run(testTask, 'device-1')

    expect(result.status).toBe('needs_human')
    expect(result.error).toContain('exhausted')
    expect(execute).toHaveBeenCalledTimes(3)
  })

  it('aborts an expired module so it cannot perform a delayed action', async () => {
    const registry = new RpaModuleRegistry()
    let receivedSignal: AbortSignal | undefined
    let delayedAction = false
    registry.register(
      moduleWithExecutor(async (context) => {
        receivedSignal = context.signal
        await new Promise((resolve) => setTimeout(resolve, 140))
        if (!context.signal?.aborted) delayedAction = true
        return { success: true, status: 'passed', message: 'late', startedAt: 1, finishedAt: 2 }
      })
    )
    const testTask = task()
    testTask.steps[0].timeoutMs = 100
    testTask.steps[0].retry = { maxAttempts: 1, backoffMs: 0, retryOn: ['timeout'] }
    const recovery = recoveryDependencies([recoveryResult('needs_human')])
    const executor = new RpaTaskExecutor({ registry, runtime: runtime(), ...recovery })

    const result = await executor.run(testTask, 'device-1')
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(result.status).toBe('needs_human')
    expect(receivedSignal?.aborted).toBe(true)
    expect(delayedAction).toBe(false)
  })
})
