import { describe, expect, it } from 'vitest'

import { createDefaultRpaModuleRegistry } from '../RpaDefaultRegistry'
import { RpaDeterministicRecoveryService } from '../RpaDeterministicRecoveryService'
import {
  type RpaFailureFingerprint,
  RpaFailureFingerprintRepository,
  type RpaFailureFingerprintStorage
} from '../RpaFailureFingerprint'
import type { RpaDeviceObservation, RpaRecognizedAppState, RpaTask } from '../RpaTypes'

function task(metadata: Record<string, unknown> = {}): RpaTask {
  return {
    id: 'task-1',
    name: 'Task',
    goal: 'Reach home',
    deviceIds: ['device-1'],
    steps: [{ id: 'main', name: 'Main', moduleId: 'wait', params: { durationMs: 100 }, continueOnFailure: false }],
    metadata: {
      appStateProfile: {
        appPackage: 'com.example.app',
        states: [
          { stateId: 'HOME', blockingCondition: 'none', recoveryScope: 'none' },
          { stateId: 'DETAIL', blockingCondition: 'none', recoveryScope: 'navigate' }
        ]
      },
      ...metadata
    }
  }
}

function observation(overrides: Partial<RpaRecognizedAppState>): RpaDeviceObservation {
  return {
    deviceId: 'device-1',
    capturedAt: 1,
    screenshot: { imageBase64: 'screen' },
    warnings: [],
    artifacts: {},
    recognizedState: {
      stateId: 'UNKNOWN',
      label: 'Unknown',
      confidence: 0.2,
      blocking: true,
      blockingCondition: 'unknown',
      recoveryScope: 'navigate',
      suggestedTransitions: [],
      evidence: [],
      reason: 'Unknown state',
      recognizedAt: 1,
      ...overrides
    }
  }
}

class MemoryFingerprintStorage implements RpaFailureFingerprintStorage {
  fingerprints: RpaFailureFingerprint[] = []
  async loadFingerprints() {
    return structuredClone(this.fingerprints)
  }
  async saveFingerprints(fingerprints: RpaFailureFingerprint[]) {
    this.fingerprints = structuredClone(fingerprints)
  }
}

describe('RpaDeterministicRecoveryService', () => {
  const service = new RpaDeterministicRecoveryService(createDefaultRpaModuleRegistry())

  it('prefers a configured Skill recovery policy', async () => {
    const result = await service.plan({
      task: task({
        deterministicRecoveryPolicies: [
          {
            id: 'skill:return-home',
            fromStateIds: ['DETAIL'],
            targetStateIds: ['HOME'],
            priority: 100,
            steps: [{ id: 'back', name: 'Back', moduleId: 'press_back', params: {}, continueOnFailure: false }]
          }
        ]
      }),
      observation: observation({ stateId: 'DETAIL', blocking: false, recoveryScope: 'navigate' }),
      depth: 0,
      attemptedPolicyIds: []
    })

    expect(result).toMatchObject({ status: 'steps', policyId: 'skill:return-home', targetStateIds: ['HOME'] })
  })

  it('builds bounded unknown-state navigation and restart plans', async () => {
    const back = await service.plan({ task: task(), observation: observation({}), depth: 0, attemptedPolicyIds: [] })
    const reopen = await service.plan({ task: task(), observation: observation({}), depth: 1, attemptedPolicyIds: [] })
    const restart = await service.plan({ task: task(), observation: observation({}), depth: 2, attemptedPolicyIds: [] })

    expect(back.status === 'steps' && back.steps.map((step) => step.moduleId)).toEqual(['press_back'])
    expect(reopen.status === 'steps' && reopen.steps.map((step) => step.moduleId)).toEqual(['press_home', 'launch_app'])
    expect(restart.status === 'steps' && restart.steps.map((step) => step.moduleId)).toEqual(['restart_app'])
  })

  it('handles permission dialogs through a safety-controlled module', async () => {
    const result = await service.plan({
      task: task(),
      observation: observation({
        stateId: 'PERMISSION_DIALOG',
        blockingCondition: 'permission_dialog',
        recoveryScope: 'dismiss_overlay'
      }),
      depth: 0,
      attemptedPolicyIds: []
    })

    expect(result.status === 'steps' && result.steps[0]).toMatchObject({
      moduleId: 'handle_popup',
      params: { action: 'allow_once', required: true }
    })
  })

  it.each(['authentication', 'captcha', 'payment', 'account_security'] as const)(
    'requires a human for %s states',
    async (blockingCondition) => {
      const result = await service.plan({
        task: task(),
        observation: observation({ blockingCondition, recoveryScope: 'human' }),
        depth: 0,
        attemptedPolicyIds: []
      })

      expect(result).toMatchObject({ status: 'human_required' })
    }
  )

  it('verifies the recognized state against the policy target', async () => {
    const plan = await service.plan({
      task: task(),
      observation: observation({ stateId: 'DETAIL', blocking: false, recoveryScope: 'navigate' }),
      expectedStateId: 'HOME',
      depth: 0,
      attemptedPolicyIds: []
    })
    expect(plan.status).toBe('steps')
    if (plan.status !== 'steps') return

    expect(service.isRecovered(plan, observation({ stateId: 'HOME', blocking: false, recoveryScope: 'none' }))).toBe(
      true
    )
    expect(service.isRecovered(plan, observation({ stateId: 'DETAIL', blocking: false }))).toBe(false)
  })

  it('skips a recovery policy that repeatedly produced the same failure', async () => {
    const fingerprints = new RpaFailureFingerprintRepository(new MemoryFingerprintStorage(), () => 1)
    const failed = {
      failureClass: 'NO_PROGRESS' as const,
      appPackage: 'com.example.app',
      taskGoal: 'Reach home',
      stateId: 'DETAIL',
      failedRecoveryPolicyIds: ['skill:return-home'],
      sourceRunId: 'run-1',
      sourceDeviceRunId: 'device-run-1'
    }
    await fingerprints.upsert(failed)
    await fingerprints.upsert({ ...failed, sourceRunId: 'run-2', sourceDeviceRunId: 'device-run-2' })
    const recovery = new RpaDeterministicRecoveryService(createDefaultRpaModuleRegistry(), fingerprints)

    const result = await recovery.plan({
      task: task({
        deterministicRecoveryPolicies: [
          {
            id: 'skill:return-home',
            fromStateIds: ['DETAIL'],
            targetStateIds: ['HOME'],
            priority: 100,
            steps: [{ id: 'back', name: 'Back', moduleId: 'press_back', params: {}, continueOnFailure: false }]
          }
        ]
      }),
      observation: observation({ stateId: 'DETAIL', blocking: false, recoveryScope: 'navigate' }),
      depth: 0,
      attemptedPolicyIds: []
    })

    expect(result).toMatchObject({ status: 'steps', policyId: 'builtin:navigate-back' })
  })
})
