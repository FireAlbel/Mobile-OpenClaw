import { describe, expect, it, vi } from 'vitest'

import { createDefaultRpaModuleRegistry } from '../RpaDefaultRegistry'
import type { RpaModelClient } from '../RpaModelClient'
import { RpaReplanService } from '../RpaReplanService'
import type { RpaFailureContext, RpaTask } from '../RpaTypes'

function modelClient(response: string): RpaModelClient {
  return {
    complete: vi.fn().mockResolvedValue(response)
  }
}

function task(): RpaTask {
  return {
    id: 'task-1',
    name: 'Task',
    goal: 'Goal',
    deviceIds: ['device-1'],
    metadata: {},
    steps: [
      {
        id: 'step-1',
        name: 'Tap',
        moduleId: 'tap_absolute',
        params: { x: 1, y: 2 },
        continueOnFailure: false
      }
    ]
  }
}

function failureContext(): RpaFailureContext {
  const testTask = task()
  return {
    task: testTask,
    deviceId: 'device-1',
    failedStep: testTask.steps[0],
    failedStepIndex: 0,
    result: {
      success: false,
      status: 'failed',
      message: 'tap failed',
      startedAt: 1,
      finishedAt: 2
    },
    verification: {
      status: 'failed',
      confidence: 1,
      message: 'verify failed'
    },
    events: [],
    reason: 'tap failed',
    occurredAt: 3
  }
}

describe('RpaReplanService', () => {
  it('returns validated correction steps', async () => {
    const service = new RpaReplanService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: modelClient(
        JSON.stringify({
          decision: 'insert_steps',
          reason: 'press back and retry',
          confidence: 0.9,
          steps: [
            {
              id: 'correction-1',
              name: 'Back',
              moduleId: 'press_back',
              params: {},
              continueOnFailure: false
            }
          ]
        })
      )
    })

    const result = await service.replan({ failureContext: failureContext(), correctionAttempt: 0 })

    expect(result.status).toBe('corrected')
    expect(result.steps[0].moduleId).toBe('press_back')
  })

  it('returns retry when no temporary action is needed', async () => {
    const service = new RpaReplanService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: modelClient(
        JSON.stringify({ decision: 'retry', reason: 'temporary loading state', confidence: 0.88, steps: [] })
      )
    })

    const result = await service.replan({ failureContext: failureContext(), correctionAttempt: 0 })

    expect(result.status).toBe('retry')
    expect(result.steps).toEqual([])
  })

  it('requires human intervention for a low-confidence decision', async () => {
    const service = new RpaReplanService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: modelClient(
        JSON.stringify({ decision: 'retry', reason: 'screen is ambiguous', confidence: 0.4, steps: [] })
      )
    })

    const result = await service.replan({ failureContext: failureContext(), correctionAttempt: 0 })

    expect(result.status).toBe('needs_human')
    expect(result.message).toContain('below 0.65')
  })

  it('returns needs_human when correction attempts are exhausted', async () => {
    const service = new RpaReplanService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: modelClient('{}')
    })

    const result = await service.replan({
      failureContext: failureContext(),
      correctionAttempt: 2,
      maxCorrectionAttempts: 2
    })

    expect(result.status).toBe('needs_human')
    expect(result.steps).toEqual([])
  })

  it('rejects correction steps with unknown modules', async () => {
    const service = new RpaReplanService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: modelClient(
        JSON.stringify({
          decision: 'insert_steps',
          reason: 'try an unknown action',
          confidence: 0.9,
          steps: [
            {
              id: 'bad',
              name: 'Bad',
              moduleId: 'unknown',
              params: {},
              continueOnFailure: false
            }
          ]
        })
      )
    })

    const result = await service.replan({ failureContext: failureContext(), correctionAttempt: 0 })

    expect(result.status).toBe('needs_human')
    expect(result.issues.some((issue) => issue.message.includes('Unknown module'))).toBe(true)
  })

  it('passes the selected model, screenshot and abort signal to the model client', async () => {
    const client = modelClient(
      JSON.stringify({ decision: 'needs_human', reason: 'manual review', confidence: 0.95, steps: [] })
    )
    const context = failureContext()
    context.task.visionModel = {
      id: 'vision-model',
      provider: 'test-provider',
      name: 'Vision Model',
      group: 'test'
    }
    const controller = new AbortController()
    const service = new RpaReplanService({ registry: createDefaultRpaModuleRegistry(), modelClient: client })

    await service.replan({
      failureContext: context,
      latestObservation: {
        deviceId: 'device-1',
        capturedAt: 4,
        screenshot: { imageBase64: 'png', mime: 'image/png' },
        warnings: [],
        artifacts: {}
      },
      correctionAttempt: 0,
      signal: controller.signal
    })

    expect(client.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        model: context.task.visionModel,
        signal: controller.signal,
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.arrayContaining([expect.objectContaining({ type: 'image', image: 'png' })])
          })
        ])
      })
    )
  })
})
