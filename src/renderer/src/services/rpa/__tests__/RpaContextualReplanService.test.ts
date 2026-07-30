import { describe, expect, it, vi } from 'vitest'

import type { EffectiveRpaContext } from '../EffectiveRpaContextResolver'
import { RpaContextualReplanService } from '../RpaContextualReplanService'
import { type RpaDslSession, RpaDslSessionRepository, type RpaDslSessionStorage } from '../RpaDslSession'
import type { RpaPlannerService } from '../RpaPlannerService'
import type { RpaTask } from '../RpaTypes'

class MemoryStorage implements RpaDslSessionStorage {
  sessions: RpaDslSession[] = []
  async loadSessions() {
    return structuredClone(this.sessions)
  }
  async saveSessions(sessions: RpaDslSession[]) {
    this.sessions = structuredClone(sessions)
  }
}

const roleContext = { primaryRole: { id: 'role-1', version: 2 }, supportingRoles: [], systemCapabilities: [] }
const validator = { validate: (dsl: unknown) => ({ dsl, issues: [], executable: true }) }
const baseTask: RpaTask = {
  id: 'task-1',
  name: 'Open settings',
  goal: 'Open settings',
  deviceIds: [],
  steps: [{ id: 'step-1', name: 'Wait', moduleId: 'wait', params: { durationMs: 100 }, continueOnFailure: false }],
  metadata: {}
}

function effectiveContext(role = roleContext): EffectiveRpaContext {
  return {
    roleContext: role,
    assistantId: 'assistant-1',
    assistantProfileVersion: 1,
    resolvedAt: 1,
    selectedTemplateIds: [],
    assets: { knowledge: [], skills: [], templates: [] },
    modelReferences: {
      planner: { providerId: 'provider-1', modelId: 'planner-1' },
      vision: { providerId: 'provider-1', modelId: 'vision-1' },
      verification: { providerId: 'provider-1', modelId: 'verification-1' },
      recovery: { providerId: 'provider-1', modelId: 'recovery-1' }
    },
    warnings: []
  } as unknown as EffectiveRpaContext
}

async function createSession(repository: RpaDslSessionRepository): Promise<RpaDslSession> {
  let session = await repository.create({ goal: baseTask.goal, primaryRole: roleContext.primaryRole })
  session = await repository.appendRevision(session.id, baseTask, roleContext, validator, {
    expectedSessionVersion: session.version
  })
  return session
}

describe('RpaContextualReplanService', () => {
  it('requires failure evidence and immutable Role provenance', async () => {
    const repository = new RpaDslSessionRepository(new MemoryStorage(), () => 10)
    const session = await createSession(repository)
    const plan = vi.fn()
    const service = new RpaContextualReplanService({ plan } as unknown as Pick<RpaPlannerService, 'plan'>, repository)

    await expect(
      service.replan({ session, objective: 'Recover', effectiveContext: effectiveContext() })
    ).rejects.toThrow('requires validation, execution failure')
    await expect(
      service.replan({
        session,
        objective: 'Recover',
        effectiveContext: effectiveContext({
          ...roleContext,
          primaryRole: { ...roleContext.primaryRole, version: 3 }
        }),
        validationIssues: [{ path: '$.steps[0]', message: 'Invalid target' }]
      })
    ).rejects.toThrow('immutable source revision')
    expect(plan).not.toHaveBeenCalled()
  })

  it('creates a repair revision from validation evidence', async () => {
    let now = 20
    const repository = new RpaDslSessionRepository(new MemoryStorage(), () => ++now)
    const session = await createSession(repository)
    const repairedTask: RpaTask = {
      ...baseTask,
      name: 'Recovered task',
      steps: [{ id: 'step-1', name: 'Screenshot', moduleId: 'screenshot', params: {}, continueOnFailure: false }]
    }
    const plan = vi.fn(async () => ({
      success: true,
      task: repairedTask,
      rawResponse: JSON.stringify(repairedTask),
      repaired: true,
      issues: [],
      assetWarnings: []
    }))
    const service = new RpaContextualReplanService({ plan } as unknown as Pick<RpaPlannerService, 'plan'>, repository)

    const result = await service.replan({
      session,
      objective: 'Use a screenshot before continuing',
      effectiveContext: effectiveContext(),
      validationIssues: [{ path: '$.steps[0]', message: 'Target cannot be verified' }]
    })

    expect(result).toMatchObject({ sourceRevision: 1, evidenceKind: 'validation', repaired: true })
    expect(result.session.revisions.at(-1)).toMatchObject({
      version: 2,
      source: 'repair',
      dsl: repairedTask,
      requestContext: {
        sessionId: session.id,
        baseRevision: 1,
        expectedVersion: session.version,
        provenance: { roleContext }
      }
    })
    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({
        baseTask,
        revisionInstruction: 'Use a screenshot before continuing',
        executionHistory: [
          expect.objectContaining({
            sourceRevision: 1,
            validationIssues: [{ path: '$.steps[0]', message: 'Target cannot be verified' }]
          })
        ]
      })
    )
  })

  it('retains a failed Planner candidate for audit', async () => {
    const repository = new RpaDslSessionRepository(new MemoryStorage(), () => 30)
    const session = await createSession(repository)
    const plan = vi.fn(async () => ({
      success: false,
      rawResponse: '{"invalid":true}',
      repaired: false,
      issues: [{ path: '$.steps', message: 'Required' }],
      assetWarnings: []
    }))
    const service = new RpaContextualReplanService({ plan } as unknown as Pick<RpaPlannerService, 'plan'>, repository)

    await expect(
      service.replan({
        session,
        objective: 'Repair the failed run',
        effectiveContext: effectiveContext(),
        run: {
          id: 'run-1',
          task: baseTask,
          deviceIds: ['device-1'],
          status: 'failed',
          createdAt: 1,
          updatedAt: 2,
          deviceRuns: [
            {
              id: 'device-run-1',
              batchRunId: 'run-1',
              taskId: baseTask.id,
              deviceId: 'device-1',
              status: 'failed',
              error: 'Target not found',
              events: [],
              createdAt: 1,
              updatedAt: 2
            }
          ]
        }
      })
    ).rejects.toThrow('Required')

    const persisted = await repository.getById(session.id)
    expect(persisted?.planningFailures).toEqual([
      expect.objectContaining({ sourceRevision: 1, candidate: '{"invalid":true}' })
    ])
  })
})
