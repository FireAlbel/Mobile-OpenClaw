import { describe, expect, it } from 'vitest'

import type { RpaAppRole } from '../RpaAppRole'
import { createDefaultRpaAssistantProfile } from '../RpaAssistantProfile'
import type { RpaDslSession } from '../RpaDslSession'
import {
  canApproveRpaMigrationCutover,
  type RpaMigrationBackup,
  type RpaMigrationCheckpoint,
  type RpaRoleMigrationAdapter,
  RpaRoleMigrationService
} from '../RpaRoleMigrationService'
import type { RpaBatchRunRecord } from '../RpaRunStorage'

class MemoryAdapter implements RpaRoleMigrationAdapter {
  checkpoint?: RpaMigrationCheckpoint
  roles = new Map<string, RpaAppRole>()
  sessions = new Map<string, RpaDslSession>()
  runs: RpaBatchRunRecord[] = []
  restored = false
  async loadCheckpoint() {
    return this.checkpoint
  }
  async saveCheckpoint(value: RpaMigrationCheckpoint) {
    this.checkpoint = structuredClone(value)
  }
  async createBackup(): Promise<RpaMigrationBackup> {
    return { id: 'backup-1', createdAt: 1, payload: {} }
  }
  async restoreBackup() {
    this.restored = true
    this.sessions.clear()
    this.runs = []
  }
  async getRole(id: string) {
    return this.roles.get(id)
  }
  async saveRole(role: RpaAppRole) {
    this.roles.set(role.id, role)
    return role
  }
  async getSessionByTopicId(topicId: string) {
    return [...this.sessions.values()].find((item) => item.topicCompatibilityId === topicId)
  }
  async saveSession(session: RpaDslSession) {
    this.sessions.set(session.id, session)
    return session
  }
  async captureRpaRuntimeData() {
    return { sessions: structuredClone([...this.sessions.values()]), runs: structuredClone(this.runs), capturedAt: 1 }
  }
  async restoreRpaRuntimeData(snapshot: Awaited<ReturnType<MemoryAdapter['captureRpaRuntimeData']>>) {
    this.sessions = new Map(snapshot.sessions.map((session) => [session.id, structuredClone(session)]))
    this.runs = structuredClone(snapshot.runs)
  }
}

describe('RpaRoleMigrationService', () => {
  it('migrates idempotently, reports ownership, and preserves Topic linkage', async () => {
    const adapter = new MemoryAdapter()
    const service = new RpaRoleMigrationService(adapter, () => 10)
    const profile = {
      ...createDefaultRpaAssistantProfile('a1', 1),
      knowledgeBindings: [{ knowledgeId: 'shared', enabled: true, priority: 0 }]
    }
    const input = {
      assistants: [{ id: 'a1', name: 'Role', profile }],
      topics: [
        {
          id: 't1',
          goal: 'Do task',
          assistantId: 'a1',
          dsl: { name: 'Task' },
          rpaRelevant: true,
          createdAt: 1,
          updatedAt: 2
        }
      ],
      knownAssetIds: ['shared', 'orphan']
    }
    const first = await service.migrate(input)
    expect(first.createdRoleIds).toEqual(['assistant-role-a1'])
    expect(first.createdSessionIds).toEqual(['migrated-topic-t1'])
    expect(first.unassignedAssets).toEqual(['orphan'])
    expect(first.dualReadDifferences).toEqual([])
    const second = await service.migrate(input)
    expect(second.createdRoleIds).toEqual([])
    expect(second.createdSessionIds).toEqual([])
  })

  it('blocks cutover without real-device acceptance and restores backup on rollback', async () => {
    const adapter = new MemoryAdapter()
    const service = new RpaRoleMigrationService(adapter)
    const report = await service.migrate({ assistants: [], topics: [] })
    expect(canApproveRpaMigrationCutover(report)).toBe(false)
    const session = {
      schemaVersion: 1,
      id: 'session-preserved',
      version: 4,
      supportingRoles: [],
      goal: 'Preserve rollback evidence',
      attachments: [],
      observations: [],
      clarifications: [],
      revisions: [],
      status: 'failed',
      interactionState: 'failed',
      interactionEvents: [],
      planningRequests: [
        {
          requestId: 'request-1',
          expectedVersion: 3,
          supplementRevision: 0,
          status: 'stale',
          startedAt: 1,
          finishedAt: 2
        }
      ],
      templateIds: [],
      runIds: ['run-1'],
      replayRunIds: [],
      improvementIds: [],
      createdAt: 1,
      updatedAt: 2
    } satisfies RpaDslSession
    adapter.sessions.set(session.id, session)
    await service.rollback()
    expect(adapter.restored).toBe(true)
    expect(adapter.checkpoint?.phase).toBe('rolled_back')
    expect(adapter.sessions.get(session.id)).toMatchObject({
      version: 4,
      runIds: ['run-1'],
      planningRequests: [expect.objectContaining({ status: 'stale' })]
    })
  })
})
