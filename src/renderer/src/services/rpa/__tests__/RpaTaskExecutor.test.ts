import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import type { RpaAppStateRecognizer } from '../RpaAppStateRecognizer'
import { createDefaultRpaModuleRegistry } from '../RpaDefaultRegistry'
import type { RpaDeterministicRecoveryService } from '../RpaDeterministicRecoveryService'
import type { RpaKnowledgeRetrievalService } from '../RpaKnowledgeRetrievalService'
import { buildRpaModelContext, createEmbeddedRpaModelContext } from '../RpaModelContextBuilder'
import { RpaModuleRegistry } from '../RpaModuleRegistry'
import type { RpaObservationService } from '../RpaObservationService'
import type { RpaReplanResult, RpaReplanService } from '../RpaReplanService'
import { RpaSafetyPolicyEngine } from '../RpaSafetyPolicyEngine'
import { RpaTaskExecutor } from '../RpaTaskExecutor'
import type { RpaActionModule, RpaCorrectionDecision, RpaDeviceRuntime, RpaModuleResult, RpaTask } from '../RpaTypes'
import type { RpaVerificationEngine } from '../RpaVerificationEngine'
import type { RpaCorrectionDecisionResult, RpaVisualCorrectionService } from '../RpaVisualCorrectionService'

function runtime(overrides: Partial<RpaDeviceRuntime> = {}): RpaDeviceRuntime {
  return {
    screenshot: vi.fn().mockResolvedValue({ success: true, message: 'screenshot ok', data: { imageBase64: 'png' } }),
    tap: vi.fn().mockResolvedValue({ success: true, message: 'tap ok' }),
    swipe: vi.fn(),
    key: vi.fn(),
    startApp: vi.fn(),
    getForegroundApp: vi.fn().mockResolvedValue({
      success: true,
      message: 'foreground ok',
      data: { packageName: 'com.example.app' }
    }),
    getScreenSize: vi.fn(),
    handlePermissionDialog: vi.fn(),
    visionInstruction: vi.fn(),
    locateVisualTarget: vi.fn(),
    executeCorrectionAction: vi.fn().mockResolvedValue({
      success: true,
      message: 'correction action executed',
      data: { transport: 'test', action: { id: 'tap', type: 'tap', x: 10, y: 20 } },
      startedAt: 1,
      finishedAt: 2
    }),
    ...overrides
  } as RpaDeviceRuntime
}

function task(moduleId = 'ok_module'): RpaTask {
  return {
    id: 'task-1',
    name: 'Task',
    goal: 'Run task',
    deviceIds: ['device-1'],
    metadata: {},
    steps: [
      {
        id: 'step-1',
        name: 'Step',
        moduleId,
        params: {},
        continueOnFailure: false,
        retry: { maxAttempts: 1, backoffMs: 0, retryOn: ['failed', 'timeout', 'uncertain'] }
      }
    ]
  }
}

function moduleWithExecutor(
  execute: RpaActionModule['execute'],
  riskLevel: RpaActionModule['metadata']['riskLevel'] = 'low'
): RpaActionModule {
  return {
    metadata: {
      id: 'ok_module',
      name: 'OK',
      description: 'Test module',
      riskLevel,
      defaultTimeoutMs: 1000,
      defaultRetry: { maxAttempts: 1, backoffMs: 0, retryOn: ['failed'] }
    },
    paramsSchema: z.object({}).default({}),
    execute
  }
}

function observation(imageBase64 = 'same-screen') {
  return {
    deviceId: 'device-1',
    capturedAt: Date.now(),
    screenshot: { imageBase64, mime: 'image/png' },
    foregroundApp: { packageName: 'com.example.app' },
    warnings: [],
    artifacts: {}
  }
}

function executeActionsDecision(): Extract<RpaCorrectionDecision, { decision: 'execute_actions' }> {
  return {
    decision: 'execute_actions',
    reason: 'Dismiss the popup',
    confidence: 0.95,
    expectedOutcome: 'The popup is gone',
    actions: [{ id: 'dismiss-popup', type: 'tap', x: 10, y: 20 }]
  }
}

