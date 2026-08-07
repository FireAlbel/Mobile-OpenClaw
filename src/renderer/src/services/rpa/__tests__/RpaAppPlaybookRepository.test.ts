import { describe, expect, it } from 'vitest'

import { type RpaAppPlaybook, RpaAppPlaybookRepository, type RpaAppPlaybookStorage } from '../RpaAppPlaybookRepository'

class MemoryStorage implements RpaAppPlaybookStorage {
  playbooks: RpaAppPlaybook[] = []

  async loadPlaybooks() {
    return structuredClone(this.playbooks)
  }

  async savePlaybooks(playbooks: RpaAppPlaybook[]) {
    this.playbooks = structuredClone(playbooks)
  }
}

function definition() {
  return {
    schemaVersion: 1 as const,
    id: 'example-app',
    packageName: 'com.example.app',
    appVersionRange: '>=1.0.0 <3.0.0',
    locale: 'zh-CN',
    compatibilityScope: 'version_range' as const,
    launchBehavior: { homeStateId: 'HOME', softRelaunchPreservesState: true, hardRestartExpectedStateId: 'HOME' },
    states: [
      {
        stateId: 'HOME',
        activityIncludes: ['MainActivity'],
        requiredTexts: ['首页'],
        anyTexts: [],
        excludedTexts: [],
        screenshotSignatures: [],
        evidenceArtifactIds: [],
        blockingCondition: 'none' as const,
        recoveryScope: 'none' as const,
        successCount: 1,
        failureCount: 0
      },
      {
        stateId: 'DETAIL',
        activityIncludes: ['DetailActivity'],
        requiredTexts: ['详情'],
        anyTexts: [],
        excludedTexts: [],
        screenshotSignatures: [],
        evidenceArtifactIds: [],
        blockingCondition: 'none' as const,
        recoveryScope: 'navigate' as const,
        successCount: 1,
        failureCount: 0
      }
    ],
    edges: [
      {
        id: 'detail-home-1',
        fromStateIds: ['DETAIL'],
        toStateId: 'HOME',
        steps: [{ id: 'back', name: 'Back', moduleId: 'press_back', params: {}, continueOnFailure: false }],
        priority: 10,
        status: 'active' as const,
        successCount: 1,
        failureCount: 0,
        confidence: 0.9,
        evidenceArtifactIds: ['artifact-1']
      },
      {
        id: 'detail-home-duplicate',
        fromStateIds: ['DETAIL'],
        toStateId: 'HOME',
        steps: [{ id: 'back-2', name: 'Back again', moduleId: 'press_back', params: {}, continueOnFailure: false }],
        priority: 10,
        status: 'active' as const,
        successCount: 2,
        failureCount: 0,
        confidence: 0.95,
        evidenceArtifactIds: ['artifact-2']
      }
    ],
    disabledHandlerIds: [],
    provenance: { sourceRunIds: [], sourceDeviceRunIds: [], evidenceArtifactIds: [] }
  }
}

describe('RpaAppPlaybookRepository', () => {
  it('resolves compatible playbooks and deterministic paths', async () => {
    const repository = new RpaAppPlaybookRepository(new MemoryStorage(), () => 100)
    const saved = await repository.save({ definition: definition() })

    const resolved = await repository.resolve('com.example.app', '2.1.0', 'zh-CN')
    const path = resolved && repository.findPath(resolved, 'DETAIL', 'HOME')

    expect(resolved?.id).toBe(saved.id)
    expect(path?.map((edge) => edge.toStateId)).toEqual(['HOME'])
  })

  it('creates immutable versions, rejects conflicts, and rolls back', async () => {
    let now = 100
    const repository = new RpaAppPlaybookRepository(new MemoryStorage(), () => now++)
    const first = await repository.save({ definition: definition() })
    const second = await repository.save({
      definition: { ...definition(), locale: '*' },
      expectedVersion: first.version,
      sourceRunId: 'run-1'
    })

    await expect(repository.save({ definition: definition(), expectedVersion: first.version })).rejects.toThrow(
      'version conflict'
    )

    const rolledBack = await repository.rollback(second.id, first.version, second.version)
    expect(rolledBack.version).toBe(3)
    expect(rolledBack.locale).toBe('zh-CN')
    expect(rolledBack.revisions.map((revision) => revision.version)).toEqual([2, 1])
  })

  it('rejects unsafe shell-like playbook actions', async () => {
    const repository = new RpaAppPlaybookRepository(new MemoryStorage())
    const unsafe = definition()
    unsafe.edges[0].steps[0] = {
      id: 'unsafe',
      name: 'Unsafe',
      moduleId: 'shell',
      params: { command: 'pm clear com.example.app' },
      continueOnFailure: false
    }

    await expect(repository.save({ definition: unsafe })).rejects.toThrow('Unsafe App Playbook step')
  })
})
