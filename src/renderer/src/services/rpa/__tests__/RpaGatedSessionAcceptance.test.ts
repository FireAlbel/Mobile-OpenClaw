import { describe, expect, it } from 'vitest'

import { RpaCutoverGateService, type RpaCutoverState, type RpaCutoverStorage } from '../RpaCutoverGate'
import { type RpaDslSession, RpaDslSessionRepository, type RpaDslSessionStorage } from '../RpaDslSession'
import { RpaSessionOrchestrator } from '../RpaSessionOrchestrator'
import { resolveRpaSessionRouting } from '../RpaSessionRoutingPolicy'

class GateStorage implements RpaCutoverStorage {
  state?: RpaCutoverState
  async load() {
    return this.state
  }
  async save(state: RpaCutoverState) {
    this.state = structuredClone(state)
  }
}

class SessionStorage implements RpaDslSessionStorage {
  sessions: RpaDslSession[] = []
  async loadSessions() {
    return structuredClone(this.sessions)
  }
  async saveSessions(sessions: RpaDslSession[]) {
    this.sessions = structuredClone(sessions)
  }
}

const evidence = {
  migrationComplete: true,
  dualReadApproved: true,
  rollbackTested: true,
  endToEndPassed: true,
  realDeviceSingleAppPassed: true,
  realDeviceCrossAppPassed: true,
  evidenceIds: ['desktop-e2e', 'device-single-app', 'device-cross-app']
}

describe('gated RPA Session desktop acceptance', () => {
  it('cuts over Role input, preserves revision evidence, and rolls routing back to compatibility', async () => {
    let now = 100
    const gate = new RpaCutoverGateService(new GateStorage(), () => ++now)
    const repository = new RpaDslSessionRepository(new SessionStorage(), () => ++now)
    const role = { id: 'role-1', version: 2 }
    const context = { primaryRole: role, supportingRoles: [], systemCapabilities: [] }
    const orchestrator = new RpaSessionOrchestrator()
    const cutover = await gate.enable(evidence, { roleLinks: { assistant: role.id }, sessionLinks: {} }, 90)

    expect(
      resolveRpaSessionRouting({
        rpaAvailable: true,
        roleId: role.id,
        legacyIntentMatched: false,
        cutoverState: cutover,
        previewEnabled: false
      }).mode
    ).toBe('session_orchestrator')

    let session = await repository.create({ goal: 'Open settings', primaryRole: role, topicCompatibilityId: 'topic-1' })
    const decision = orchestrator.route(
      { requestId: 'request-1', sessionId: session.id, role, input: 'Open settings' },
      session
    )
    expect(decision.outcome).toBe('create_dsl')
    session = await repository.appendRevision(
      session.id,
      { id: 'task-1', name: 'Open settings', steps: [] },
      context,
      { validate: (dsl) => ({ dsl, issues: [], executable: true }) },
      { expectedSessionVersion: session.version }
    )
    await repository.recordPlanningRequest(session.id, {
      requestId: 'request-1',
      expectedVersion: 1,
      supplementRevision: 0,
      status: 'accepted',
      startedAt: 101,
      finishedAt: 102
    })

    const rollback = await gate.activateRollback()
    expect(
      resolveRpaSessionRouting({
        rpaAvailable: true,
        roleId: role.id,
        legacyIntentMatched: false,
        cutoverState: rollback,
        previewEnabled: true
      }).mode
    ).toBe('session_orchestrator')
    expect(await gate.canRetireLegacyWriters()).toBe(false)
    expect(await repository.getById(session.id)).toMatchObject({
      activeRevisionVersion: 1,
      topicCompatibilityId: 'topic-1',
      planningRequests: [expect.objectContaining({ requestId: 'request-1', status: 'accepted' })]
    })
  })
})
