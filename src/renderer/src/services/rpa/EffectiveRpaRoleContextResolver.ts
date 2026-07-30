import type { Model } from '@renderer/types'
import semver from 'semver'

import {
  type EffectiveRpaContext,
  resolveEffectiveRpaContext,
  type RpaExecutionContextOverride
} from './EffectiveRpaContextResolver'
import {
  type RpaAppRole,
  type RpaAppRoleAssetBinding,
  type RpaAppRoleAssetType,
  type RpaAppRoleModelDefaults,
  type RpaQualifiedRoleAssetReference,
  type RpaRoleContextProvenance
} from './RpaAppRole'
import type { RpaAssistantAssetCatalogs } from './RpaAssistantBindingService'
import { createDefaultRpaAssistantProfile, type RpaAssistantProfile } from './RpaAssistantProfile'
import type { RpaRolePrompt } from './RpaRolePrompt'
import type { RpaTopicContextOverride } from './RpaTopicContextOverride'

export type RpaRoleContextIssueCode =
  | 'supporting_role_missing'
  | 'cross_role_reference_not_permitted'
  | 'required_asset_missing'
  | 'required_asset_unavailable'
  | 'required_asset_version_conflict'
  | 'optional_asset_missing'
  | 'optional_asset_version_conflict'
  | 'model_override_shadowed'

export interface RpaRoleContextIssue {
  severity: 'error' | 'warning'
  code: RpaRoleContextIssueCode
  message: string
  roleId?: string
  asset?: RpaQualifiedRoleAssetReference
}

export interface RpaRoleAssetAvailability {
  assetType: RpaAppRoleAssetType
  assetId: string
  version?: string
  status: 'ready' | 'disabled' | 'missing' | 'error'
}

export interface RpaResolvedRoleAssetBinding extends RpaAppRoleAssetBinding {
  sourceRoleId: string
  catalogVersion?: string
}

export type RpaResolvedRoleAssets = Record<RpaAppRoleAssetType, RpaResolvedRoleAssetBinding[]>

export interface EffectiveRpaRoleContext extends EffectiveRpaContext {
  roleContext: RpaRoleContextProvenance
  roleAssets: RpaResolvedRoleAssets
  rolePrompts: RpaResolvedRolePrompt[]
  roleIssues: RpaRoleContextIssue[]
}

export interface RpaResolvedRolePrompt extends RpaRolePrompt {
  sourceRoleId: string
  ownership: RpaAppRoleAssetBinding['ownership']
  requirement: RpaAppRoleAssetBinding['requirement']
}

export interface EffectiveRpaRoleContextResolverInput {
  topicId: string
  primaryRole: RpaAppRole
  supportingRoles?: RpaAppRole[]
  compatibilityProfile?: RpaAssistantProfile
  catalogs: RpaAssistantAssetCatalogs
  promptCatalog?: RpaRolePrompt[]
  assetAvailability?: RpaRoleAssetAvailability[]
  defaultModel: Model
  availableModels: Model[]
  topicOverride?: RpaTopicContextOverride
  systemDefaults?: RpaAssistantProfile
  executionOverride?: RpaExecutionContextOverride
  now?: () => number
}

