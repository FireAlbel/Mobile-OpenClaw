import { describe, expect, it } from 'vitest'

import { RpaReplayService } from '../RpaReplayService'
import type { RpaBatchRunRecord } from '../RpaRunStorage'

function createRun(): RpaBatchRunRecord {
  return {
    id: 'run-1',
    task: {
      id: 'task-1',
      name: 'Replay task',
      goal: 'Test replay',
      deviceIds: ['device-1'],
      steps: [{ id: 'step-1', name: 'Step', moduleId: 'wait', params: {}, continueOnFailure: false }],
      metadata: {}
    },
    deviceIds: ['device-1'],
    status: 'completed',
    createdAt: 1,
    updatedAt: 3,
    contextSnapshot: {
      schemaVersion: 1,
      createdAt: 1,
      topicId: 'topic-1',
      assistantId: 'assistant-1',
      assistantProfileVersion: 7,
      models: {
        planner: { providerId: 'provider-1', modelId: 'model-1' },
        vision: { providerId: 'provider-1', modelId: 'model-1' },
        verification: { providerId: 'provider-1', modelId: 'model-1' },
        recovery: { providerId: 'provider-1', modelId: 'model-1' }
      },
      skills: [],
      knowledge: [],
      appPackages: [],
      resolutionWarnings: []
    },
    deviceRuns: [
      {
        id: 'device-run-1',
        batchRunId: 'run-1',
        taskId: 'task-1',
        deviceId: 'device-1',
        status: 'completed',
        createdAt: 1,
        updatedAt: 3,
        events: [
          {
            taskId: 'task-1',
            deviceId: 'device-1',
            stepId: 'step-1',
            stepName: 'Later',
            status: 'passed',
            attempt: 1,
            message: 'done',
            timestamp: 3,
            phase: 'correction_verification'
          },
          {
            taskId: 'task-1',
            deviceId: 'device-1',
            stepId: 'step-1',
            stepName: 'Earlier',
            status: 'running',
            attempt: 1,
            message: 'observing',
            timestamp: 2,
            phase: 'correction_observation',
            data: {
              observation: { screenshot: { imageBase64: 'YWJj', mime: 'image/png', source: 'scrcpy' } },
              rawResponse: '{"decision":"execute_actions"}'
            }
          }
        ]
      }
    ]
  }
}

describe('RpaReplayService', () => {
  it('orders events and exposes replay evidence', () => {
    const replay = new RpaReplayService().load(createRun())

    expect(replay.frames.map((frame) => frame.timestamp)).toEqual([2, 3])
    expect(replay.frames[0].screenshot?.source).toBe('scrcpy')
    expect(replay.frames[0].modelOutput).toContain('execute_actions')
    expect(replay.phases).toEqual(['correction_observation', 'correction_verification'])
  })

  it('marks events without screenshot evidence as missing', () => {
    const replay = new RpaReplayService().load(createRun())

    expect(replay.frames[1].artifactStatus).toBe('missing')
    expect(replay.missingArtifactCount).toBe(1)
  })

  it('uses the historical context snapshot without resolving current assistant assets', () => {
    const replay = new RpaReplayService().load(createRun())

    expect(replay.contextSnapshot).toMatchObject({ assistantId: 'assistant-1', assistantProfileVersion: 7 })
  })

  it('preserves deterministic recovery phases in replay', () => {
    const run = createRun()
    run.deviceRuns[0].events[0].phase = 'deterministic_recovery_verification'

    const replay = new RpaReplayService().load(run)

    expect(replay.phases).toContain('deterministic_recovery_verification')
  })

  it('ignores a corrupt historical context snapshot', () => {
    const run = createRun()
    Object.assign(run, { contextSnapshot: { schemaVersion: 1, privatePrompt: 'invalid' } })

    expect(new RpaReplayService().load(run).contextSnapshot).toBeUndefined()
  })
})
