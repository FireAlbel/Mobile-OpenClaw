import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RpaBatchRunRecord, RpaRunStorage } from '../RpaRunStorage'
import { IpcRpaRunStorage } from '../RpaRunStorage'

function run(status: RpaBatchRunRecord['status'] = 'completed'): RpaBatchRunRecord {
  return {
    id: 'batch-1',
    task: {
      id: 'task-1',
      name: 'Task',
      goal: 'Goal',
      deviceIds: ['device-1'],
      steps: [{ id: 'step-1', name: 'Step', moduleId: 'wait', params: {}, continueOnFailure: false }],
      metadata: {}
    },
    deviceIds: ['device-1'],
    status,
    createdAt: 1,
    updatedAt: 1,
    deviceRuns: [
      {
        id: 'device-run-1',
        batchRunId: 'batch-1',
        taskId: 'task-1',
        deviceId: 'device-1',
        status: status === 'running' ? 'running' : 'completed',
        events: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
}

function fallback(): RpaRunStorage {
  return {
    loadBatchRuns: vi.fn(async () => [run('completed')]),
    saveBatchRuns: vi.fn(async () => undefined)
  }
}

describe('IpcRpaRunStorage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads runs from main process storage', async () => {
    vi.stubGlobal('window', {
      api: {
        rpa: {
          loadRuns: vi.fn(async () => [run('completed')]),
          saveRuns: vi.fn()
        }
      }
    })
    const storage = new IpcRpaRunStorage(fallback())

    await expect(storage.loadBatchRuns()).resolves.toHaveLength(1)
  })

  it('normalizes interrupted running records to paused', async () => {
    vi.stubGlobal('window', {
      api: {
        rpa: {
          loadRuns: vi.fn(async () => [run('running')]),
          saveRuns: vi.fn()
        }
      }
    })
    const storage = new IpcRpaRunStorage(fallback())

    const runs = await storage.loadBatchRuns()

    expect(runs[0].status).toBe('paused')
    expect(runs[0].deviceRuns[0].status).toBe('paused')
  })

  it('falls back when IPC is unavailable', async () => {
    vi.stubGlobal('window', { api: {} })
    const backup = fallback()
    const storage = new IpcRpaRunStorage(backup)

    await storage.saveBatchRuns([run('completed')])

    expect(backup.saveBatchRuns).toHaveBeenCalled()
  })
})
