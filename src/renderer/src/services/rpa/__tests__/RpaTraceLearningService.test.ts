import { describe, expect, it } from 'vitest'

import { type RpaArtifact, type RpaArtifactStorage, RpaArtifactStore } from '../RpaArtifactStore'
import {
  type RpaFailureFingerprint,
  RpaFailureFingerprintRepository,
  type RpaFailureFingerprintStorage
} from '../RpaFailureFingerprint'
import type { RpaBatchRunRecord } from '../RpaRunStorage'
import type { RpaTemplateRecord, SaveRpaTemplateInput } from '../RpaTemplateRepository'
import { RpaTraceLearningService } from '../RpaTraceLearningService'

class MemoryFingerprintStorage implements RpaFailureFingerprintStorage {
  fingerprints: RpaFailureFingerprint[] = []
  async loadFingerprints() {
    return structuredClone(this.fingerprints)
  }
  async saveFingerprints(fingerprints: RpaFailureFingerprint[]) {
    this.fingerprints = structuredClone(fingerprints)
  }
}

class MemoryArtifactStorage implements RpaArtifactStorage {
  artifacts: RpaArtifact[] = []
  async loadArtifacts() {
    return structuredClone(this.artifacts)
  }
  async saveArtifacts(artifacts: RpaArtifact[]) {
    this.artifacts = structuredClone(artifacts)
  }
}

function run(
  id: string,
  status: 'completed' | 'failed' | 'needs_human' = 'failed',
  message = 'Wrong page without progress for user@example.com'
): RpaBatchRunRecord {
  const deviceStatus = status
  return {
    id,
    task: {
      id: 'task-1',
      name: 'Open detail',
      goal: 'Open detail page',
      deviceIds: ['device-1'],
      metadata: {
        appStateProfile: { appPackage: 'com.example.app', states: [] },
        compiledSkill: { id: 'open-example-detail', version: '1.0.0' }
      },
      steps: [
        {
          id: 'step-1',
          name: 'Open detail',
          moduleId: 'tap_by_vlm_target',
          params: { target: 'Detail' },
          verify: { type: 'vlm_assert', expectation: 'Detail page visible', minConfidence: 0.7, settleMs: 0 },
          continueOnFailure: false
        }
      ]
    },
    deviceIds: ['device-1'],
    status: status === 'needs_human' ? 'paused' : status,
    createdAt: 1,
    updatedAt: 2,
    contextSnapshot: {
      schemaVersion: 1,
      createdAt: 1,
      topicId: 'topic-1',
      assistantId: 'assistant-1',
      assistantProfileVersion: 1,
      models: {
        planner: { providerId: 'provider', modelId: 'model' },
        vision: { providerId: 'provider', modelId: 'model' },
        verification: { providerId: 'provider', modelId: 'model' },
        recovery: { providerId: 'provider', modelId: 'model' }
      },
      skills: [{ id: 'open-example-detail', version: '1.0.0' }],
      knowledge: [],
      appPackages: ['com.example.app'],
      resolutionWarnings: []
    },
    deviceRuns: [
      {
        id: `${id}-device`,
        batchRunId: id,
        taskId: 'task-1',
        deviceId: 'device-1',
        status: deviceStatus,
        error: status === 'completed' ? undefined : message,
        events: [
          {
            taskId: 'task-1',
            deviceId: 'device-1',
            stepId: 'step-1',
            stepName: 'Open detail',
            status: status === 'completed' ? 'passed' : status,
            attempt: 1,
            message,
            timestamp: 2,
            phase: status === 'completed' ? 'original_step' : 'deterministic_recovery_plan',
            data: {
              plan: { policyId: 'builtin:navigate-back' },
              recognizedState: {
                stateId: 'DETAIL',
                blockingCondition: message.includes('login') ? 'authentication' : 'none',
                evidence: [{ source: 'ui_tree', value: 'Detail', matched: true }]
              }
            },
            verification:
              status === 'completed' ? { status: 'passed', confidence: 1, message: 'Detail page visible' } : undefined
          }
        ],
        createdAt: 1,
        updatedAt: 2,
        finishedAt: 2
      }
    ]
  }
}

