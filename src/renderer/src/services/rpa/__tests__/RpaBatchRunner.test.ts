import { describe, expect, it, vi } from 'vitest'

import { RpaBatchRunner } from '../RpaBatchRunner'
import type { RpaRunStorage } from '../RpaRunStorage'
import type { RpaRunResult, RpaRunStepEvent, RpaTask } from '../RpaTypes'

function task(deviceIds: string[] = ['device-1', 'device-2']): RpaTask {
  return {
    id: 'task-1',
    name: 'Task',
    goal: 'Run task',
    deviceIds,
    metadata: {},
    steps: [
      {
        id: 'step-1',
        name: 'Step',
        moduleId: 'wait',
        params: { durationMs: 1 },
        continueOnFailure: false
      }
    ]
  }
}

function result(deviceId: string, success = true): RpaRunResult {
  const event: RpaRunStepEvent = {
    taskId: 'task-1',
    deviceId,
    stepId: 'step-1',
    stepName: 'Step',
    status: success ? 'passed' : 'failed',
    attempt: 1,
    message: success ? 'ok' : 'failed',
    timestamp: 1
  }
  return {
    taskId: 'task-1',
    deviceId,
    success,
    status: success ? 'completed' : 'failed',
    events: [event],
    error: success ? undefined : 'failed',
    startedAt: 1,
    finishedAt: 2
  }
}

function needsHumanResult(deviceId: string): RpaRunResult {
  return {
    taskId: 'task-1',
    deviceId,
    success: false,
    status: 'needs_human',
    events: [
      {
        taskId: 'task-1',
        deviceId,
        stepId: 'step-1',
        stepName: 'Step',
        status: 'needs_human',
        attempt: 1,
        message: 'Manual handling required',
        timestamp: 1
      }
    ],
    error: 'Manual handling required',
    startedAt: 1,
    finishedAt: 2
  }
}

function storage(): RpaRunStorage {
  let runs: Awaited<ReturnType<RpaRunStorage['loadBatchRuns']>> = []
  return {
    loadBatchRuns: vi.fn(async () => runs),
    saveBatchRuns: vi.fn(async (nextRuns) => {
      runs = structuredClone(nextRuns)
    })
  }
}

describe('RpaBatchRunner', () => {
  it('fans out one task to multiple devices independently', async () => {
    const store = storage()
    const execute = vi.fn(async (_input: unknown, deviceId: string) => result(deviceId))
    const runner = new RpaBatchRunner({
      storage: store,
      executorFactory: () => ({ run: execute })
    })

    const run = await runner.start({ task: task() })
    await vi.waitFor(() => {
      expect(runner.getRuns()[0].status).toBe('completed')
    })

    expect(run.deviceRuns).toHaveLength(2)
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }), 'device-1')
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }), 'device-2')
    expect(runner.getRuns()[0].deviceRuns.map((deviceRun) => deviceRun.status)).toEqual(['completed', 'completed'])
  })

  it('isolates one device failure from other devices', async () => {
    const runner = new RpaBatchRunner({
      storage: storage(),
      executorFactory: () => ({
        run: vi.fn(async (_input: unknown, deviceId: string) => result(deviceId, deviceId !== 'device-2'))
      })
    })

    await runner.start({ task: task() })
    await vi.waitFor(() => {
      expect(runner.getRuns()[0].status).toBe('failed')
    })

    expect(runner.getRuns()[0].deviceRuns.map((deviceRun) => deviceRun.status)).toEqual(['completed', 'failed'])
  })

  it('cancels all pending device runs in a batch', async () => {
    const runner = new RpaBatchRunner({
      storage: storage(),
      executorFactory: () => ({
        run: vi.fn(() => new Promise<RpaRunResult>(() => undefined))
      })
    })

    const run = await runner.start({ task: task() })
    const cancelled = await runner.cancelBatchRun(run.id)

    expect(cancelled).toBe(true)
    expect(runner.getRuns()[0].status).toBe('cancelled')
    expect(runner.getRuns()[0].deviceRuns.every((deviceRun) => deviceRun.status === 'cancelled')).toBe(true)
  })

  it('retries a device run after human intervention', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce(needsHumanResult('device-1'))
      .mockResolvedValueOnce(result('device-1'))
    const runner = new RpaBatchRunner({
      storage: storage(),
      executorFactory: () => ({ run: execute })
    })

    const run = await runner.start({ task: task(['device-1']) })
    await vi.waitFor(() => {
      expect(runner.getRuns()[0].deviceRuns[0].status).toBe('needs_human')
    })

    const resumed = await runner.resumeDeviceRun(run.deviceRuns[0].id)
    expect(resumed).toBe(true)
    await vi.waitFor(() => {
      expect(runner.getRuns()[0].status).toBe('completed')
    })
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
