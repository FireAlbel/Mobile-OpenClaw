import { describe, expect, it, vi } from 'vitest'

import type { RpaModelClient } from '../RpaModelClient'
import type { RpaDeviceObservation, RpaFailureContext, RpaTask } from '../RpaTypes'
import { RpaVisualCorrectionService } from '../RpaVisualCorrectionService'

function modelClient(response: string): RpaModelClient {
  return {
    complete: vi.fn().mockResolvedValue(response)
  }
}

function observation(): RpaDeviceObservation {
  return {
    deviceId: 'device-1',
    capturedAt: 1,
    screenshot: { imageBase64: 'png', mime: 'image/png' },
    screenSize: { width: 1000, height: 2000 },
    warnings: [],
    artifacts: {}
  }
}

function failureContext(): RpaFailureContext {
  const task: RpaTask = {
    id: 'task-1',
    name: 'Task',
    goal: 'Open target page',
    deviceIds: ['device-1'],
    metadata: {},
    steps: [{ id: 'step-1', name: 'Tap', moduleId: 'tap_absolute', params: { x: 1, y: 2 }, continueOnFailure: false }]
  }
  return {
    task,
    deviceId: 'device-1',
    failedStep: task.steps[0],
    failedStepIndex: 0,
    result: { success: false, status: 'failed', message: 'failed', startedAt: 1, finishedAt: 2 },
    verification: { status: 'failed', confidence: 1, message: 'not visible' },
    events: [],
    reason: 'not visible',
    occurredAt: 3
  }
}

describe('RpaVisualCorrectionService', () => {
  it('returns bbox center for confident visual target', async () => {
    const service = new RpaVisualCorrectionService({
      modelClient: modelClient(
        JSON.stringify({
          found: true,
          action: 'tap',
          bbox: { x: 10, y: 20, width: 100, height: 80 },
          confidence: 0.9,
          reason: 'target visible'
        })
      )
    })

    const result = await service.locate({ deviceId: 'device-1', target: 'coin', observation: observation() })

    expect(result.status).toBe('found')
    expect(result.point).toEqual({ x: 60, y: 60 })
  })

  it('marks low confidence responses as low_confidence', async () => {
    const service = new RpaVisualCorrectionService({
      modelClient: modelClient(
        JSON.stringify({
          found: true,
          action: 'tap',
          bbox: { x: 10, y: 20, width: 100, height: 80 },
          confidence: 0.2
        })
      )
    })

    const result = await service.locate({
      deviceId: 'device-1',
      target: 'coin',
      observation: observation(),
      minConfidence: 0.8
    })

    expect(result.status).toBe('low_confidence')
  })

  it('rejects invalid structured responses', async () => {
    const service = new RpaVisualCorrectionService({
      modelClient: modelClient(JSON.stringify({ found: true, confidence: 2 }))
    })

    const result = await service.locate({ deviceId: 'device-1', target: 'coin', observation: observation() })

    expect(result.status).toBe('invalid')
  })

  it('returns a validated executable recovery action', async () => {
    const service = new RpaVisualCorrectionService({
      modelClient: modelClient(
        JSON.stringify({
          decision: 'execute_actions',
          reason: 'Dismiss the visible popup',
          confidence: 0.95,
          expectedOutcome: 'The popup is no longer visible',
          actions: [{ id: 'dismiss', type: 'tap', x: 900, y: 120 }]
        })
      )
    })

    const result = await service.decideRecovery({
      failureContext: failureContext(),
      observation: observation(),
      correctionRound: 1
    })

    expect(result.status).toBe('valid')
    expect(result.decision).toMatchObject({ decision: 'execute_actions' })
  })

  it('rejects descriptive text as a correction result', async () => {
    const service = new RpaVisualCorrectionService({
      modelClient: modelClient('The popup is blocking the target, so it should be closed.')
    })

    const result = await service.decideRecovery({
      failureContext: failureContext(),
      observation: observation(),
      correctionRound: 1
    })

    expect(result.status).toBe('invalid')
    expect(result.message).toContain('not valid JSON')
  })
})