export function resolveEffectiveRpaRoleContext(input: EffectiveRpaRoleContextResolverInput): EffectiveRpaRoleContext {
  const roles = selectedRoles(input.primaryRole, input.supportingRoles ?? [])
  const roleIssues = validateRoles(input.primaryRole, roles)
  const resolvedBindings = resolveBindings(
    roles,
    input.catalogs,
    input.promptCatalog ?? [],
    input.assetAvailability ?? [],
    roleIssues
  )
  const profile = createCompatibilityProfile(input, roles, resolvedBindings, roleIssues)
  const roleAppPackages = uniqueStrings(roles.flatMap((role) => role.appPackages))
  const appPackages = input.executionOverride?.appPackages ?? input.topicOverride?.appPackages ?? roleAppPackages
  const legacyContext = resolveEffectiveRpaContext({
    topicId: input.topicId,
    profile,
    catalogs: input.catalogs,
    defaultModel: input.defaultModel,
    availableModels: input.availableModels,
    topicOverride: input.topicOverride,
    systemDefaults: input.systemDefaults,
    executionOverride: { ...input.executionOverride, appPackages },
    now: input.now
  })
  const roleContext: RpaRoleContextProvenance = {
    primaryRole: { id: input.primaryRole.id, version: input.primaryRole.version },
    supportingRoles: roles.slice(1).map((role) => ({ id: role.id, version: role.version })),
    systemCapabilities: uniqueStrings(roles.flatMap((role) => role.systemCapabilities)),
    compatibility: input.primaryRole.compatibility
  }
  return deepFreeze({
    ...legacyContext,
    roleContext,
    roleAssets: groupResolvedAssets(resolvedBindings),
    rolePrompts: resolveRolePrompts(resolvedBindings, input.promptCatalog ?? [], roles),
    roleIssues,
    executable: legacyContext.executable && !roleIssues.some((issue) => issue.severity === 'error')
  })
}

function selectedRoles(primaryRole: RpaAppRole, supportingRoles: RpaAppRole[]): RpaAppRole[] {
  const rolesById = new Map(supportingRoles.map((role) => [role.id, role]))
  return [
    primaryRole,
    ...primaryRole.supportingRoleIds
      .filter((roleId, index, roleIds) => roleId !== primaryRole.id && roleIds.indexOf(roleId) === index)
      .map((roleId) => rolesById.get(roleId))
      .filter((role): role is RpaAppRole => Boolean(role))
  ]
}

function validateRoles(primaryRole: RpaAppRole, roles: RpaAppRole[]): RpaRoleContextIssue[] {
  const issues: RpaRoleContextIssue[] = []
  const roleIds = new Set(roles.map((role) => role.id))
  for (const roleId of primaryRole.supportingRoleIds) {
    if (!roleIds.has(roleId)) {
      issues.push({
        severity: 'error',
        code: 'supporting_role_missing',
        roleId,
        message: `Supporting Role "${roleId}" is required but was not resolved`
      })
    }
  }
  return issues
}

function resolveBindings(
  roles: RpaAppRole[],
  catalogs: RpaAssistantAssetCatalogs,
  promptCatalog: RpaRolePrompt[],
  availability: RpaRoleAssetAvailability[],
  issues: RpaRoleContextIssue[]
): RpaResolvedRoleAssetBinding[] {
  const selectedRoleIds = new Set(roles.map((role) => role.id))
  const candidates = roles.flatMap((role) =>
    role.assetBindings
      .filter((binding) => binding.enabled && binding.ref.assetType !== 'provider')
      .map((binding) => ({ ...binding, sourceRoleId: role.id }))
  )
  const groups = new Map<string, RpaResolvedRoleAssetBinding[]>()
  for (const binding of candidates) {
    if (!selectedRoleIds.has(binding.ref.roleId) && binding.ownership !== 'shared') {
      issues.push({
        severity: 'error',
        code: 'cross_role_reference_not_permitted',
        roleId: binding.sourceRoleId,
        asset: binding.ref,
        message: `Role "${binding.sourceRoleId}" cannot use ${binding.ref.assetType} "${binding.ref.assetId}" from unresolved Role "${binding.ref.roleId}"`
      })
      continue
    }
    const key = JSON.stringify([binding.ref.assetType, binding.ref.assetId])
    groups.set(key, [...(groups.get(key) ?? []), binding])
  }

  const resolved: RpaResolvedRoleAssetBinding[] = []
  for (const bindings of groups.values()) {
    const winner = resolveBindingConflict(bindings, issues)
    const catalogAsset = findCatalogAsset(winner.ref, catalogs, promptCatalog, availability)
    if (!catalogAsset) {
      issues.push({
        severity: winner.requirement === 'required' ? 'error' : 'warning',
        code: winner.requirement === 'required' ? 'required_asset_missing' : 'optional_asset_missing',
        roleId: winner.sourceRoleId,
        asset: winner.ref,
        message: `${winner.requirement === 'required' ? 'Required' : 'Optional'} ${winner.ref.assetType} "${winner.ref.assetId}" is missing`
      })
    } else {
      winner.catalogVersion = catalogAsset.version
      if (winner.requirement === 'required' && ['disabled', 'missing', 'error'].includes(catalogAsset.status)) {
        issues.push({
          severity: 'error',
          code: 'required_asset_unavailable',
          roleId: winner.sourceRoleId,
          asset: winner.ref,
          message: `Required ${winner.ref.assetType} "${winner.ref.assetId}" is ${catalogAsset.status}`
        })
      }
      if (winner.ref.version && catalogAsset.version && !versionMatches(winner.ref, catalogAsset.version)) {
        issues.push({
          severity: winner.requirement === 'required' ? 'error' : 'warning',
          code:
            winner.requirement === 'required' ? 'required_asset_version_conflict' : 'optional_asset_version_conflict',
          roleId: winner.sourceRoleId,
          asset: winner.ref,
          message: `${winner.ref.assetType} "${winner.ref.assetId}" version ${catalogAsset.version} does not satisfy ${winner.ref.version}`
        })
      }
    }
    resolved.push(winner)
  }
  return resolved
}