function actionPlan(decision: Extract<RpaCorrectionDecision, { decision: 'execute_actions' }>): RpaReplanResult {
  return {
    status: 'actions',
    actions: decision.actions,
    steps: [
      {
        id: 'correction-1-action-1',
        name: 'Correction tap',
        moduleId: '__correction_action__',
        params: decision.actions[0],
        timeoutMs: 1000,
        continueOnFailure: false
      }
    ],
    expectedOutcome: decision.expectedOutcome,
    issues: [],
    message: decision.reason,
    confidence: decision.confidence
  }
}

function recoveryDependencies(
  decisionResults: RpaCorrectionDecisionResult[],
  plans: RpaReplanResult[],
  screenshots: string[] = ['same-screen', 'changed-screen']
) {
  const capture = vi.fn()
  for (const screenshot of screenshots) capture.mockResolvedValueOnce(observation(screenshot))
  capture.mockResolvedValue(observation(screenshots.at(-1)))

  const decideRecovery = vi.fn()
  for (const result of decisionResults) decideRecovery.mockResolvedValueOnce(result)

  const replan = vi.fn()
  for (const plan of plans) replan.mockResolvedValueOnce(plan)

  return {
    observationService: { capture } as unknown as RpaObservationService,
    visualCorrectionService: { decideRecovery } as unknown as RpaVisualCorrectionService,
    replanService: { replan } as unknown as RpaReplanService,
    capture,
    decideRecovery,
    replan
  }
}

function validDecision(decision: RpaCorrectionDecision): RpaCorrectionDecisionResult {
  return { status: 'valid', decision, rawResponse: JSON.stringify(decision), message: decision.reason, issues: [] }
}

function verificationEngine(correctionStatuses: Array<'passed' | 'failed' | 'uncertain'> = ['passed']) {
  const verifyCorrection = vi.fn()
  for (const status of correctionStatuses) {
    verifyCorrection.mockResolvedValueOnce({ status, confidence: 0.95, message: `correction ${status}` })
  }
  return {
    verify: vi.fn(async (_rule, result: RpaModuleResult) => ({
      status: result.success ? 'passed' : 'failed',
      confidence: 1,
      message: result.message
    })),
    verifyCorrection
  } as unknown as RpaVerificationEngine
}

