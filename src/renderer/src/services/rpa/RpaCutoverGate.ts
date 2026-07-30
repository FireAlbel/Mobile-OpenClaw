import { normalizeRpaPrimarySidebarIcons } from '@renderer/config/sidebar'
import type { SidebarIcon } from '@renderer/types/sidebar'

export interface RpaCutoverEvidence {
  migrationComplete: boolean
  dualReadApproved: boolean
  rollbackTested: boolean
  endToEndPassed: boolean
  realDeviceSingleAppPassed: boolean
  realDeviceCrossAppPassed: boolean
  approvedBy?: string
  approvedAt?: number
  evidenceIds: string[]
}
export interface RpaCutoverState {
  schemaVersion: 1
  enabled: boolean
  evidence: RpaCutoverEvidence
  roleLinks: Record<string, string>
  sessionLinks: Record<string, string>
  retentionUntil?: number
  rollbackActive: boolean
}
export interface RpaCutoverStorage {
  load(): Promise<RpaCutoverState | undefined>
  save(state: RpaCutoverState): Promise<void>
}
export interface RpaCompatibilityRetirementDecision {
  readers: boolean
  writers: boolean
  reasons: string[]
  retentionUntil?: number
}

class LocalStorageRpaCutoverStorage implements RpaCutoverStorage {
  private readonly key = 'rpa_role_cutover_state'
  async load(): Promise<RpaCutoverState | undefined> {
    if (typeof localStorage === 'undefined') return undefined
    try {
      const value = localStorage.getItem(this.key)
      return value ? sanitizeCutoverState(JSON.parse(value)) : undefined
    } catch {
      return undefined
    }
  }
  async save(state: RpaCutoverState): Promise<void> {
    if (typeof localStorage !== 'undefined') localStorage.setItem(this.key, JSON.stringify(state))
  }
}

export class RpaCutoverGateService {
  constructor(
    private readonly storage: RpaCutoverStorage = new LocalStorageRpaCutoverStorage(),
    private readonly now: () => number = Date.now
  ) {}
  async getState(): Promise<RpaCutoverState> {
    return (await this.storage.load()) ?? defaultState()
  }
  async enable(
    evidence: RpaCutoverEvidence,
    links: Pick<RpaCutoverState, 'roleLinks' | 'sessionLinks'>,
    retentionDays = 90
  ): Promise<RpaCutoverState> {
    const missing = missingCutoverEvidence(evidence)
    if (missing.length) throw new Error(`RPA cutover gate is not satisfied: ${missing.join(', ')}`)
    const state: RpaCutoverState = {
      schemaVersion: 1,
      enabled: true,
      evidence: {
        ...evidence,
        evidenceIds: [...new Set(evidence.evidenceIds.map((id) => id.trim()).filter(Boolean))],
        approvedAt: evidence.approvedAt ?? this.now()
      },
      roleLinks: { ...links.roleLinks },
      sessionLinks: { ...links.sessionLinks },
      retentionUntil: this.now() + retentionDays * 86_400_000,
      rollbackActive: false
    }
    await this.storage.save(state)
    return state
  }
  async activateRollback(): Promise<RpaCutoverState> {
    const state = await this.getState()
    const next = { ...state, enabled: false, rollbackActive: true }
    await this.storage.save(next)
    return next
  }
  async canRetireCompatibilityReaders(): Promise<boolean> {
    return (await this.getCompatibilityRetirementDecision()).readers
  }
  async canRetireLegacyWriters(): Promise<boolean> {
    return (await this.getCompatibilityRetirementDecision()).writers
  }
  async getCompatibilityRetirementDecision(): Promise<RpaCompatibilityRetirementDecision> {
    const state = await this.getState()
    const reasons: string[] = []
    if (!state.enabled) reasons.push('cutover_not_enabled')
    if (state.rollbackActive) reasons.push('rollback_active')
    if (missingCutoverEvidence(state.evidence).length) reasons.push('cutover_evidence_incomplete')
    if (!state.retentionUntil || state.retentionUntil > this.now()) reasons.push('retention_active')
    const eligible = reasons.length === 0
    return { readers: eligible, writers: eligible, reasons, retentionUntil: state.retentionUntil }
  }
}

