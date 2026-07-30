import type {
  RpaAppRoleAssetOwnership,
  RpaAppRoleAssetRequirement,
  RpaAppRoleAssetType,
  RpaAppRoleStatus
} from '@renderer/services/rpa/RpaAppRole'
import type { RpaRolePromptKind } from '@renderer/services/rpa/RpaRolePrompt'
import type { TFunction } from 'i18next'

export function rpaRoleStatusLabel(t: TFunction, status: RpaAppRoleStatus): string {
  if (status === 'enabled') return t('rpa_roles.status.enabled')
  if (status === 'disabled') return t('rpa_roles.status.disabled')
  return t('rpa_roles.status.draft')
}

export function rpaRoleReadinessLabel(
  t: TFunction,
  readiness: 'ready' | 'degraded' | 'blocked' | 'draft' | 'loading'
): string {
  if (readiness === 'ready') return t('rpa_roles.readiness.ready')
  if (readiness === 'degraded') return t('rpa_roles.readiness.degraded')
  if (readiness === 'blocked') return t('rpa_roles.readiness.blocked')
  if (readiness === 'draft') return t('rpa_roles.readiness.draft')
  return t('rpa_roles.readiness.loading')
}

export function rpaRoleAssetLabel(t: TFunction, type: RpaAppRoleAssetType | string): string {
  if (type === 'knowledge') return t('rpa_roles.assets.knowledge')
  if (type === 'skill') return t('rpa_roles.assets.skill')
  if (type === 'artifact') return t('rpa_roles.assets.artifact')
  if (type === 'prompt') return t('rpa_roles.assets.prompt')
  if (type === 'provider') return t('rpa_roles.assets.provider')
  return type
}

export function rpaRoleOwnershipLabel(t: TFunction, ownership: RpaAppRoleAssetOwnership | string): string {
  if (ownership === 'owned') return t('rpa_roles.ownership.owned')
  if (ownership === 'shared') return t('rpa_roles.ownership.shared')
  return t('rpa_roles.ownership.linked')
}

export function rpaRoleRequirementLabel(t: TFunction, requirement: RpaAppRoleAssetRequirement | string): string {
  return requirement === 'required' ? t('rpa_roles.requirement.required') : t('rpa_roles.requirement.optional')
}

export function rpaRolePromptKindLabel(t: TFunction, kind: RpaRolePromptKind): string {
  if (kind === 'planner') return t('rpa_roles.prompt_kinds.planner')
  if (kind === 'verification') return t('rpa_roles.prompt_kinds.verification')
  if (kind === 'recovery') return t('rpa_roles.prompt_kinds.recovery')
  if (kind === 'capability') return t('rpa_roles.prompt_kinds.capability')
  return t('rpa_roles.prompt_kinds.system')
}