async function harness() {
  let now = 100
  const fingerprintStorage = new MemoryFingerprintStorage()
  const fingerprints = new RpaFailureFingerprintRepository(fingerprintStorage, () => now++)
  const artifacts = new RpaArtifactStore(new MemoryArtifactStorage(), undefined, () => now++)
  const templateRecords: RpaTemplateRecord[] = []
  const templates = {
    getAll: async () => structuredClone(templateRecords),
    save: async (input: SaveRpaTemplateInput) => {
      const existing = input.id ? templateRecords.find((record) => record.id === input.id) : undefined
      const version = existing && input.saveMode === 'new_version' ? existing.version + 1 : (existing?.version ?? 1)
      const record: RpaTemplateRecord = {
        id: input.id ?? `template-${now++}`,
        version,
        name: input.name ?? existing?.name ?? 'Learned task flow',
        goal: input.goal ?? existing?.goal ?? 'Learned goal',
        dsl: structuredClone(input.dsl),
        status: 'executable',
        validationIssues: [],
        tags: input.tags ?? existing?.tags ?? [],
        skillLinks: input.skillLinks ?? existing?.skillLinks ?? [],
        role: input.role ?? existing?.role,
        source: input.source ?? existing?.source ?? 'manual',
        sourceRef: input.sourceRef ?? existing?.sourceRef,
        sourceContext: input.sourceContext ?? existing?.sourceContext,
        revisions:
          existing && input.saveMode === 'new_version'
            ? [
                {
                  version: existing.version,
                  dsl: existing.dsl,
                  validationIssues: existing.validationIssues,
                  updatedAt: existing.updatedAt
                },
                ...existing.revisions
              ]
            : (existing?.revisions ?? []),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      templateRecords.splice(
        0,
        templateRecords.length,
        record,
        ...templateRecords.filter((item) => item.id !== record.id)
      )
      return structuredClone(record)
    }
  }
  const service = new RpaTraceLearningService({
    fingerprints,
    artifacts,
    templates,
    now: () => now++
  })
  return { service, fingerprints, artifacts, templates, templateRecords }
}

function seedTemplate(records: RpaTemplateRecord[], sourceRun: RpaBatchRunRecord, version: number): void {
  records.push({
    id: 'template-1',
    version,
    name: 'Open detail',
    goal: 'Open detail page',
    dsl: { ...sourceRun.task, deviceIds: [] },
    status: 'executable',
    validationIssues: [],
    tags: [],
    skillLinks: [],
    source: 'manual',
    revisions: [],
    createdAt: 1,
    updatedAt: version
  })
}

describe('RpaTraceLearningService', () => {
  it('classifies a failed trace into one structured, redacted experience', async () => {
    const { service, fingerprints, artifacts } = await harness()
    const failedRun = run('run-1')
    await artifacts.register({
      title: 'Failure screenshot',
      category: 'screenshot',
      contentHash: 'hash-1',
      sizeBytes: 10,
      source: 'observation',
      locator: { fileId: 'shot.png' },
      links: [{ targetType: 'device_run', targetId: 'run-1-device', relation: 'failure' }]
    })

    const analysis = await service.analyzeDeviceRun(failedRun, 'run-1-device')
    expect(analysis).toMatchObject({ failureClass: 'NO_PROGRESS', stateIds: ['DETAIL'] })
    expect(analysis.summary).toContain('[REDACTED:email]')
    expect(analysis.evidenceArtifactIds).toHaveLength(1)
    expect(analysis.improvementProposalIds).toEqual([])
    expect((await fingerprints.getAll())[0]).toMatchObject({
      occurrenceCount: 1,
      experience: {
        schemaVersion: 1,
        scope: { appPackage: 'com.example.app', stateId: 'DETAIL', moduleId: 'tap_by_vlm_target' },
        diagnosis: { failureClass: 'NO_PROGRESS', disposition: 'retry_bounded' },
        recovery: { failedPolicyIds: ['builtin:navigate-back'] },
        verification: { status: 'unverified', successCount: 0 },
        confidence: 0.55
      }
    })
  })

  it('aggregates repeated failed policies into a skip fingerprint', async () => {
    const { service, fingerprints } = await harness()

    await service.analyzeDeviceRun(run('run-1'), 'run-1-device')
    await service.analyzeDeviceRun(run('run-2'), 'run-2-device')

    expect((await fingerprints.getAll())[0]).toMatchObject({
      occurrenceCount: 2,
      disposition: 'skip_failed_policy',
      failedRecoveryPolicyIds: ['builtin:navigate-back']
    })
  })

  it('routes protected states to a structured human-required fingerprint', async () => {
    const { service, fingerprints } = await harness()
    const protectedRun = run('run-login', 'needs_human', 'Login required before continuing')

    const analysis = await service.analyzeDeviceRun(protectedRun, 'run-login-device')
    const fingerprint = (await fingerprints.getAll())[0]

    expect(analysis.failureClass).toBe('LOGIN_REQUIRED')
    expect(analysis.improvementProposalIds).toEqual([])
    expect(fingerprint.disposition).toBe('human_required')
    expect(fingerprint.experience).toMatchObject({
      diagnosis: { failureClass: 'LOGIN_REQUIRED', disposition: 'human_required' },
      confidence: 0.98
    })
  })

  it.each([
    ['LOGIN_REQUIRED', '\u8bf7\u5148\u767b\u5f55\u540e\u7ee7\u7eed'],
    ['CAPTCHA_REQUIRED', '\u8bf7\u5b8c\u6210\u9a8c\u8bc1\u7801'],
    ['PAYMENT_REQUIRED', '\u8bf7\u786e\u8ba4\u652f\u4ed8'],
    ['ACCOUNT_SECURITY_REQUIRED', '\u9700\u8981\u8eab\u4efd\u9a8c\u8bc1']
  ] as const)('classifies protected Chinese UI text as %s', async (failureClass, message) => {
    const { service } = await harness()
    const protectedRun = run(`run-${failureClass}`, 'needs_human', message)
    const eventData = protectedRun.deviceRuns[0].events[0].data as Record<string, unknown>
    const recognizedState = eventData.recognizedState as Record<string, unknown>
    recognizedState.blockingCondition = 'none'

    const analysis = await service.analyzeDeviceRun(protectedRun, protectedRun.deviceRuns[0].id)

    expect(analysis.failureClass).toBe(failureClass)
  })

  it('summarizes successful traces without creating failure data', async () => {
    const { service, fingerprints, templates } = await harness()

    const analysis = await service.analyzeDeviceRun(run('run-ok', 'completed', 'done'), 'run-ok-device')

    expect(analysis.failureClass).toBeUndefined()
    expect(analysis.assertionHints).toEqual(['Detail page visible'])
    expect(await fingerprints.getAll()).toEqual([])
    expect(analysis.improvementProposalIds).toEqual([])
    expect(analysis.taskFlowLearning).toMatchObject({ status: 'created', usedCorrection: false })
    expect(await templates.getAll()).toEqual([
      expect.objectContaining({ sourceRef: 'run-ok', tags: ['verified', 'deterministic'] })
    ])
    expect(
      ((await templates.getAll())[0].dsl as { steps: Array<{ params: Record<string, unknown> }> }).steps[0].params
    ).toMatchObject({ fallbackToVlm: false })
  })

  it('automatically versions a corrected successful task flow exactly once', async () => {
    const { service, templates, templateRecords } = await harness()
    const completedRun = run('run-corrected', 'completed', 'done')
    completedRun.contextSnapshot!.sourceTemplate = { id: 'template-1', version: '2' }
    templateRecords.push({
      id: 'template-1',
      version: 2,
      name: 'Open detail',
      goal: 'Open detail page',
      dsl: { ...completedRun.task, deviceIds: [] },
      status: 'executable',
      validationIssues: [],
      tags: [],
      skillLinks: [],
      source: 'manual',
      revisions: [],
      createdAt: 1,
      updatedAt: 2
    })
    completedRun.deviceRuns[0].events.push({
      taskId: 'task-1',
      deviceId: 'device-1',
      stepId: 'correction-tap',
      stepName: 'Correction tap',
      status: 'passed',
      attempt: 1,
      message: 'Correction action completed',
      timestamp: 3,
      phase: 'temporary_action',
      recoveryRound: 1,
      parentStepId: 'step-1',
      temporary: true,
      action: { id: 'tap-detail', type: 'tap', x: 540, y: 1200 },
      verification: { status: 'passed', confidence: 1, message: 'Detail opened' },
      data: { observation: { screenSize: { width: 1080, height: 2400 } } }
    })

    const analysis = await service.analyzeDeviceRun(completedRun, 'run-corrected-device')
    expect(analysis.improvementProposalIds).toEqual([])
    expect(analysis.taskFlowLearning).toEqual({
      status: 'versioned',
      templateId: 'template-1',
      sourceVersion: 2,
      appliedVersion: 3,
      usedCorrection: true
    })
    const updated = (await templates.getAll())[0]
    expect(updated.version).toBe(3)
    expect(updated.revisions).toEqual([expect.objectContaining({ version: 2 })])
    expect((updated.dsl as { steps: unknown[] }).steps).toEqual([
      expect.objectContaining({ moduleId: 'tap_percent', params: { x: 0.5, y: 0.5 } })
    ])

    const repeated = await service.analyzeDeviceRun(completedRun, 'run-corrected-device')
    expect(repeated.taskFlowLearning).toMatchObject({ status: 'already_applied', appliedVersion: 3 })
    expect((await templates.getAll())[0].version).toBe(3)
  })

  it('does not overwrite a task flow that changed after execution started', async () => {
    const { service, templateRecords } = await harness()
    const completedRun = run('run-conflict', 'completed', 'done')
    completedRun.contextSnapshot!.sourceTemplate = { id: 'template-1', version: '2' }
    templateRecords.push({
      id: 'template-1',
      version: 3,
      name: 'Open detail',
      goal: 'Open detail page',
      dsl: { ...completedRun.task, deviceIds: [] },
      status: 'executable',
      validationIssues: [],
      tags: [],
      skillLinks: [],
      source: 'manual',
      revisions: [],
      createdAt: 1,
      updatedAt: 3
    })

    const analysis = await service.analyzeDeviceRun(completedRun, 'run-conflict-device')

    expect(analysis.taskFlowLearning).toEqual({
      status: 'skipped_version_conflict',
      templateId: 'template-1',
      sourceVersion: 2,
      appliedVersion: 3,
      usedCorrection: false
    })
    expect(templateRecords[0].version).toBe(3)
  })

  it('waits for every device before updating a shared task flow', async () => {
    const { service, templateRecords } = await harness()
    const batch = run('run-incomplete', 'completed', 'done')
    batch.contextSnapshot!.sourceTemplate = { id: 'template-1', version: '2' }
    batch.deviceRuns.push({
      ...structuredClone(batch.deviceRuns[0]),
      id: 'run-incomplete-device-2',
      deviceId: 'device-2',
      status: 'running'
    })
    batch.deviceIds.push('device-2')
    seedTemplate(templateRecords, batch, 2)

    const analysis = await service.analyzeDeviceRun(batch, 'run-incomplete-device')

    expect(analysis.taskFlowLearning).toBeUndefined()
    expect(templateRecords[0].version).toBe(2)
  })

  it('serializes simultaneous multi-device completion into one task-flow version', async () => {
    const { service, templates, templateRecords } = await harness()
    const batch = run('run-concurrent', 'completed', 'done')
    batch.contextSnapshot!.sourceTemplate = { id: 'template-1', version: '2' }
    batch.deviceRuns.push({
      ...structuredClone(batch.deviceRuns[0]),
      id: 'run-concurrent-device-2',
      deviceId: 'device-2'
    })
    batch.deviceIds.push('device-2')
    seedTemplate(templateRecords, batch, 2)

    const results = await Promise.all([
      service.analyzeDeviceRun(batch, 'run-concurrent-device'),
      service.analyzeDeviceRun(batch, 'run-concurrent-device-2')
    ])

    expect(results.map((analysis) => analysis.taskFlowLearning?.status)).toEqual(['versioned', 'versioned'])
    expect((await templates.getAll())[0]).toMatchObject({
      version: 3,
      revisions: [expect.objectContaining({ version: 2 })]
    })
  })
})