export function missingCutoverEvidence(evidence: RpaCutoverEvidence): string[] {
  const missing: string[] = (
    [
      'migrationComplete',
      'dualReadApproved',
      'rollbackTested',
      'endToEndPassed',
      'realDeviceSingleAppPassed',
      'realDeviceCrossAppPassed'
    ] as const
  ).filter((key) => !evidence[key])
  if (!evidence.evidenceIds.some((id) => id.trim())) missing.push('evidenceIds')
  return missing
}
export function resolveRpaLegacyRoute(path: string, state: RpaCutoverState): string | undefined {
  if (!state.enabled || state.rollbackActive) return undefined
  const assistantId = path.match(/^\/assistants\/([^/]+)$/)?.[1]
  if (assistantId)
    return state.roleLinks[assistantId] ? `/rpa-roles/${state.roleLinks[assistantId]}` : '/rpa-roles?migration=review'
  const topicId = path.match(/^\/topics\/([^/]+)$/)?.[1]
  if (topicId)
    return state.sessionLinks[topicId] ? `/?rpaSessionId=${state.sessionLinks[topicId]}` : '/rpa-roles?migration=review'
  if (path === '/knowledge' || path === '/files') return '/rpa-roles'
  return undefined
}
export function filterSidebarForRpaCutover(icons: SidebarIcon[]): SidebarIcon[] {
  return normalizeRpaPrimarySidebarIcons(icons)
}
export function isRpaCutoverEnabledSync(): boolean {
  const state = readRpaCutoverStateSync()
  return state?.enabled === true && !state.rollbackActive
}
export function readRpaCutoverStateSync(): RpaCutoverState | undefined {
  if (typeof localStorage === 'undefined') return undefined
  try {
    return sanitizeCutoverState(JSON.parse(localStorage.getItem('rpa_role_cutover_state') ?? 'null'))
  } catch {
    return undefined
  }
}
function defaultEvidence(): RpaCutoverEvidence {
  return {
    migrationComplete: false,
    dualReadApproved: false,
    rollbackTested: false,
    endToEndPassed: false,
    realDeviceSingleAppPassed: false,
    realDeviceCrossAppPassed: false,
    evidenceIds: []
  }
}
function defaultState(): RpaCutoverState {
  return {
    schemaVersion: 1,
    enabled: false,
    evidence: defaultEvidence(),
    roleLinks: {},
    sessionLinks: {},
    rollbackActive: false
  }
}
function sanitizeCutoverState(value: unknown): RpaCutoverState | undefined {
  if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== 1)
    return undefined
  const state = value as Partial<RpaCutoverState>
  const evidence = state.evidence as Partial<RpaCutoverEvidence> | undefined
  return {
    schemaVersion: 1,
    enabled: state.enabled === true,
    evidence: {
      migrationComplete: evidence?.migrationComplete === true,
      dualReadApproved: evidence?.dualReadApproved === true,
      rollbackTested: evidence?.rollbackTested === true,
      endToEndPassed: evidence?.endToEndPassed === true,
      realDeviceSingleAppPassed: evidence?.realDeviceSingleAppPassed === true,
      realDeviceCrossAppPassed: evidence?.realDeviceCrossAppPassed === true,
      approvedBy: evidence?.approvedBy,
      approvedAt: evidence?.approvedAt,
      evidenceIds: Array.isArray(evidence?.evidenceIds)
        ? evidence.evidenceIds.filter((item): item is string => typeof item === 'string')
        : []
    },
    roleLinks: state.roleLinks && typeof state.roleLinks === 'object' ? state.roleLinks : {},
    sessionLinks: state.sessionLinks && typeof state.sessionLinks === 'object' ? state.sessionLinks : {},
    retentionUntil: state.retentionUntil,
    rollbackActive: state.rollbackActive === true
  }
}
export const rpaCutoverGateService = new RpaCutoverGateService()
