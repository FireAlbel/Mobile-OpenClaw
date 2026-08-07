import { describe, expect, it, vi } from 'vitest'

import { createDefaultRpaModuleRegistry } from '../RpaDefaultRegistry'
import type { RpaModelClient } from '../RpaModelClient'
import { buildRpaModelContext, createEmbeddedRpaModelContext } from '../RpaModelContextBuilder'
import { RpaReplanService } from '../RpaReplanService'
import type { RpaCorrectionDecision, RpaFailureContext, RpaTask } from '../RpaTypes'

function modelClient(response: string): RpaModelClient {
  return { complete: vi.fn().mockResolvedValue(response) }
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
    result: { success: false, status: 'failed', message: 'tap failed', startedAt: 1, finishedAt: 2 },
    verification: { status: 'failed', confidence: 1, message: 'verify failed' },
    events: [],
    reason: 'tap failed',
    occurredAt: 3
  }
}

function executeActionsDecision(): RpaCorrectionDecision {
  return {
    decision: 'execute_actions',
    reason: 'close the popup',
    confidence: 0.95,
    expectedOutcome: 'The popup is closed',
    actions: [{ id: 'tap-close', type: 'tap', x: 100, y: 200 }]
  }
}

describe('RpaReplanService', () => {
  it('materializes whitelisted actions as temporary RPA nodes', async () => {
    const service = new RpaReplanService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: modelClient('{}')
    })

    const result = await service.replan({
      failureContext: failureContext(),
      decision: executeActionsDecision(),
      correctionRound: 1
    })

    expect(result.status).toBe('actions')
    expect(result.actions[0]).toMatchObject({ type: 'tap', x: 100, y: 200 })
    expect(result.steps[0]).toMatchObject({ moduleId: '__correction_action__', params: { type: 'tap' } })
  })

  it('generates and validates temporary module steps for a replan decision', async () => {
    const client = modelClient(
      JSON.stringify({
        expectedOutcome: 'The popup is gone',
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
    const service = new RpaReplanService({ registry: createDefaultRpaModuleRegistry(), modelClient: client })
    const decision: RpaCorrectionDecision = {
      decision: 'replan',
      reason: 'a temporary workflow is required',
      confidence: 0.9,
      objective: 'Close the blocking popup'
    }

    const result = await service.replan({
      failureContext: failureContext(),
      decision,
      correctionRound: 1
    })

    expect(result.status).toBe('steps')
    expect(result.steps[0].moduleId).toBe('press_back')
    expect(result.expectedOutcome).toBe('The popup is gone')
  })

  it('uses recovery prompts and bounded knowledge when generating temporary steps', async () => {
    const client = modelClient(
      JSON.stringify({
        expectedOutcome: 'Recovered',
        steps: [{ id: 'back', name: 'Back', moduleId: 'press_back', params: {}, continueOnFailure: false }]
      })
    )
    const service = new RpaReplanService({ registry: createDefaultRpaModuleRegistry(), modelClient: client })
    const result = await service.replan({
      failureContext: failureContext(),
      decision: {
        decision: 'replan',
        reason: 'recover',
        confidence: 0.9,
        objective: 'Recover the expected page'
      },
      correctionRound: 1,
      modelContext: createEmbeddedRpaModelContext(
        buildRpaModelContext({
          callType: 'planner',
          rolePrompts: [
            {
              schemaVersion: 1,
              id: 'recovery',
              roleId: 'role-1',
              version: '1',
              kind: 'recovery',
              content: 'Use the deterministic recovery route first.',
              priority: 1,
              status: 'enabled',
              createdAt: 1,
              updatedAt: 1
            },
            {
              schemaVersion: 1,
              id: 'verification',
              roleId: 'role-1',
              version: '1',
              kind: 'verification',
              content: 'Verification-only instruction.',
              priority: 1,
              status: 'enabled',
              createdAt: 1,
              updatedAt: 1
            }
          ]
        })
      ),
      knowledgeContext: {
        summaries: [
          {
            id: 'knowledge-1',
            category: 'recovery_guidance',
            title: 'Popup recovery',
            summary: 'Press Back once when the popup blocks navigation.',
            confidence: 0.9,
            knowledgeBaseId: 'kb-1',
            templateIds: [],
            skills: []
          }
        ],
        conflicts: [],
        warnings: []
      }
    })

    const request = vi.mocked(client.complete).mock.calls[0][0]
    const messages = JSON.stringify(request.messages)
    expect(messages).toContain('Use the deterministic recovery route first.')
    expect(messages).toContain('Press Back once when the popup blocks navigation.')
    expect(messages).not.toContain('Verification-only instruction.')
    expect(result.contextProvenance?.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceType: 'role_prompt', sourceId: 'recovery', version: '1' }),
        expect.objectContaining({ sourceType: 'local_knowledge', sourceId: 'knowledge-1' })
      ])
    )
  })

  it.each([
    {
      decision: {
        decision: 'human_required',
        reason: 'CAPTCHA requires a person',
        confidence: 0.99,
        interventionCode: 'captcha'
      } as RpaCorrectionDecision,
      status: 'human_required'
    },
    {
      decision: {
        decision: 'goal_achieved',
        reason: 'The goal is already visible',
        confidence: 0.98,
        evidence: 'Success page is visible'
      } as RpaCorrectionDecision,
      status: 'goal_achieved'
    }
  ])('preserves the $status decision without asking the model for prose', async ({ decision, status }) => {
    const client = modelClient('{}')
    const service = new RpaReplanService({ registry: createDefaultRpaModuleRegistry(), modelClient: client })

    const result = await service.replan({ failureContext: failureContext(), decision, correctionRound: 1 })

    expect(result.status).toBe(status)
    expect(client.complete).not.toHaveBeenCalled()
  })

  it('rejects replanned steps with unknown modules', async () => {
    const service = new RpaReplanService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: modelClient(
        JSON.stringify({
          expectedOutcome: 'Recovered',
          steps: [{ id: 'bad', name: 'Bad', moduleId: 'unknown', params: {}, continueOnFailure: false }]
        })
      )
    })
    const decision: RpaCorrectionDecision = {
      decision: 'replan',
      reason: 'need modules',
      confidence: 0.9,
      objective: 'Recover'
    }

    const result = await service.replan({ failureContext: failureContext(), decision, correctionRound: 1 })

    expect(result.status).toBe('human_required')
    expect(result.issues.some((issue) => issue.message.includes('Unknown module'))).toBe(true)
  })
})
