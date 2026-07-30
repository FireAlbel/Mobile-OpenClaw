import { missingCutoverEvidence, type RpaCutoverState } from './RpaCutoverGate'

export type RpaSessionRouteMode = 'session_orchestrator' | 'compatibility' | 'generic_chat' | 'blocked'

export interface RpaSessionRoutingDecision {
  mode: RpaSessionRouteMode
  reason: string
  cutoverEnabled: boolean
  rollbackActive: boolean
}

export function resolveRpaSessionRouting(input: {
  rpaAvailable: boolean
  roleId?: string
  legacyIntentMatched: boolean
  cutoverState?: RpaCutoverState
  previewEnabled?: boolean
}): RpaSessionRoutingDecision {
  const roleScoped = Boolean(input.roleId?.trim())
  const cutoverEnabled =
    input.cutoverState?.enabled === true &&
    input.cutoverState.rollbackActive !== true &&
    missingCutoverEvidence(input.cutoverState.evidence).length === 0
  const rollbackActive = input.cutoverState?.rollbackActive === true

  if (roleScoped && !input.rpaAvailable) {
    return {
      mode: 'blocked',
      reason: 'Role-scoped input cannot fall back to generic chat while RPA is unavailable',
      cutoverEnabled,
      rollbackActive
    }
  }
  if (!input.rpaAvailable) {
    return { mode: 'generic_chat', reason: 'RPA is unavailable for this input', cutoverEnabled, rollbackActive }
  }
  if (roleScoped) {
    return {
      mode: 'session_orchestrator',
      reason: 'Role-scoped input always uses the RPA Session Orchestrator',
      cutoverEnabled,
      rollbackActive
    }
  }
  if (rollbackActive && input.legacyIntentMatched)
    return {
      mode: 'compatibility',
      reason: 'The legacy RPA cutover rollback is active',
      cutoverEnabled: false,
      rollbackActive: true
    }
  if (input.legacyIntentMatched) {
    return {
      mode: 'compatibility',
      reason: 'Legacy RPA intent is routed through the compatibility path',
      cutoverEnabled,
      rollbackActive
    }
  }
  return { mode: 'generic_chat', reason: 'No Role scope or RPA intent is present', cutoverEnabled, rollbackActive }
}
