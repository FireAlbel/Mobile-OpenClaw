import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import { RpaSafetyPolicyEngine } from '../RpaSafetyPolicyEngine'
import type { RpaActionModule, RpaTask } from '../RpaTypes'

function task(params: Record<string, unknown> = {}): RpaTask {
  return {
    id: 'task-1',
    name: 'Safety task',
    goal: 'Test safety policy',
    deviceIds: ['device-1'],
    steps: [
      {
        id: 'step-1',
        name: 'Sensitive step',
        moduleId: 'sensitive_action',
        params,
        continueOnFailure: false
      }
    ],
    metadata: {}
  }
}

function module(riskLevel: 'low' | 'medium' | 'high' = 'high'): RpaActionModule {
  return {
    metadata: {
      id: 'sensitive_action',
      name: 'Sensitive action',
      description: 'A sensitive action',
      riskLevel,
      defaultTimeoutMs: 1_000,
      defaultRetry: { maxAttempts: 1, backoffMs: 0, retryOn: ['failed'] },
      safety: { textParamPaths: ['text'] }
    },
    paramsSchema: z.object({ text: z.string().optional() }),
    execute: vi.fn()
  }
}

describe('RpaSafetyPolicyEngine', () => {
  it('requires an out-of-band approval for high-risk modules', async () => {
    const engine = new RpaSafetyPolicyEngine({ now: () => 100 })
    const inputTask = task()
    const actionModule = module()

    const withoutApproval = await engine.evaluateModule({
      task: inputTask,
      deviceId: 'device-1',
      step: inputTask.steps[0],
      module: actionModule,
      params: {},
      approval: inputTask.metadata.safetyApproval as never
    })
    const approval = engine.createApproval(inputTask, ['module:sensitive_action'])
    const approved = await engine.evaluateModule({
      task: inputTask,
      deviceId: 'device-1',
      step: inputTask.steps[0],
      module: actionModule,
      params: {},
      approval
    })

    expect(withoutApproval.decision).toBe('confirmation_required')
    expect(approved.decision).toBe('allow')
  })

  it('rejects an approval after the task is edited', async () => {
    const engine = new RpaSafetyPolicyEngine({ now: () => 100 })
    const original = task()
    const approval = engine.createApproval(original, ['module:sensitive_action'])
    const edited = { ...original, goal: 'A different goal' }

    const decision = await engine.evaluateModule({
      task: edited,
      deviceId: 'device-1',
      step: edited.steps[0],
      module: module(),
      params: {},
      approval
    })

    expect(decision.decision).toBe('confirmation_required')
  })

  it('does not reuse a device-scoped approval on another phone', async () => {
    const engine = new RpaSafetyPolicyEngine({ now: () => 100 })
    const inputTask = task()
    const approval = engine.createApproval(inputTask, ['module:sensitive_action'], ['device-1'])

    const decision = await engine.evaluateModule({
      task: inputTask,
      deviceId: 'device-2',
      step: inputTask.steps[0],
      module: module(),
      params: {},
      approval
    })

    expect(decision.decision).toBe('confirmation_required')
  })

  it('isolates device rate limits', async () => {
    let now = 0
    const engine = new RpaSafetyPolicyEngine({
      now: () => now,
      rateLimits: [{ scope: 'device', maxActions: 1, windowMs: 1_000 }]
    })
    const inputTask = task()
    const actionModule = module('low')
    const evaluate = (deviceId: string) =>
      engine.evaluateModule({
        task: inputTask,
        deviceId,
        step: inputTask.steps[0],
        module: actionModule,
        params: {}
      })

    expect((await evaluate('device-1')).decision).toBe('allow')
    expect((await evaluate('device-1')).decision).toBe('delay')
    expect((await evaluate('device-2')).decision).toBe('allow')
    now = 1_001
    expect((await evaluate('device-1')).decision).toBe('allow')
  })

  it('blocks rejected generated text before execution', async () => {
    const moderateContent = vi.fn().mockResolvedValue({ allowed: false, reason: 'Content rejected' })
    const engine = new RpaSafetyPolicyEngine({ moderateContent })
    const inputTask = task({ text: 'generated comment' })

    const decision = await engine.evaluateModule({
      task: inputTask,
      deviceId: 'device-1',
      step: inputTask.steps[0],
      module: module('medium'),
      params: inputTask.steps[0].params
    })

    expect(decision).toMatchObject({ decision: 'blocked', reason: 'Content rejected' })
    expect(moderateContent).toHaveBeenCalledWith(
      expect.objectContaining({ texts: ['generated comment'], target: 'module:sensitive_action' })
    )
  })

  it('requires confirmation for permission-grant correction actions', async () => {
    const engine = new RpaSafetyPolicyEngine()

    const decision = await engine.evaluateCorrectionAction({
      task: task(),
      deviceId: 'device-1',
      action: { id: 'allow', type: 'permission_action', action: 'allow' }
    })

    expect(decision).toMatchObject({
      decision: 'confirmation_required',
      riskLevel: 'high',
      target: 'correction:permission_action:allow'
    })
  })

  it('raises permission-grant popup modules to high risk during preflight', () => {
    const engine = new RpaSafetyPolicyEngine()
    const inputTask = task()
    inputTask.steps[0] = {
      ...inputTask.steps[0],
      moduleId: 'handle_popup',
      params: { action: 'allow', required: true }
    }
    const metadata = {
      ...module('low').metadata,
      id: 'handle_popup'
    }

    const summary = engine.analyzeTask(inputTask, [metadata])

    expect(summary).toMatchObject({
      highestRisk: 'high',
      highRiskTargets: ['module:handle_popup:allow']
    })
  })
})