function resolveBindingConflict(
  bindings: RpaResolvedRoleAssetBinding[],
  issues: RpaRoleContextIssue[]
): RpaResolvedRoleAssetBinding {
  const versions = uniqueStrings(bindings.map((binding) => binding.ref.version ?? '*'))
  const required = bindings.filter((binding) => binding.requirement === 'required')
  const winner = required[0] ?? bindings[0]
  if (versions.length > 1) {
    const requiredVersions = uniqueStrings(required.map((binding) => binding.ref.version ?? '*'))
    const isRequiredConflict = requiredVersions.length > 1
    issues.push({
      severity: isRequiredConflict ? 'error' : 'warning',
      code: isRequiredConflict ? 'required_asset_version_conflict' : 'optional_asset_version_conflict',
      roleId: winner.sourceRoleId,
      asset: winner.ref,
      message: `${winner.ref.assetType} "${winner.ref.assetId}" has conflicting Role versions: ${versions.join(', ')}`
    })
  }
  return { ...winner, ref: { ...winner.ref } }
}

function createCompatibilityProfile(
  input: EffectiveRpaRoleContextResolverInput,
  roles: RpaAppRole[],
  bindings: RpaResolvedRoleAssetBinding[],
  issues: RpaRoleContextIssue[]
): RpaAssistantProfile {
  const base =
    input.compatibilityProfile ??
    createDefaultRpaAssistantProfile(input.primaryRole.compatibility?.assistantId ?? input.primaryRole.id, 0)
  const knowledge = new Map(base.knowledgeBindings.map((binding) => [binding.knowledgeId, binding]))
  const skills = new Map(base.skillBindings.map((binding) => [binding.skillId, binding]))
  for (const binding of bindings) {
    if (binding.ref.assetType === 'knowledge') {
      knowledge.set(binding.ref.assetId, {
        knowledgeId: binding.ref.assetId,
        version: binding.ref.version,
        enabled: true,
        priority: binding.priority
      })
    } else if (binding.ref.assetType === 'skill') {
      skills.set(binding.ref.assetId, {
        skillId: binding.ref.assetId,
        versionRange: binding.ref.version,
        enabled: true,
        allowAutoMatch: true,
        priority: binding.priority
      })
    }
  }
  const modelDefaults = mergeRoleModelDefaults(input.primaryRole, roles.slice(1), issues)
  return {
    ...base,
    knowledgeBindings: [...knowledge.values()],
    skillBindings: [...skills.values()],
    templateBindings: [],
    modelOverrides: { ...base.modelOverrides, ...modelDefaults }
  }
}

