import { describe, expect, it } from 'vitest'

import { type RpaDslSession, RpaDslSessionRepository, type RpaDslSessionStorage } from '../RpaDslSession'

class MemoryStorage implements RpaDslSessionStorage {
  sessions: RpaDslSession[] = []
  async loadSessions() {
    return structuredClone(this.sessions)
  }
  async saveSessions(sessions: RpaDslSession[]) {
    this.sessions = structuredClone(sessions)
  }
}
const context = { primaryRole: { id: 'role-1', version: 2 }, supportingRoles: [], systemCapabilities: [] }
const validator = { validate: (dsl: unknown) => ({ dsl, issues: [], executable: true }) }
const provenance = {
  assistantId: 'assistant-1',
  assistantProfileVersion: 2,
  generatedAt: 10,
  compiledSkills: [],
  retrievedKnowledge: [],
  activeAssetCounts: { knowledge: 0, skills: 0, templates: 0 },
  models: {
    planner: { providerId: 'provider-1', modelId: 'planner-1' },
    vision: { providerId: 'provider-1', modelId: 'vision-1' },
    verification: { providerId: 'provider-1', modelId: 'verify-1' },
    recovery: { providerId: 'provider-1', modelId: 'recover-1' }
  },
  warnings: [],
  roleContext: context
}

