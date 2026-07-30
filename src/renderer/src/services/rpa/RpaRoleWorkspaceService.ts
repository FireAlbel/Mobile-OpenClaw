import type { RpaAppRole, RpaAppRoleAssetType } from './RpaAppRole'
import type { RpaBatchRunRecord } from './RpaRunStorage'

export interface RpaRoleWorkspaceCatalogs {
  knowledgeIds: string[]
  skillIds: string[]
  artifactIds: string[]
  promptIds: string[]
}

export interface RpaRoleBrokenBinding {
  assetType: RpaAppRoleAssetType
  assetId: string
  roleId: string
  required: boolean
  reason: string
}

export interface RpaRoleWorkspaceSummary {
  readiness: 'ready' | 'degraded' | 'blocked' | 'draft'
  assetCounts: Record<RpaAppRoleAssetType, number>
  brokenBindings: RpaRoleBrokenBinding[]
  missingSupportingRoleIds: string[]
  recentRuns: RpaBatchRunRecord[]
  activeRunIds: string[]
  migrationState: 'native' | 'compatibility'
}

export function buildRpaRoleWorkspaceSummary(input: {
  role: RpaAppRole
  roles: RpaAppRole[]
  catalogs: RpaRoleWorkspaceCatalogs
  runs: RpaBatchRunRecord[]
}): RpaRoleWorkspaceSummary {
  const counts = emptyAssetCounts()
  const brokenBindings: RpaRoleBrokenBinding[] = []
  const available = catalogSets(input.catalogs)
  for (const binding of input.role.assetBindings.filter(
    (candidate) => candidate.enabled && candidate.ref.assetType !== 'provider'
  )) {
    counts[binding.ref.assetType] += 1
    if (!available[binding.ref.assetType].has(binding.ref.assetId)) {
      brokenBindings.push({
        assetType: binding.ref.assetType,
        assetId: binding.ref.assetId,
        roleId: binding.ref.roleId,
        required: binding.requirement === 'required',
        reason: `${binding.ref.assetType} "${binding.ref.assetId}" is unavailable`
      })
    }
  }
  const knownRoleIds = new Set(input.roles.map((role) => role.id))
  const missingSupportingRoleIds = input.role.supportingRoleIds.filter((roleId) => !knownRoleIds.has(roleId))
  const recentRuns = input.runs
    .filter((run) => run.contextSnapshot?.roleContext?.primaryRole.id === input.role.id)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 10)
  const activeRunIds = recentRuns
    .filter((run) => ['pending', 'running', 'paused', 'needs_human'].includes(run.status))
    .map((run) => run.id)
  const requiredBroken = brokenBindings.some((binding) => binding.required)
  const readiness =
    input.role.status === 'draft'
      ? 'draft'
      : input.role.status !== 'enabled' || requiredBroken || missingSupportingRoleIds.length
        ? 'blocked'
        : brokenBindings.length
          ? 'degraded'
          : 'ready'
  return {
    readiness,
    assetCounts: counts,
    brokenBindings,
    missingSupportingRoleIds,
    recentRuns,
    activeRunIds,
    migrationState: input.role.compatibility ? 'compatibility' : 'native'
  }
}

function emptyAssetCounts(): Record<RpaAppRoleAssetType, number> {
  return { knowledge: 0, skill: 0, artifact: 0, prompt: 0, provider: 0 }
}

function catalogSets(catalogs: RpaRoleWorkspaceCatalogs): Record<RpaAppRoleAssetType, Set<string>> {
  return {
    knowledge: new Set(catalogs.knowledgeIds),
    skill: new Set(catalogs.skillIds),
    artifact: new Set(catalogs.artifactIds),
    prompt: new Set(catalogs.promptIds),
    provider: new Set()
  }
}
