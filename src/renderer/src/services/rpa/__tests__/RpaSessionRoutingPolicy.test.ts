import { describe, expect, it } from 'vitest'

import type { RpaCutoverState } from '../RpaCutoverGate'
import { resolveRpaSessionRouting } from '../RpaSessionRoutingPolicy'

function cutover(overrides: Partial<RpaCutoverState> = {}): RpaCutoverState {
  return {
    schemaVersion: 1,
    enabled: true,
    evidence: {
      migrationComplete: true,
      dualReadApproved: true,
      rollbackTested: true,
      endToEndPassed: true,
      realDeviceSingleAppPassed: true,
      realDeviceCrossAppPassed: true,
      evidenceIds: ['acceptance-1']
    },
    roleLinks: {},
    sessionLinks: {},
    rollbackActive: false,
    ...overrides
  }
}

describe('resolveRpaSessionRouting', () => {
  it('always uses the Session Orchestrator for Role-scoped conversations', () => {
    expect(
      resolveRpaSessionRouting({
        rpaAvailable: true,
        roleId: 'role-1',
        legacyIntentMatched: false,
        cutoverState: cutover()
      }).mode
    ).toBe('session_orchestrator')
    expect(
      resolveRpaSessionRouting({
        rpaAvailable: true,
        roleId: 'role-1',
        legacyIntentMatched: false,
        cutoverState: cutover({ enabled: false }),
        previewEnabled: true
      }).mode
    ).toBe('session_orchestrator')
  })

  it('does not restore the legacy conversation path for Role-scoped conversations', () => {
    expect(
      resolveRpaSessionRouting({
        rpaAvailable: true,
        roleId: 'role-1',
        legacyIntentMatched: false,
        cutoverState: cutover({ enabled: false }),
        previewEnabled: false
      }).mode
    ).toBe('session_orchestrator')
    expect(
      resolveRpaSessionRouting({
        rpaAvailable: true,
        roleId: 'role-1',
        legacyIntentMatched: false,
        cutoverState: cutover({ enabled: false, rollbackActive: true }),
        previewEnabled: true
      })
    ).toMatchObject({ mode: 'session_orchestrator', rollbackActive: true })
    expect(
      resolveRpaSessionRouting({
        rpaAvailable: true,
        roleId: 'role-1',
        legacyIntentMatched: false,
        cutoverState: cutover({
          evidence: { ...cutover().evidence, endToEndPassed: false }
        }),
        previewEnabled: false
      }).mode
    ).toBe('session_orchestrator')
  })

  it('blocks Role-scoped generic fallback when RPA is unavailable', () => {
    expect(
      resolveRpaSessionRouting({
        rpaAvailable: false,
        roleId: 'role-1',
        legacyIntentMatched: false,
        cutoverState: cutover()
      }).mode
    ).toBe('blocked')
    expect(resolveRpaSessionRouting({ rpaAvailable: false, legacyIntentMatched: false }).mode).toBe('generic_chat')
  })
})