function mergeRoleModelDefaults(
  primaryRole: RpaAppRole,
  supportingRoles: RpaAppRole[],
  issues: RpaRoleContextIssue[]
): RpaAppRoleModelDefaults {
  const merged: RpaAppRoleModelDefaults = {}
  for (const role of [...supportingRoles, primaryRole]) {
    for (const capability of ['planner', 'vision', 'verification', 'recovery'] as const) {
      const next = role.modelDefaults?.[capability]
      if (!next) continue
      const current = merged[capability]
      if (current && (current.providerId !== next.providerId || current.modelId !== next.modelId)) {
        issues.push({
          severity: 'warning',
          code: 'model_override_shadowed',
          roleId: role.id,
          message: `${capability} model ${current.providerId}/${current.modelId} is shadowed by Role "${role.id}"`
        })
      }
      merged[capability] = next
    }
  }
  return merged
}

function findCatalogAsset(
  ref: RpaQualifiedRoleAssetReference,
  catalogs: RpaAssistantAssetCatalogs,
  promptCatalog: RpaRolePrompt[],
  availability: RpaRoleAssetAvailability[]
): { version?: string; status: string } | undefined {
  if (ref.assetType === 'knowledge') return catalogs.knowledge.find((asset) => asset.id === ref.assetId)
  if (ref.assetType === 'skill') return catalogs.skills.find((asset) => asset.id === ref.assetId)
  if (ref.assetType === 'prompt') {
    const prompt = promptCatalog.find(
      (candidate) =>
        candidate.id === ref.assetId &&
        candidate.roleId === ref.roleId &&
        (!ref.version || candidate.version === ref.version)
    )
    if (prompt) return { version: prompt.version, status: prompt.status === 'enabled' ? 'ready' : 'disabled' }
  }
  return availability.find((asset) => asset.assetType === ref.assetType && asset.assetId === ref.assetId)
}

function resolveRolePrompts(
  bindings: RpaResolvedRoleAssetBinding[],
  promptCatalog: RpaRolePrompt[],
  roles: RpaAppRole[]
): RpaResolvedRolePrompt[] {
  const roleRank = new Map(roles.map((role, index) => [role.id, roles.length - index]))
  return bindings
    .filter((binding) => binding.ref.assetType === 'prompt')
    .flatMap((binding) => {
      const prompt = promptCatalog
        .filter(
          (candidate) =>
            candidate.id === binding.ref.assetId &&
            candidate.roleId === binding.ref.roleId &&
            candidate.status === 'enabled' &&
            (!binding.ref.version || candidate.version === binding.ref.version)
        )
        .sort((left, right) => right.updatedAt - left.updatedAt || right.version.localeCompare(left.version))[0]
      if (!prompt) return []
      return [
        {
          ...prompt,
          sourceRoleId: binding.sourceRoleId,
          ownership: binding.ownership,
          requirement: binding.requirement,
          priority: (roleRank.get(binding.sourceRoleId) ?? 0) * 10_000 + binding.priority * 100 + prompt.priority
        }
      ]
    })
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
}

function versionMatches(ref: RpaQualifiedRoleAssetReference, version: string): boolean {
  if (!ref.version) return true
  if (ref.assetType === 'skill') {
    const validVersion = semver.valid(version)
    const validRange = semver.validRange(ref.version)
    if (validVersion && validRange) return semver.satisfies(validVersion, validRange)
  }
  return version === ref.version
}

function groupResolvedAssets(bindings: RpaResolvedRoleAssetBinding[]): RpaResolvedRoleAssets {
  const grouped: RpaResolvedRoleAssets = {
    knowledge: [],
    skill: [],
    artifact: [],
    prompt: [],
    provider: []
  }
  for (const binding of bindings) grouped[binding.ref.assetType].push(binding)
  return grouped
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}
