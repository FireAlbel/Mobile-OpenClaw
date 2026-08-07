import { describe, expect, it, vi } from 'vitest'

import type { RpaModelClient } from '../RpaModelClient'
import { buildRpaModelContext, createEmbeddedRpaModelContext } from '../RpaModelContextBuilder'
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
  it('includes bounded normalization attempts in VLM recovery context', async () => {
    const client = modelClient(
      JSON.stringify({ decision: 'human_required', reason: 'No safe action remains', confidence: 0.95 })
    )
    const context = failureContext()
    context.result.data = {
      outcome: 'replan',
      packageName: 'com.example.app',
      targetState: 'HOME',
      playbookId: 'com.example.app',
      playbookVersion: 2,
      actionGroups: [
        {
          stage: 'bounded_back',
          attempt: 1,
          actions: [{ type: 'key', detail: 'back' }],
          success: true,
          message: 'Back completed',
          verification: { status: 'failed', confidence: 0.9, message: 'Still on detail' }
        }
      ]
    }
    const service = new RpaVisualCorrectionService({ modelClient: client })

    await service.decideRecovery({
      failureContext: context,
      observation: observation(),
      correctionRound: 1
    })

    const prompt = JSON.stringify(vi.mocked(client.complete).mock.calls)
    expect(prompt).toContain('attemptedStages')
    expect(prompt).toContain('bounded_back')
    expect(prompt).toContain('com.example.app')
  })

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
    const client = modelClient(
      JSON.stringify({
        decision: 'execute_actions',
        reason: 'Dismiss the visible popup',
        confidence: 0.95,
        expectedOutcome: 'The popup is no longer visible',
        actions: [{ id: 'dismiss', type: 'tap', x: 900, y: 120 }]
      })
    )
    const service = new RpaVisualCorrectionService({ modelClient: client })
    const currentObservation = observation()
    currentObservation.recognizedState = {
      stateId: 'BLOCKED_BY_POPUP',
      label: 'Blocked by popup',
      confidence: 0.91,
      blocking: true,
      blockingCondition: 'popup',
      recoveryScope: 'dismiss_overlay',
      suggestedTransitions: ['HOME'],
      evidence: [],
      reason: 'Popup text detected',
      recognizedAt: 2
    }

    const result = await service.decideRecovery({
      failureContext: failureContext(),
      observation: currentObservation,
      correctionRound: 1,
      modelContext: createEmbeddedRpaModelContext(
        buildRpaModelContext({
          callType: 'planner',
          rolePrompts: [
            {
              schemaVersion: 1,
              id: 'recovery-prompt',
              roleId: 'role-1',
              version: '1',
              kind: 'recovery',
              content: 'Dismiss known app overlays before replanning.',
              priority: 1,
              status: 'enabled',
              createdAt: 1,
              updatedAt: 1
            },
            {
              schemaVersion: 1,
              id: 'planner-prompt',
              roleId: 'role-1',
              version: '1',
              kind: 'planner',
              content: 'Planner-only guidance.',
              priority: 0,
              status: 'enabled',
              createdAt: 1,
              updatedAt: 1
            }
          ]
        })
      )
    })

    expect(result.status).toBe('valid')
    expect(result.decision).toMatchObject({ decision: 'execute_actions' })
    expect(result.contextProvenance?.callType).toBe('recovery')
    const messages = JSON.stringify(vi.mocked(client.complete).mock.calls)
    expect(messages).toContain('Dismiss known app overlays before replanning.')
    expect(messages).not.toContain('Planner-only guidance.')
    expect(JSON.stringify(vi.mocked(client.complete).mock.calls[0][0].messages)).toContain('BLOCKED_BY_POPUP')
  })

  it('rejects descriptive text as a correction result', async () => {
    const client = modelClient('The popup is blocking the target, so it should be closed.')
    const service = new RpaVisualCorrectionService({ modelClient: client })

    const result = await service.decideRecovery({
      failureContext: failureContext(),
      observation: observation(),
      correctionRound: 1
    })

    expect(result.status).toBe('invalid')
    expect(result.message).toContain('not valid JSON')
    expect(client.complete).toHaveBeenCalledTimes(2)
    expect(result.repaired).toBe(true)
  })

  it('repairs an invalid recovery response into a validated executable decision', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ decision: 'execute_actions', actions: [{ type: 'tap', x: 9, y: 8 }] }))
      .mockResolvedValueOnce(
        JSON.stringify({
          decision: 'execute_actions',
          reason: 'Dismiss the visible popup',
          confidence: 0.94,
          expectedOutcome: 'The popup is no longer visible',
          actions: [{ id: 'dismiss-popup', type: 'tap', x: 900, y: 120 }]
        })
      )
    const service = new RpaVisualCorrectionService({ modelClient: { complete } })

    const result = await service.decideRecovery({
      failureContext: failureContext(),
      observation: observation(),
      correctionRound: 1
    })

    expect(result.status).toBe('valid')
    expect(result.repaired).toBe(true)
    expect(result.originalRawResponse).toContain('execute_actions')
    expect(result.decision).toMatchObject({
      decision: 'execute_actions',
      actions: [{ id: 'dismiss-popup', type: 'tap' }]
    })
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('normalizes an unambiguous missing action type without another model call', async () => {
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        decision: 'execute_actions',
        reason: 'The foreground app is not Settings, so open Settings directly',
        confidence: 0.95,
        expectedOutcome: 'Settings is the foreground app',
        actions: [{ id: 'start-settings', packageName: 'com.android.settings' }]
      })
    )
    const service = new RpaVisualCorrectionService({ modelClient: { complete } })

    const result = await service.decideRecovery({
      failureContext: failureContext(),
      observation: observation(),
      correctionRound: 1
    })

    expect(result.status).toBe('valid')
    expect(result.repaired).toBe(false)
    expect(result.decision).toMatchObject({
      decision: 'execute_actions',
      actions: [{ id: 'start-settings', type: 'start_app', packageName: 'com.android.settings' }]
    })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('inherits missing repair envelope fields from the original decision', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          decision: 'execute_actions',
          reason: 'Open Settings and wait for it to settle',
          confidence: 0.95,
          expectedOutcome: 'Settings is the foreground app',
          actions: [
            {
              id: 'ambiguous-action',
              packageName: 'com.android.settings',
              durationMs: 1200
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          decision: 'execute_actions',
          actions: [
            { type: 'start_app', id: 'start-settings', packageName: 'com.android.settings' },
            { type: 'wait', id: 'wait-settings-open', durationMs: 1200 }
          ]
        })
      )
    const service = new RpaVisualCorrectionService({ modelClient: { complete } })

    const result = await service.decideRecovery({
      failureContext: failureContext(),
      observation: observation(),
      correctionRound: 1
    })

    expect(result.status).toBe('valid')
    expect(result.repaired).toBe(true)
    expect(result.decision).toMatchObject({
      decision: 'execute_actions',
      reason: 'Open Settings and wait for it to settle',
      confidence: 0.95,
      expectedOutcome: 'Settings is the foreground app',
      actions: [
        { type: 'start_app', id: 'start-settings' },
        { type: 'wait', id: 'wait-settings-open' }
      ]
    })
    expect(complete).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(complete.mock.calls[1][0].messages)).toContain('expectedOutcome')
  })

  it('keeps recovery requests bounded without duplicating screenshot observations', async () => {
    const complete = vi.fn().mockResolvedValue(
      JSON.stringify({
        decision: 'human_required',
        reason: 'The current state is ambiguous',
        confidence: 0.9,
        interventionCode: 'ambiguous_state'
      })
    )
    const service = new RpaVisualCorrectionService({ modelClient: { complete } })
    const currentObservation = observation()
    currentObservation.screenshot = { imageBase64: 'x'.repeat(250_000), mime: 'image/png' }
    currentObservation.textCandidates = Array.from({ length: 100 }, (_, index) => ({
      source: 'ui_tree' as const,
      text: `${index}-${'candidate'.repeat(100)}`,
      confidence: 0.8,
      bounds: {
        physical: { left: 0, top: 0, right: 1, bottom: 1, width: 1, height: 1, centerX: 0.5, centerY: 0.5 }
      }
    }))
    const embeddedContext = createEmbeddedRpaModelContext(
      buildRpaModelContext({
        callType: 'planner',
        rolePrompts: [
          {
            schemaVersion: 1,
            id: 'large-recovery-prompt',
            roleId: 'role-1',
            version: '1',
            kind: 'recovery',
            content: 'role-guidance '.repeat(2_000),
            priority: 1,
            status: 'enabled',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )

    await service.decideRecovery({
      failureContext: failureContext(),
      observation: currentObservation,
      correctionRound: 8,
      previousDecisions: Array.from({ length: 12 }, (_, index) => ({
        decision: 'human_required' as const,
        reason: `decision-${index}-${'history'.repeat(200)}`,
        confidence: 0.9,
        interventionCode: `code-${index}`
      })),
      knowledgeContext: {
        summaries: Array.from({ length: 20 }, (_, index) => ({
          id: `knowledge-${index}`,
          knowledgeBaseId: 'kb-1',
          category: 'recovery_guidance' as const,
          title: `Knowledge ${index}`,
          summary: 'knowledge '.repeat(1_000),
          confidence: 1,
          templateIds: [],
          skills: []
        })),
        conflicts: [],
        warnings: Array.from({ length: 30 }, () => 'warning '.repeat(100))
      },
      modelContext: embeddedContext
    })

    const messages = complete.mock.calls[0][0].messages
    const systemText = String(messages[0].content)
    const userContent = messages[1].content as Array<{ type: string; text?: string; image?: string }>
    const requestText = userContent.find((part) => part.type === 'text')?.text ?? ''
    const parsedRequest = JSON.parse(requestText)
    expect(systemText.length).toBeLessThan(5_000)
    expect(requestText.length).toBeLessThan(16_000)
    expect(parsedRequest.previousDecisions).toHaveLength(2)
    expect(parsedRequest.observation.textCandidates).toHaveLength(12)
    expect(requestText).not.toContain('BINARY_IMAGE_OMITTED')
    expect(userContent.find((part) => part.type === 'image')?.image).toHaveLength(250_000)
  })
})
