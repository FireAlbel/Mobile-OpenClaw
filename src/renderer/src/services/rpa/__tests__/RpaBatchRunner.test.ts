import { describe, expect, it, vi } from 'vitest'

import { RpaBatchRunner } from '../RpaBatchRunner'
import type { RpaExecutionTargetSelection } from '../RpaExecutionTarget'
import type { RpaRunContextSnapshot } from '../RpaRunContextSnapshot'
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

function contextSnapshot(): RpaRunContextSnapshot {
  const model = { providerId: 'provider-1', modelId: 'model-1' }
  return {
    schemaVersion: 1,
    createdAt: 1,
    topicId: 'topic-1',
    assistantId: 'assistant-1',
    assistantProfileVersion: 3,
    models: { planner: model, vision: model, verification: model, recovery: model },
    skills: [{ id: 'skill-1', version: '1' }],
    knowledge: [{ id: 'kb-1', version: '2' }],
    appPackages: [],
    resolutionWarnings: []
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
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }), 'device-1', expect.any(AbortSignal))
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1' }), 'device-2', expect.any(AbortSignal))
    expect(runner.getRuns()[0].deviceRuns.map((deviceRun) => deviceRun.status)).toEqual(['completed', 'completed'])
  })

  it('persists trace learning after a terminal device result', async () => {
    const analyzeDeviceRun = vi.fn(async (runRecord, deviceRunId) => ({
      runId: runRecord.id,
      deviceRunId,
      summary: 'Completed trace',
      confidence: 0.9,
      stateIds: ['HOME'],
      transitions: [],
      locatorHints: [],
      assertionHints: ['done'],
      evidenceArtifactIds: [],
      improvementProposalIds: [],
      redactions: [],
      analyzedAt: 3
    }))
    const runner = new RpaBatchRunner({
      storage: storage(),
      executorFactory: () => ({ run: vi.fn(async (_input: unknown, deviceId: string) => result(deviceId)) }),
      traceLearningService: { analyzeDeviceRun }
    })

    await runner.start({ task: task(['device-1']) })
    await vi.waitFor(() => expect(runner.getRuns()[0].deviceRuns[0].traceAnalysis).toBeDefined())

    expect(analyzeDeviceRun).toHaveBeenCalledOnce()
    expect(runner.getRuns()[0].deviceRuns[0].traceAnalysis).toMatchObject({ summary: 'Completed trace' })
  })

  it('stores an immutable snapshot of execution target metadata', async () => {
    const targetSelection: RpaExecutionTargetSelection = {
      mode: 'groups',
      groupIds: ['group-a'],
      includedDeviceIds: [],
      excludedDeviceIds: ['device-2'],
      deviceIds: ['device-1'],
      unavailableDeviceIds: ['device-3'],
      partialGroupIds: ['group-a'],
      emptyGroupIds: [],
      scannedAt: 123
    }
    const runner = new RpaBatchRunner({
      storage: storage(),
      executorFactory: () => ({ run: vi.fn(async (_input: unknown, deviceId: string) => result(deviceId)) })
    })

    await runner.start({ task: task([]), deviceIds: ['device-1'], targetSelection })
    targetSelection.groupIds.push('mutated')
    targetSelection.deviceIds.push('mutated')

    const storedSelection = runner.getRuns()[0].targetSelection
    expect(storedSelection).toMatchObject({
      mode: 'groups',
      groupIds: ['group-a'],
      deviceIds: ['device-1'],
      unavailableDeviceIds: ['device-3'],
      scannedAt: 123
    })
  })

  it('persists an immutable context snapshot before device execution', async () => {
    const store = storage()
    const execute = vi.fn(async (_input: unknown, deviceId: string) => result(deviceId))
    const runner = new RpaBatchRunner({ storage: store, executorFactory: () => ({ run: execute }) })
    const snapshot = contextSnapshot()

    await runner.start({ task: task([]), deviceIds: ['device-1'], contextSnapshot: snapshot })
    snapshot.skills.push({ id: 'mutated' })

    expect(runner.getRuns()[0].contextSnapshot).toMatchObject({
      assistantProfileVersion: 3,
      skills: [{ id: 'skill-1', version: '1' }]
    })
    expect(store.saveBatchRuns).toHaveBeenCalled()
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

  it('starts an independent retry run for a failed batch', async () => {
    const execute = vi.fn().mockResolvedValueOnce(result('device-1', false)).mockResolvedValueOnce(result('device-1'))
    const runner = new RpaBatchRunner({
      storage: storage(),
      executorFactory: () => ({ run: execute })
    })
    const original = await runner.start({ task: task(['device-1']) })
    await vi.waitFor(() => expect(runner.getRuns().find((run) => run.id === original.id)?.status).toBe('failed'))

    const retry = await runner.retryBatchRun(original.id)

    expect(retry?.id).not.toBe(original.id)
    await vi.waitFor(() => expect(runner.getRuns().find((run) => run.id === retry?.id)?.status).toBe('completed'))
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

  it('publishes a new run snapshot for every real-time step event', async () => {
    let emitEvent: ((event: RpaRunStepEvent) => void) | undefined
    const runner = new RpaBatchRunner({
      storage: storage(),
      executorFactory: (onEvent) => {
        emitEvent = onEvent
        return { run: vi.fn(() => new Promise<RpaRunResult>(() => undefined)) }
      }
    })

    await runner.start({ task: task(['device-1']) })
    await vi.waitFor(() => expect(runner.getRuns()[0].status).toBe('running'))
    await vi.waitFor(() => expect(emitEvent).toBeTypeOf('function'))
    const before = runner.getRuns()[0]
    const listener = vi.fn()
    runner.subscribe(listener)

    emitEvent?.({
      taskId: 'task-1',
      deviceId: 'device-1',
      stepId: 'step-1',
      stepName: 'Step',
      status: 'running',
      attempt: 1,
      message: 'Running wait',
      timestamp: 3
    })

    expect(listener).toHaveBeenCalled()
    const after = runner.getRuns()[0]
    expect(after).not.toBe(before)
    expect(after.deviceRuns[0]).not.toBe(before.deviceRuns[0])
    expect(after.deviceRuns[0].events).toHaveLength(1)
    expect(after.deviceRuns[0].events[0].status).toBe('running')
  })

  it('aborts every active device during an emergency stop', async () => {
    const signals: AbortSignal[] = []
    const runner = new RpaBatchRunner({
      storage: storage(),
      executorFactory: () => ({
        run: vi.fn((_input, _deviceId, signal) => {
          if (signal) signals.push(signal)
          return new Promise<RpaRunResult>(() => undefined)
        })
      })
    })
    await runner.start({ task: task() })
    await vi.waitFor(() => expect(signals).toHaveLength(2))

    const cancelled = await runner.emergencyStop()

    expect(cancelled).toBe(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(runner.getRuns()[0].status).toBe('cancelled')
    expect(runner.getRuns()[0].deviceRuns.every((deviceRun) => deviceRun.status === 'cancelled')).toBe(true)
  })

  it('pauses only an active device when it goes offline and allows it to continue after reconnecting', async () => {
    let devices = [{ id: 'device-1', name: 'Pixel', status: 'online' as const }]
    const signals: AbortSignal[] = []
    const execute = vi
      .fn()
      .mockImplementationOnce((_input, _deviceId, signal?: AbortSignal) => {
        if (signal) signals.push(signal)
        return new Promise<RpaRunResult>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason))
        })
      })
      .mockResolvedValueOnce(result('device-1'))
    const runner = new RpaBatchRunner({
      storage: storage(),
      executorFactory: () => ({ run: execute }),
      deviceScanner: vi.fn(async () => devices),
      deviceMonitorIntervalMs: 60_000
    })

    const run = await runner.start({ task: task(['device-1']) })
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    expect(runner.getDetectedDevices()).toEqual([expect.objectContaining({ id: 'device-1', name: 'Pixel' })])

    devices = []
    await runner.refreshDeviceStatuses()

    await vi.waitFor(() => expect(runner.getRuns()[0].deviceRuns[0].status).toBe('paused'))
    expect(signals[0].aborted).toBe(true)
    expect(runner.getRuns()[0].deviceRuns[0].error).toContain('Device offline')

    devices = [{ id: 'device-1', name: 'Pixel', status: 'online' }]
    await runner.refreshDeviceStatuses()
    expect(await runner.resumeDeviceRun(run.deviceRuns[0].id)).toBe(true)
    await vi.waitFor(() => expect(runner.getRuns()[0].status).toBe('completed'))
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