describe('RpaDslSessionRepository', () => {
  it('supports generation, clarification, execution, replay, and improvement links', async () => {
    let now = 10
    const repository = new RpaDslSessionRepository(new MemoryStorage(), () => ++now)
    let session = await repository.create({ goal: 'Open the app', primaryRole: context.primaryRole })
    session = await repository.requestClarification(session.id, session.version, [
      { id: 'account', question: 'Which account?', required: true }
    ])
    expect(session.status).toBe('clarification_required')
    session = await repository.answerClarification(session.id, session.version, 'account', 'Primary')
    session = await repository.appendRevision(session.id, { name: 'Task' }, context, validator, {
      expectedSessionVersion: session.version,
      humanReadableExplanation: 'Generated workflow'
    })
    expect(session.status).toBe('validated')
    session = await repository.recordPlanningFailure(session.id, session.version, {
      requestId: 'request-failed',
      sourceRevision: 1,
      candidate: '{"invalid":true}',
      issues: [{ path: '$.steps', message: 'Required' }]
    })
    expect(session.planningFailures).toEqual([
      expect.objectContaining({ requestId: 'request-failed', candidate: '{"invalid":true}' })
    ])
    session = await repository.link(session.id, session.version, 'template', 'template-1')
    session = await repository.link(session.id, session.version, 'run', 'run-1')
    session = await repository.link(session.id, session.version, 'replay', 'run-0')
    session = await repository.link(session.id, session.version, 'improvement', 'proposal-1')
    session = await repository.setExecutionStatus(session.id, session.version, 'executing')
    expect(session).toMatchObject({
      status: 'executing',
      templateIds: ['template-1'],
      runIds: ['run-1'],
      replayRunIds: ['run-0'],
      improvementIds: ['proposal-1']
    })
  })

  it('blocks missing Roles, stale concurrent revisions, and mutable Role context', async () => {
    const repository = new RpaDslSessionRepository(new MemoryStorage(), () => 10)
    const noRole = await repository.create({ goal: 'Do work' })
    await expect(
      repository.appendRevision(noRole.id, {}, context, validator, { expectedSessionVersion: noRole.version })
    ).rejects.toThrow('selected Role')
    const session = await repository.create({ goal: 'Do work', primaryRole: context.primaryRole })
    await expect(
      repository.appendRevision(session.id, {}, { ...context, primaryRole: { id: 'role-1', version: 3 } }, validator, {
        expectedSessionVersion: session.version
      })
    ).rejects.toThrow('immutable')
    const updated = await repository.requestClarification(session.id, session.version, [])
    await expect(repository.markNonExecutable(session.id, session.version, 'No')).rejects.toThrow(
      `current ${updated.version}`
    )
  })

  it('persists task-session interaction transitions and audit evidence', async () => {
    let now = 20
    const repository = new RpaDslSessionRepository(new MemoryStorage(), () => ++now)
    let session = await repository.create({ goal: 'Open settings', primaryRole: context.primaryRole })

    session = await repository.recordInteraction(session.id, session.version, {
      requestId: 'request-1',
      outcome: 'create_dsl',
      phase: 'received',
      text: 'Open settings',
      stateAfter: 'planning',
      reason: 'Create the first DSL revision'
    })

    expect(session.interactionState).toBe('planning')
    expect(session.interactionEvents[0]).toMatchObject({
      requestId: 'request-1',
      outcome: 'create_dsl',
      phase: 'received',
      stateBefore: 'empty',
      stateAfter: 'planning'
    })

    await expect(
      repository.recordInteraction(session.id, session.version, {
        requestId: 'request-2',
        outcome: 'control_run',
        phase: 'received',
        text: 'Pause',
        stateAfter: 'paused'
      })
    ).rejects.toThrow('Invalid RPA task-session transition')
  })

  it('allows a paused manual-intervention run to return to planning', async () => {
    const repository = new RpaDslSessionRepository(new MemoryStorage(), () => 30)
    let session = await repository.create({ goal: 'Open settings', primaryRole: context.primaryRole })
    session = await repository.appendRevision(session.id, {}, context, validator, {
      expectedSessionVersion: session.version
    })
    session = await repository.setExecutionStatus(session.id, session.version, 'executing')
    session = await repository.setExecutionStatus(session.id, session.version, 'paused')
    session = await repository.setExecutionStatus(session.id, session.version, 'executing')
    session = await repository.setExecutionStatus(session.id, session.version, 'paused')

    session = await repository.recordInteraction(session.id, session.version, {
      requestId: 'request-after-pause',
      outcome: 'revise_dsl',
      phase: 'received',
      text: 'Revise the failed step',
      stateAfter: 'planning'
    })

    expect(session.status).toBe('paused')
    expect(session.interactionState).toBe('planning')
  })

  it('duplicates only the active revision into an independent task', async () => {
    let now = 30
    const repository = new RpaDslSessionRepository(new MemoryStorage(), () => ++now)
    let source = await repository.create({ goal: 'Open settings', primaryRole: context.primaryRole })
    source = await repository.appendRevision(source.id, { name: 'First' }, context, validator, {
      expectedSessionVersion: source.version
    })
    source = await repository.appendRevision(source.id, { name: 'Active' }, context, validator, {
      expectedSessionVersion: source.version
    })
    source = await repository.link(source.id, source.version, 'template', 'template-1')
    source = await repository.link(source.id, source.version, 'run', 'run-1')
    source = await repository.link(source.id, source.version, 'replay', 'run-0')
    source = await repository.link(source.id, source.version, 'improvement', 'proposal-1')

    const duplicate = await repository.duplicate(source.id, source.version, 'topic-copy')

    expect(duplicate.id).not.toBe(source.id)
    expect(duplicate.topicCompatibilityId).toBe('topic-copy')
    expect(duplicate.revisions).toEqual([
      expect.objectContaining({ version: 1, source: 'replay', dsl: { name: 'Active' } })
    ])
    expect(duplicate).toMatchObject({
      status: 'validated',
      activeRevisionVersion: 1,
      templateIds: ['template-1'],
      runIds: [],
      replayRunIds: [],
      improvementIds: [],
      planningFailures: [],
      interactionEvents: []
    })
  })

  it('ends inactive tasks and rejects ending an executing task', async () => {
    const repository = new RpaDslSessionRepository(new MemoryStorage(), () => 40)
    let session = await repository.create({ goal: 'Open settings', primaryRole: context.primaryRole })
    const ended = await repository.end(session.id, session.version)
    expect(ended).toMatchObject({ status: 'ended', interactionState: 'completed', endedAt: 40 })
    await expect(
      repository.appendRevision(ended.id, {}, context, validator, { expectedSessionVersion: ended.version })
    ).rejects.toThrow('read-only')

    session = await repository.create({ goal: 'Run task', primaryRole: context.primaryRole })
    session = await repository.appendRevision(session.id, {}, context, validator, {
      expectedSessionVersion: session.version
    })
    session = await repository.setExecutionStatus(session.id, session.version, 'executing')
    await expect(repository.end(session.id, session.version)).rejects.toThrow('Stop the active run')
  })

  it('persists immutable request context and rejects stale base revisions', async () => {
    const repository = new RpaDslSessionRepository(new MemoryStorage(), () => 50)
    let session = await repository.create({ goal: 'Open settings', primaryRole: context.primaryRole })
    const requestContext = {
      requestId: 'request-1',
      sessionId: session.id,
      baseRevision: undefined,
      expectedVersion: session.version,
      supplementRevision: 0,
      provenance
    }
    session = await repository.appendRevision(session.id, { name: 'First' }, context, validator, {
      expectedSessionVersion: session.version,
      requestContext
    })

    expect(session.revisions[0].requestContext).toMatchObject(requestContext)
    provenance.models.planner.modelId = 'planner-2'
    expect(session.revisions[0].requestContext?.provenance.models.planner.modelId).toBe('planner-1')

    await expect(
      repository.appendRevision(session.id, { name: 'Stale' }, context, validator, {
        expectedSessionVersion: session.version,
        requestContext: {
          ...requestContext,
          expectedVersion: session.version,
          baseRevision: undefined
        }
      })
    ).rejects.toThrow('baseRevision is stale')

    const duplicate = await repository.duplicate(session.id, session.version, 'topic-copy')
    expect(duplicate.revisions[0].requestContext).toMatchObject({
      sessionId: duplicate.id,
      baseRevision: undefined,
      expectedVersion: 1,
      supplementRevision: 0,
      provenance: { models: { planner: { modelId: 'planner-1' } } }
    })
  })

  it('records planning audit without changing the optimistic DSL version', async () => {
    const repository = new RpaDslSessionRepository(new MemoryStorage(), () => 60)
    const session = await repository.create({ goal: 'Open settings', primaryRole: context.primaryRole })
    const pending = await repository.recordPlanningRequest(session.id, {
      requestId: 'request-1',
      expectedVersion: session.version,
      supplementRevision: 0,
      status: 'pending'
    })
    const accepted = await repository.recordPlanningRequest(session.id, {
      requestId: 'request-1',
      expectedVersion: session.version,
      supplementRevision: 0,
      status: 'accepted'
    })

    expect(pending.version).toBe(session.version)
    expect(accepted.version).toBe(session.version)
    expect(accepted.planningRequests).toEqual([
      expect.objectContaining({ requestId: 'request-1', status: 'accepted', startedAt: 60, finishedAt: 60 })
    ])
  })
})
