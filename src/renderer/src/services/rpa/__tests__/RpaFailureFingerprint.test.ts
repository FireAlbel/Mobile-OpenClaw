import { describe, expect, it } from 'vitest'

import {
  type RpaFailureFingerprint,
  RpaFailureFingerprintRepository,
  type RpaFailureFingerprintStorage
} from '../RpaFailureFingerprint'

class MemoryFingerprintStorage implements RpaFailureFingerprintStorage {
  fingerprints: RpaFailureFingerprint[] = []

  async loadFingerprints() {
    return structuredClone(this.fingerprints)
  }

  async saveFingerprints(fingerprints: RpaFailureFingerprint[]) {
    this.fingerprints = structuredClone(fingerprints)
  }
}

describe('RpaFailureFingerprintRepository', () => {
  it('aggregates repeated failures and skips a repeatedly failing policy', async () => {
    const repository = new RpaFailureFingerprintRepository(new MemoryFingerprintStorage(), () => 100)
    const input = {
      failureClass: 'NO_PROGRESS' as const,
      appPackage: 'com.example.app',
      taskGoal: 'Open detail',
      stateId: 'DETAIL',
      moduleId: 'tap_by_vlm_target',
      failedRecoveryPolicyIds: ['builtin:navigate-back'],
      sourceRunId: 'run-1',
      sourceDeviceRunId: 'device-run-1'
    }

    const first = await repository.upsert(input)
    expect(first.experience).toMatchObject({ confidence: 0.55, verification: { status: 'unverified' } })
    await expect(repository.findMatches({ appPackage: 'com.example.app', taskGoal: 'Open detail' })).resolves.toEqual(
      []
    )
    const repeated = await repository.upsert({
      ...input,
      sourceRunId: 'run-2',
      sourceDeviceRunId: 'device-run-2'
    })

    expect(repeated).toMatchObject({
      occurrenceCount: 2,
      disposition: 'skip_failed_policy',
      experience: {
        confidence: 0.75,
        diagnosis: { failureClass: 'NO_PROGRESS', disposition: 'skip_failed_policy' }
      }
    })
    await expect(repository.findMatches({ appPackage: 'com.example.app', taskGoal: 'Open detail' })).resolves.toEqual([
      expect.objectContaining({ id: repeated.id })
    ])
    await expect(
      repository.shouldSkipPolicy(
        { appPackage: 'com.example.app', taskGoal: 'Open detail', stateId: 'DETAIL' },
        'builtin:navigate-back'
      )
    ).resolves.toBe(true)
  })

  it('redacts sensitive task text and routes protected states to a human', async () => {
    const repository = new RpaFailureFingerprintRepository(new MemoryFingerprintStorage(), () => 200)

    const fingerprint = await repository.upsert({
      failureClass: 'LOGIN_REQUIRED',
      taskGoal: 'Login with user@example.com and sk-abcdefghijklmnop',
      sourceRunId: 'run-1',
      sourceDeviceRunId: 'device-run-1'
    })

    expect(fingerprint.taskGoalSummary).toContain('[REDACTED:email]')
    expect(fingerprint.taskGoalSummary).toContain('[REDACTED:api_key]')
    expect(fingerprint.disposition).toBe('human_required')
  })

  it('can disable a rejected fingerprint without deleting evidence', async () => {
    const repository = new RpaFailureFingerprintRepository(new MemoryFingerprintStorage(), () => 300)
    const fingerprint = await repository.upsert({
      failureClass: 'UI_CHANGED',
      taskGoal: 'Open detail',
      sourceRunId: 'run-1',
      sourceDeviceRunId: 'device-run-1'
    })

    await repository.disable(fingerprint.id)

    expect(await repository.findMatches({ taskGoal: 'Open detail' })).toEqual([])
    expect((await repository.getAll())[0].status).toBe('disabled')
  })
})
