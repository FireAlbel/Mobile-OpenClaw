import { describe, expect, it } from 'vitest'

import {
  filterSidebarForRpaCutover,
  resolveRpaLegacyRoute,
  RpaCutoverGateService,
  type RpaCutoverState,
  type RpaCutoverStorage
} from '../RpaCutoverGate'

class MemoryStorage implements RpaCutoverStorage {
  state?: RpaCutoverState
  async load() {
    return this.state
  }
  async save(state: RpaCutoverState) {
    this.state = structuredClone(state)
  }
}
const evidence = {
  migrationComplete: true,
  dualReadApproved: true,
  rollbackTested: true,
  endToEndPassed: true,
  realDeviceSingleAppPassed: true,
  realDeviceCrossAppPassed: true,
  evidenceIds: ['report-1']
}

describe('RpaCutoverGateService', () => {
  it('requires every migration and acceptance gate before enabling', async () => {
    const service = new RpaCutoverGateService(new MemoryStorage(), () => 100)
    await expect(
      service.enable({ ...evidence, realDeviceCrossAppPassed: false }, { roleLinks: {}, sessionLinks: {} })
    ).rejects.toThrow('realDeviceCrossAppPassed')
    await expect(service.enable({ ...evidence, evidenceIds: [] }, { roleLinks: {}, sessionLinks: {} })).rejects.toThrow(
      'evidenceIds'
    )
    const state = await service.enable(evidence, { roleLinks: { a1: 'role-1' }, sessionLinks: { t1: 'session-1' } })
    expect(resolveRpaLegacyRoute('/assistants/a1', state)).toBe('/rpa-roles/role-1')
    expect(resolveRpaLegacyRoute('/topics/t1', state)).toBe('/?rpaSessionId=session-1')
    expect(resolveRpaLegacyRoute('/topics/unassigned', state)).toBe('/rpa-roles?migration=review')
  })

  it('keeps compatibility navigation during rollback and retention', async () => {
    const storage = new MemoryStorage()
    const service = new RpaCutoverGateService(storage, () => 100)
    await service.enable(evidence, { roleLinks: {}, sessionLinks: {} }, 1)
    expect(filterSidebarForRpaCutover(['assistants', 'rpa_roles', 'knowledge', 'files', 'store'])).toEqual([
      'assistants',
      'rpa_roles',
      'rpa_templates'
    ])
    const rollback = await service.activateRollback()
    expect(resolveRpaLegacyRoute('/knowledge', rollback)).toBeUndefined()
    expect(await service.canRetireCompatibilityReaders()).toBe(false)
  })

  it('keeps legacy routes readable while removing standalone asset menus from primary navigation', () => {
    expect(filterSidebarForRpaCutover(['assistants', 'knowledge', 'files', 'store', 'rpa_templates'])).toEqual([
      'assistants',
      'rpa_templates',
      'rpa_roles'
    ])
  })

  it('retires compatibility readers and writers only after evidence, rollback, and retention gates', async () => {
    let now = 100
    const service = new RpaCutoverGateService(new MemoryStorage(), () => now)
    const state = await service.enable(evidence, { roleLinks: {}, sessionLinks: {} }, 1)
    expect(state.evidence.evidenceIds).toEqual(['report-1'])
    expect(await service.getCompatibilityRetirementDecision()).toMatchObject({
      readers: false,
      writers: false,
      reasons: ['retention_active']
    })
    now = state.retentionUntil!
    expect(await service.canRetireCompatibilityReaders()).toBe(true)
    expect(await service.canRetireLegacyWriters()).toBe(true)
  })
})
