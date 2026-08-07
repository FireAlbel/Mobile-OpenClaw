import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RpaBatchRunRecord, RpaRunStorage } from '../RpaRunStorage'
import { IpcRpaRunStorage, sanitizeRpaBatchRunsForStorage } from '../RpaRunStorage'

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

  it('omits raw observation payloads while preserving evidence references', () => {
    const record = run('failed')
    record.deviceRuns[0].events.push({
      taskId: 'task-1',
      deviceId: 'device-1',
      stepId: 'step-1',
      stepName: 'Observe',
      status: 'failed',
      attempt: 1,
      message: 'Verification failed',
      timestamp: 2,
      data: {
        observation: {
          screenshot: { imageBase64: 'a'.repeat(2_000_000), mime: 'image/png', width: 1080, height: 2400 },
          uiTree: {
            xml: '<node />'.repeat(100_000),
            nodes: Array.from({ length: 1_000 }, (_, index) => ({ text: `Node ${index}` })),
            texts: Array.from({ length: 1_000 }, (_, index) => `Text ${index}`)
          },
          ocr: { blocks: Array.from({ length: 1_000 }, (_, index) => ({ text: `OCR ${index}` })) },
          textCandidates: Array.from({ length: 1_000 }, (_, index) => ({ text: `Candidate ${index}` })),
          artifacts: { screenshotArtifactId: 'artifact-shot-1', uiTreeArtifactId: 'artifact-tree-1' }
        },
        recognizedState: { stateId: 'UNKNOWN', artifactId: 'artifact-state-1' }
      }
    })

    const sanitized = sanitizeRpaBatchRunsForStorage([record])
    const json = JSON.stringify(sanitized)

    expect(json).not.toContain('a'.repeat(1_000))
    expect(json).not.toContain('<node />'.repeat(100))
    expect(json).toContain('[BINARY_OMITTED:2000000]')
    expect(json).toContain('[TEXT_OMITTED:UI_TREE_XML:800000]')
    expect(json).toContain('[UI_TREE_NODES_OMITTED:1000]')
    expect(json).toContain('[UI_TREE_TEXTS_OMITTED:1000]')
    expect(json).toContain('[OCR_BLOCKS_OMITTED:1000]')
    expect(json).toContain('[TEXT_CANDIDATES_OMITTED:1000]')
    expect(json).toContain('artifact-shot-1')
    expect(json).toContain('artifact-tree-1')
    expect(json).toContain('artifact-state-1')
    expect(json.length).toBeLessThan(100_000)
  })
})
