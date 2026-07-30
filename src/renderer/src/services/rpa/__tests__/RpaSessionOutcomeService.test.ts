import { describe, expect, it, vi } from 'vitest'

import type { RpaDslSession } from '../RpaDslSession'
import type { RpaBatchRunRecord } from '../RpaRunStorage'
import { RpaSessionOutcomeService } from '../RpaSessionOutcomeService'

function session(overrides: Partial<RpaDslSession> = {}): RpaDslSession {
  return {
    schemaVersion: 1,
    id: 'session-1',
    version: 1,
    primaryRole: { id: 'role-1', version: 1 },
    supportingRoles: [],
    goal: 'Open settings',
    attachments: [],
    observations: [],
    clarifications: [],
    revisions: [
      {
        version: 1,
        dsl: {
          id: 'task-1',
          name: 'Open settings',
          goal: 'Open settings',
          deviceIds: [],
          steps: [{ id: 'step-1', name: 'Launch settings', moduleId: 'launch_app', params: {} }],
          metadata: {}
        },
        validationIssues: [],
        executable: true,
        roleContext: {
          primaryRole: { id: 'role-1', version: 1 },
          supportingRoles: [],
          systemCapabilities: []
        },
        createdAt: 1,
        source: 'generated'
      }
    ],
    activeRevisionVersion: 1,
    status: 'executing',
    interactionState: 'executing',
    interactionEvents: [],
    runIds: ['run-1'],
    templateIds: [],
    replayRunIds: [],
    improvementIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function run(status: RpaBatchRunRecord['status'] = 'running'): RpaBatchRunRecord {
  return {
    id: 'run-1',
    task: {
      id: 'task-1',
      name: 'Open settings',
      goal: 'Open settings',
      deviceIds: ['device-1'],
      steps: [],
      metadata: {}
    },
    deviceIds: ['device-1'],
    status,
    deviceRuns: [
      {
        id: 'device-run-1',
        batchRunId: 'run-1',
        taskId: 'task-1',
        deviceId: 'device-1',
        status: status === 'paused' ? 'paused' : status === 'failed' ? 'failed' : 'running',
        events: [],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    createdAt: 1,
    updatedAt: 1
  }
}

describe('RpaSessionOutcomeService', () => {
  it('explains persisted DSL without mutating the session revision', async () => {
    const activeSession = session()
    const service = new RpaSessionOutcomeService({
      initialize: vi.fn(),
      getRuns: () => [run()],
      pauseDeviceRun: vi.fn(),
      resumeDeviceRun: vi.fn(),
      cancelBatchRun: vi.fn(),
      retryBatchRun: vi.fn()
    })

    const result = await service.explain(activeSession)

    expect(result).toMatchObject({ kind: 'explanation', success: true, stateAfter: 'executing' })
    expect(result.message).toContain('Launch settings')
    expect(activeSession.revisions).toHaveLength(1)
  })

  it('pauses only device runs linked to the current session run', async () => {
    const pauseDeviceRun = vi.fn().mockResolvedValue(true)
    const service = new RpaSessionOutcomeService({
      initialize: vi.fn().mockResolvedValue(undefined),
      getRuns: () => [run(), { ...run(), id: 'unrelated-run' }],
      pauseDeviceRun,
      resumeDeviceRun: vi.fn(),
      cancelBatchRun: vi.fn(),
      retryBatchRun: vi.fn()
    })

    const result = await service.control(session(), 'pause')

    expect(result).toMatchObject({ kind: 'run_control', success: true, runId: 'run-1', stateAfter: 'paused' })
    expect(pauseDeviceRun).toHaveBeenCalledTimes(1)
    expect(pauseDeviceRun).toHaveBeenCalledWith('device-run-1')
  })

  it('rejects run control when the session has no linked run', async () => {
    const service = new RpaSessionOutcomeService({
      initialize: vi.fn().mockResolvedValue(undefined),
      getRuns: () => [run()],
      pauseDeviceRun: vi.fn(),
      resumeDeviceRun: vi.fn(),
      cancelBatchRun: vi.fn(),
      retryBatchRun: vi.fn()
    })

    await expect(service.control(session({ runIds: [] }), 'pause')).resolves.toMatchObject({
      kind: 'non_executable',
      success: false
    })
  })
})
