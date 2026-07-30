import { describe, expect, it } from 'vitest'

import type { RpaDslSession } from '../RpaDslSession'
import {
  RpaSessionOrchestrator,
  shouldRouteInputToRpa,
  shouldUseRpaSessionOrchestrator
} from '../RpaSessionOrchestrator'

const role = { id: 'role-1', version: 2 }

function session(overrides: Partial<RpaDslSession> = {}): RpaDslSession {
  return {
    schemaVersion: 1,
    id: 'session-1',
    version: 1,
    primaryRole: role,
    supportingRoles: [],
    goal: 'Open settings',
    attachments: [],
    observations: [],
    clarifications: [],
    revisions: [],
    status: 'draft',
    interactionState: 'empty',
    interactionEvents: [],
    templateIds: [],
    runIds: [],
    replayRunIds: [],
    improvementIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('RpaSessionOrchestrator', () => {
  const orchestrator = new RpaSessionOrchestrator()

  it('routes the first Role-scoped input to DSL creation', () => {
    const result = orchestrator.route(
      { requestId: 'request-1', sessionId: 'session-1', role, input: 'Open settings' },
      session()
    )

    expect(result).toMatchObject({ outcome: 'create_dsl', stateAfter: 'planning' })
  })

  it('routes follow-up input to revision and clarification continuation', () => {
    const revision = {
      version: 1,
      dsl: {},
      validationIssues: [],
      executable: true,
      roleContext: { primaryRole: role, supportingRoles: [], systemCapabilities: [] },
      createdAt: 1,
      source: 'generated' as const
    }
    expect(
      orchestrator.route(
        { requestId: 'request-2', sessionId: 'session-1', role, input: 'Wait ten seconds' },
        session({ revisions: [revision], activeRevisionVersion: 1, status: 'validated', interactionState: 'ready' })
      ).outcome
    ).toBe('revise_dsl')
    expect(
      orchestrator.route(
        { requestId: 'request-3', sessionId: 'session-1', role, input: 'Use the primary account' },
        session({ status: 'clarification_required', interactionState: 'needs_clarification' })
      ).outcome
    ).toBe('answer_clarification')
  })

  it('routes explicit explanation and run-control commands without treating task goals as controls', () => {
    const active = session({
      revisions: [
        {
          version: 1,
          dsl: {},
          validationIssues: [],
          executable: true,
          roleContext: { primaryRole: role, supportingRoles: [], systemCapabilities: [] },
          createdAt: 1,
          source: 'generated'
        }
      ],
      activeRevisionVersion: 1,
      status: 'executing',
      interactionState: 'executing'
    })

    expect(
      orchestrator.route(
        { requestId: 'request-explain', sessionId: active.id, role, input: 'explain workflow' },
        active
      ).outcome
    ).toBe('explain_dsl')
    expect(
      orchestrator.route({ requestId: 'request-pause', sessionId: active.id, role, input: 'pause run' }, active)
    ).toMatchObject({ outcome: 'control_run', runControlAction: 'pause' })
    expect(
      orchestrator.route(
        { requestId: 'request-revise', sessionId: active.id, role, input: 'Stop the app and open it again' },
        active
      ).outcome
    ).toBe('revise_dsl')
  })

  it('routes an explicit new-task command to an independent planning outcome', () => {
    expect(
      orchestrator.route(
        { requestId: 'request-new', sessionId: 'session-1', role, input: 'new task: open settings' },
        session()
      )
    ).toMatchObject({ outcome: 'create_new_task', stateAfter: 'planning' })
  })

  it('rejects missing or mutable Role provenance', () => {
    expect(orchestrator.route({ requestId: 'request-4', input: 'Open settings' }).outcome).toBe('non_executable')
    expect(
      orchestrator.route(
        { requestId: 'request-5', sessionId: 'session-1', role: { ...role, version: 3 }, input: 'Open settings' },
        session()
      ).reason
    ).toContain('immutable')
  })

  it('keeps ended tasks read-only', () => {
    expect(
      orchestrator.route(
        { requestId: 'request-ended', sessionId: 'session-1', role, input: 'Add another step' },
        session({ status: 'ended', interactionState: 'completed', endedAt: 2 })
      )
    ).toMatchObject({ outcome: 'non_executable', stateAfter: 'completed' })
  })

  it('enables the new input path only for Role-scoped RPA sessions', () => {
    expect(shouldUseRpaSessionOrchestrator({ rpaAvailable: true, roleId: 'role-1' })).toBe(true)
    expect(shouldUseRpaSessionOrchestrator({ rpaAvailable: true })).toBe(false)
    expect(shouldUseRpaSessionOrchestrator({ rpaAvailable: false, roleId: 'role-1' })).toBe(false)
    expect(shouldRouteInputToRpa({ rpaAvailable: true, roleId: 'role-1', legacyIntentMatched: false })).toBe(true)
    expect(shouldRouteInputToRpa({ rpaAvailable: true, legacyIntentMatched: false })).toBe(false)
    expect(shouldRouteInputToRpa({ rpaAvailable: true, legacyIntentMatched: true })).toBe(true)
  })
})