describe('RpaTaskExecutor', () => {
  it('runs a validated task', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: true,
        status: 'passed',
        message: 'ok',
        startedAt: 1,
        finishedAt: 2
      }))
    )
    const executor = new RpaTaskExecutor({ registry, runtime: runtime() })

    const result = await executor.run(task(), 'device-1')

    expect(result.status).toBe('completed')
    expect(result.events.some((event) => event.status === 'passed')).toBe(true)
  })

  it('preserves a terminal module timeout without running secondary verification', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: false,
        status: 'timeout',
        message: 'Scrcpy frame is stale',
        startedAt: 1,
        finishedAt: 2
      }))
    )
    const verify = vi.fn()
    const result = await new RpaTaskExecutor({
      registry,
      runtime: runtime(),
      verificationEngine: { verify, verifyCorrection: vi.fn() } as unknown as RpaVerificationEngine
    }).run(task(), 'device-1')

    expect(result.status).toBe('failed')
    expect(result.error).toBe('Scrcpy frame is stale')
    expect(verify).not.toHaveBeenCalled()
    expect(result.events.some((event) => event.message === 'Scrcpy frame is stale')).toBe(true)
    expect(result.events.some((event) => event.message.includes('Verification timed out'))).toBe(false)
  })

  it('expands app normalization action groups into ordered audit events', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: true,
        status: 'passed',
        message: 'App reached HOME',
        data: {
          outcome: 'goal_achieved',
          initialState: { stateId: 'DETAIL' },
          finalState: { stateId: 'HOME' },
          actionGroups: [
            {
              stage: 'bounded_back',
              success: true,
              message: 'Back completed',
              verification: { status: 'passed', confidence: 1, message: 'HOME reached' }
            }
          ]
        },
        startedAt: 1,
        finishedAt: 2
      }))
    )

    const result = await new RpaTaskExecutor({ registry, runtime: runtime() }).run(task(), 'device-1')

    expect(result.events.map((event) => event.phase).filter(Boolean)).toEqual([
      'safety_policy',
      'original_step',
      'app_normalization_initial',
      'app_normalization_action',
      'app_normalization_verification',
      'app_normalization_terminal',
      'original_step'
    ])
  })

  it('uses a separate timeout budget for visual verification', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: true,
        status: 'passed',
        message: 'action completed',
        startedAt: 1,
        finishedAt: 2
      }))
    )
    const input = task()
    input.steps[0].verify = {
      type: 'vlm_assert',
      expectation: 'The expected screen is visible',
      minConfidence: 0.7,
      settleMs: 0
    }
    const verify = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { status: 'passed' as const, confidence: 0.95, message: 'verified' }
    })

    const result = await new RpaTaskExecutor({
      registry,
      runtime: runtime(),
      verificationEngine: { verify, verifyCorrection: vi.fn() } as unknown as RpaVerificationEngine,
      verificationTimeoutMs: 100
    }).run(input, 'device-1')

    expect(result.status).toBe('completed')
    expect(verify).toHaveBeenCalledOnce()
  })

  it('routes an uncertain verification through VLM recovery with screenshot evidence', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: true,
        status: 'passed',
        message: 'action completed',
        startedAt: 1,
        finishedAt: 2
      }))
    )
    const decision: RpaCorrectionDecision = {
      decision: 'goal_achieved',
      reason: 'The expected screen is already visible',
      confidence: 0.95,
      evidence: 'The target heading is visible'
    }
    const plan: RpaReplanResult = {
      status: 'goal_achieved',
      steps: [],
      actions: [],
      expectedOutcome: 'Run task',
      issues: [],
      message: decision.reason,
      confidence: decision.confidence
    }
    const recovery = recoveryDependencies([validDecision(decision)], [plan])
    const deterministicPlan = vi.fn()
    const verifier = {
      verify: vi.fn().mockResolvedValue({
        status: 'uncertain',
        confidence: 0,
        message: 'Verification timed out after 90000ms'
      }),
      verifyCorrection: vi.fn().mockResolvedValue({ status: 'passed', confidence: 0.98, message: 'goal verified' })
    } as unknown as RpaVerificationEngine

    const result = await new RpaTaskExecutor({
      registry,
      runtime: runtime(),
      verificationEngine: verifier,
      deterministicRecoveryService: {
        plan: deterministicPlan,
        isRecovered: vi.fn()
      } as unknown as RpaDeterministicRecoveryService,
      ...recovery
    }).run(task(), 'device-1')

    expect(result.status).toBe('completed')
    expect(deterministicPlan).not.toHaveBeenCalled()
    expect(recovery.decideRecovery).toHaveBeenCalledOnce()
    expect(result.events.find((event) => event.phase === 'correction_observation')?.data).toMatchObject({
      observation: { screenshot: { imageBase64: 'same-screen' } }
    })
  })

  it('routes a failed verification through VLM before deterministic recovery when the action succeeded', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: true,
        status: 'passed',
        message: 'action completed',
        startedAt: 1,
        finishedAt: 2
      }))
    )
    const decision: RpaCorrectionDecision = {
      decision: 'goal_achieved',
      reason: 'The expected screen is already visible',
      confidence: 0.95,
      evidence: 'The target heading is visible'
    }
    const recovery = recoveryDependencies(
      [validDecision(decision)],
      [
        {
          status: 'goal_achieved',
          steps: [],
          actions: [],
          expectedOutcome: 'Run task',
          issues: [],
          message: decision.reason,
          confidence: decision.confidence
        }
      ]
    )
    const deterministicPlan = vi.fn()
    const verifier = {
      verify: vi.fn().mockResolvedValue({ status: 'failed', confidence: 0.9, message: 'wrong screen' }),
      verifyCorrection: vi.fn().mockResolvedValue({ status: 'passed', confidence: 0.98, message: 'goal verified' })
    } as unknown as RpaVerificationEngine

    const result = await new RpaTaskExecutor({
      registry,
      runtime: runtime(),
      verificationEngine: verifier,
      deterministicRecoveryService: {
        plan: deterministicPlan,
        isRecovered: vi.fn()
      } as unknown as RpaDeterministicRecoveryService,
      ...recovery
    }).run(task(), 'device-1')

    expect(result.status).toBe('completed')
    expect(deterministicPlan).not.toHaveBeenCalled()
    expect(recovery.decideRecovery).toHaveBeenCalledOnce()
  })

  it('pauses before a high-risk module without a matching approval', async () => {
    const registry = new RpaModuleRegistry()
    const execute = vi.fn()
    registry.register(moduleWithExecutor(execute, 'high'))

    const result = await new RpaTaskExecutor({ registry, runtime: runtime() }).run(task(), 'device-1')

    expect(result.status).toBe('needs_human')
    expect(result.error).toContain('Confirmation required')
    expect(execute).not.toHaveBeenCalled()
    expect(result.events.at(-1)).toMatchObject({ phase: 'safety_policy', status: 'needs_human' })
  })

  it('executes a high-risk module with an approval bound to the task', async () => {
    const registry = new RpaModuleRegistry()
    const execute = vi.fn().mockResolvedValue({
      success: true,
      status: 'passed',
      message: 'approved',
      startedAt: 1,
      finishedAt: 2
    })
    registry.register(moduleWithExecutor(execute, 'high'))
    const inputTask = task()
    const safetyPolicyEngine = new RpaSafetyPolicyEngine()
    const safetyApproval = safetyPolicyEngine.createApproval(inputTask, ['module:ok_module'])

    const result = await new RpaTaskExecutor({
      registry,
      runtime: runtime(),
      safetyPolicyEngine,
      safetyApproval
    }).run(inputTask, 'device-1')

    expect(result.status).toBe('completed')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('retries a failed original module according to its retry policy', async () => {
    const registry = new RpaModuleRegistry()
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ success: false, status: 'failed', message: 'first failed', startedAt: 1, finishedAt: 2 })
      .mockResolvedValueOnce({ success: true, status: 'passed', message: 'second ok', startedAt: 3, finishedAt: 4 })
    registry.register(moduleWithExecutor(execute))
    const testTask = task()
    testTask.steps[0].retry = { maxAttempts: 2, backoffMs: 0, retryOn: ['failed'] }

    const result = await new RpaTaskExecutor({ registry, runtime: runtime() }).run(testTask, 'device-1')

    expect(result.status).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('cancels an active module when the external run signal aborts', async () => {
    const registry = new RpaModuleRegistry()
    const execute = vi.fn(
      (context: Parameters<RpaActionModule['execute']>[0]) =>
        new Promise<RpaModuleResult>((_resolve, reject) => {
          if (context.signal?.aborted) reject(context.signal.reason)
          else context.signal?.addEventListener('abort', () => reject(context.signal?.reason), { once: true })
        })
    )
    registry.register(moduleWithExecutor(execute))
    const controller = new AbortController()
    const running = new RpaTaskExecutor({ registry, runtime: runtime() }).run(task(), 'device-1', controller.signal)

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    controller.abort(new Error('Emergency stop'))
    const result = await running

    expect(result.status).toBe('cancelled')
    expect(result.error).toContain('Emergency stop')
  })

  it('executes a VLM action, forces verification, then retries the original step', async () => {
    const registry = new RpaModuleRegistry()
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ success: false, status: 'failed', message: 'blocked', startedAt: 1, finishedAt: 2 })
      .mockResolvedValueOnce({ success: true, status: 'passed', message: 'recovered', startedAt: 3, finishedAt: 4 })
    registry.register(moduleWithExecutor(execute))
    const decision = executeActionsDecision()
    const recovery = recoveryDependencies([validDecision(decision)], [actionPlan(decision)])
    const testRuntime = runtime()
    const verifier = verificationEngine(['passed'])
    const recoveryKnowledge = {
      summaries: [
        {
          id: 'known-failure',
          category: 'failure_case' as const,
          title: 'Known popup',
          summary: 'Dismiss the popup',
          confidence: 0.9,
          knowledgeBaseId: 'kb-1',
          templateIds: [],
          skills: []
        }
      ],
      conflicts: [],
      warnings: []
    }
    const retrieve = vi.fn().mockResolvedValue(recoveryKnowledge)
    const executor = new RpaTaskExecutor({
      registry,
      runtime: testRuntime,
      verificationEngine: verifier,
      knowledgeRetrievalService: { retrieve } as unknown as RpaKnowledgeRetrievalService,
      ...recovery
    })
    const inputTask = task()
    inputTask.goal = 'Open Settings, restart it, then capture a screenshot'
    inputTask.steps[0].name = 'Ensure Settings home'
    inputTask.steps[0].params = { packageName: 'com.android.settings', targetState: 'home' }
    const embeddedModelContext = createEmbeddedRpaModelContext(
      buildRpaModelContext({ callType: 'planner', now: () => 1 })
    )
    inputTask.metadata = {
      rpaAssets: { knowledgeIds: ['kb-1'] },
      rpaModelContext: embeddedModelContext
    }

    const result = await executor.run(inputTask, 'device-1')

    expect(result.status).toBe('completed')
    expect(testRuntime.executeCorrectionAction).toHaveBeenCalledWith(
      'device-1',
      expect.objectContaining({ type: 'tap' }),
      expect.any(AbortSignal)
    )
    expect(verifier.verifyCorrection).toHaveBeenCalledOnce()
    expect(retrieve).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseIds: ['kb-1'],
        appPackage: 'com.example.app',
        taskGoal: 'Open Settings, restart it, then capture a screenshot',
        errorClass: 'failed'
      })
    )
    expect(recovery.decideRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeContext: recoveryKnowledge,
        modelContext: embeddedModelContext,
        observation: expect.objectContaining({
          recognizedState: expect.objectContaining({ stateId: 'UNKNOWN' })
        })
      })
    )
    expect(verifier.verifyCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        expectation: expect.stringContaining('Ensure Settings home'),
        modelContext: embeddedModelContext
      })
    )
    const correctionExpectation = vi.mocked(verifier.verifyCorrection).mock.calls[0][0].expectation
    expect(correctionExpectation).toContain('Ignore later task steps')
    expect(correctionExpectation).not.toContain(inputTask.goal)
    expect(result.events.map((event) => event.phase)).toEqual(
      expect.arrayContaining([
        'original_failure',
        'state_recognition',
        'correction_decision',
        'temporary_action',
        'correction_verification'
      ])
    )
    expect(result.events.find((event) => event.phase === 'correction_decision')).toMatchObject({
      data: {
        knowledgeReferences: [{ id: 'known-failure', knowledgeBaseId: 'kb-1', category: 'failure_case' }]
      }
    })
  })

  it('does not let a VLM permission grant bypass safety confirmation', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: false,
        status: 'failed',
        message: 'permission dialog',
        startedAt: 1,
        finishedAt: 2
      }))
    )
    const decision: Extract<RpaCorrectionDecision, { decision: 'execute_actions' }> = {
      decision: 'execute_actions',
      reason: 'Grant permission',
      confidence: 0.95,
      expectedOutcome: 'Permission dialog closes',
      actions: [{ id: 'allow', type: 'permission_action', action: 'allow' }]
    }
    const recovery = recoveryDependencies([validDecision(decision)], [actionPlan(decision)])
    const testRuntime = runtime()

    const result = await new RpaTaskExecutor({ registry, runtime: testRuntime, ...recovery }).run(task(), 'device-1')

    expect(result.status).toBe('needs_human')
    expect(result.error).toContain('Confirmation required')
    expect(testRuntime.executeCorrectionAction).not.toHaveBeenCalled()
    expect(result.events.some((event) => event.phase === 'safety_policy' && event.safety?.riskLevel === 'high')).toBe(
      true
    )
  })

  it('does not accept descriptive VLM output as a correction result', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: false,
        status: 'failed',
        message: 'blocked',
        startedAt: 1,
        finishedAt: 2
      }))
    )
    const invalid: RpaCorrectionDecisionResult = {
      status: 'invalid',
      rawResponse: 'Tap the close button.',
      message: 'VLM correction response contains no executable decision',
      issues: ['decision is required']
    }
    const recovery = recoveryDependencies([invalid], [])

    const result = await new RpaTaskExecutor({ registry, runtime: runtime(), ...recovery }).run(task(), 'device-1')

    expect(result.status).toBe('needs_human')
    expect(result.error).toContain('no executable decision')
    expect(recovery.replan).not.toHaveBeenCalled()
  })

  it('independently verifies goal_achieved before completing', async () => {
    const registry = new RpaModuleRegistry()
    const execute = vi.fn().mockResolvedValue({
      success: false,
      status: 'failed',
      message: 'action reported failure',
      startedAt: 1,
      finishedAt: 2
    })
    registry.register(moduleWithExecutor(execute))
    const decision: RpaCorrectionDecision = {
      decision: 'goal_achieved',
      reason: 'Success page is visible',
      confidence: 0.98,
      evidence: 'The success title is visible'
    }
    const plan: RpaReplanResult = {
      status: 'goal_achieved',
      steps: [],
      actions: [],
      expectedOutcome: 'Run task',
      issues: [],
      message: decision.reason,
      confidence: decision.confidence
    }
    const recovery = recoveryDependencies([validDecision(decision)], [plan])
    const verifier = verificationEngine(['passed'])

    const result = await new RpaTaskExecutor({
      registry,
      runtime: runtime(),
      verificationEngine: verifier,
      ...recovery
    }).run(task(), 'device-1')

    expect(result.status).toBe('completed')
    expect(verifier.verifyCorrection).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('stops and requests a person after detecting no visual progress', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: false,
        status: 'failed',
        message: 'still blocked',
        startedAt: 1,
        finishedAt: 2
      }))
    )
    const decision = executeActionsDecision()
    const recovery = recoveryDependencies([validDecision(decision)], [actionPlan(decision)], ['same', 'same'])

    const result = await new RpaTaskExecutor({
      registry,
      runtime: runtime(),
      verificationEngine: verificationEngine(['failed']),
      noProgressLimit: 1,
      ...recovery
    }).run(task(), 'device-1')

    expect(result.status).toBe('needs_human')
    expect(result.error).toContain('without progress')
  })

  it('routes an explicit human_required decision to a paused run', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: false,
        status: 'failed',
        message: 'CAPTCHA',
        startedAt: 1,
        finishedAt: 2
      }))
    )
    const decision: RpaCorrectionDecision = {
      decision: 'human_required',
      reason: 'CAPTCHA requires a person',
      confidence: 0.99,
      interventionCode: 'captcha'
    }
    const plan: RpaReplanResult = {
      status: 'human_required',
      steps: [],
      actions: [],
      issues: [],
      message: decision.reason,
      confidence: decision.confidence
    }
    const recovery = recoveryDependencies([validDecision(decision)], [plan])

    const result = await new RpaTaskExecutor({ registry, runtime: runtime(), ...recovery }).run(task(), 'device-1')

    expect(result.status).toBe('needs_human')
    expect(result.events.at(-1)?.phase).toBe('correction_terminal')
  })

  it('runs deterministic Skill recovery before VLM and retries the original step', async () => {
    const registry = createDefaultRpaModuleRegistry()
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        status: 'failed',
        message: 'wrong page',
        startedAt: 1,
        finishedAt: 2
      })
      .mockResolvedValueOnce({ success: true, status: 'passed', message: 'ok', startedAt: 3, finishedAt: 4 })
    registry.register(moduleWithExecutor(execute))
    const initial = {
      ...observation('unknown'),
      recognizedState: recognizedState('UNKNOWN', true, 'unknown', 'navigate')
    }
    const recovered = {
      ...observation('home'),
      recognizedState: recognizedState('HOME', false, 'none', 'none')
    }
    const capture = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(recovered)
    const decideRecovery = vi.fn()
    const input = task()
    input.metadata = {
      appStateProfile: {
        appPackage: 'com.example.app',
        states: [{ stateId: 'HOME', blockingCondition: 'none', recoveryScope: 'none' }]
      },
      deterministicRecoveryPolicies: [
        {
          id: 'skill:return-home',
          fromStateIds: ['UNKNOWN'],
          targetStateIds: ['HOME'],
          priority: 100,
          steps: [{ id: 'back', name: 'Back', moduleId: 'press_back', params: {}, continueOnFailure: false }]
        }
      ]
    }

    const result = await new RpaTaskExecutor({
      registry,
      runtime: runtime({
        key: vi.fn().mockResolvedValue({ success: true, message: 'back', startedAt: 1, finishedAt: 2 })
      }),
      observationService: { capture } as unknown as RpaObservationService,
      appStateRecognizer: {
        recognize: vi.fn(async ({ observation: current }) => current.recognizedState)
      } as unknown as RpaAppStateRecognizer,
      visualCorrectionService: { decideRecovery } as unknown as RpaVisualCorrectionService,
      verificationEngine: verificationEngine()
    }).run(input, 'device-1')

    expect(result.status).toBe('completed')
    expect(decideRecovery).not.toHaveBeenCalled()
    expect(result.events.some((event) => event.phase === 'deterministic_recovery_verification')).toBe(true)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('yields deterministic recovery to VLM after no progress', async () => {
    const registry = createDefaultRpaModuleRegistry()
    registry.register(
      moduleWithExecutor(async () => ({
        success: false,
        status: 'failed',
        message: 'wrong page',
        startedAt: 1,
        finishedAt: 2
      }))
    )
    const unknown = {
      ...observation('same'),
      recognizedState: recognizedState('UNKNOWN', true, 'unknown', 'navigate')
    }
    const capture = vi.fn().mockResolvedValue(unknown)
    const decision: RpaCorrectionDecision = {
      decision: 'human_required',
      reason: 'No safe visual recovery is available',
      confidence: 0.9,
      interventionCode: 'unsupported_state'
    }
    const decideRecovery = vi.fn().mockResolvedValue(validDecision(decision))
    const input = task()
    input.metadata = {
      appStateProfile: { appPackage: 'com.example.app', states: [] }
    }

    const result = await new RpaTaskExecutor({
      registry,
      runtime: runtime({
        key: vi.fn().mockResolvedValue({ success: true, message: 'back', startedAt: 1, finishedAt: 2 })
      }),
      observationService: { capture } as unknown as RpaObservationService,
      appStateRecognizer: {
        recognize: vi.fn(async ({ observation: current }) => current.recognizedState)
      } as unknown as RpaAppStateRecognizer,
      visualCorrectionService: { decideRecovery } as unknown as RpaVisualCorrectionService,
      replanService: {
        replan: vi.fn().mockResolvedValue({
          status: 'human_required',
          steps: [],
          actions: [],
          issues: [],
          message: decision.reason,
          confidence: decision.confidence
        })
      } as unknown as RpaReplanService,
      verificationEngine: verificationEngine(),
      noProgressLimit: 1
    }).run(input, 'device-1')

    expect(result.status).toBe('needs_human')
    expect(decideRecovery).toHaveBeenCalledOnce()
    expect(result.events.some((event) => event.phase === 'correction_decision')).toBe(true)
  })

  it('fails when the selected device is not assigned', async () => {
    const registry = new RpaModuleRegistry()
    registry.register(moduleWithExecutor(vi.fn()))
    const executor = new RpaTaskExecutor({ registry, runtime: runtime() })

    await expect(executor.run(task(), 'device-2')).rejects.toThrow('not assigned')
  })
})

function recognizedState(
  stateId: string,
  blocking: boolean,
  blockingCondition: 'none' | 'unknown',
  recoveryScope: 'none' | 'navigate'
) {
  return {
    stateId,
    label: stateId,
    confidence: 0.9,
    blocking,
    blockingCondition,
    recoveryScope,
    suggestedTransitions: [],
    evidence: [],
    reason: stateId,
    recognizedAt: Date.now()
  }
}
