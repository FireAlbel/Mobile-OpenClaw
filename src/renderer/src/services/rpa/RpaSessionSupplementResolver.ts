import type { EffectiveRpaRoleContext } from './EffectiveRpaRoleContextResolver'
import type { RpaRoleVersionReference } from './RpaAppRole'
import type {
  RpaSessionSupplementBinding,
  RpaSessionSupplementLifecycle,
  RpaSessionSupplementRequirement,
  RpaSessionSupplements
} from './RpaSessionSupplement'

export type RpaSessionSupplementIssueCode =
  | 'role_context_non_executable'
  | 'role_version_changed'
  | 'permission_snapshot_role_mismatch'
  | 'policy_override_attempt'
  | 'required_source_unavailable'
  | 'optional_source_unavailable'
  | 'source_version_mismatch'
  | 'source_hash_mismatch'
  | 'provider_not_trusted'
  | 'tool_not_authorized'

export interface RpaSessionSupplementIssue {
  severity: 'error' | 'warning'
  code: RpaSessionSupplementIssueCode
  message: string
  bindingId?: string
  sourceId?: string
}

export interface RpaSessionSupplementSourceAvailability {
  sourceType: RpaSessionSupplementBinding['sourceType']
  sourceId: string
  status: 'ready' | 'degraded' | 'missing' | 'blocked'
  version?: string
  contentHash?: string
  message?: string
}

export interface RpaSessionSupplementPermissions {
  role: RpaRoleVersionReference
  workspaceProviderIds: string[]
  toolAllowlist: Record<string, string[]>
}

export interface EffectiveRpaSessionSupplementBinding {
  bindingId: string
  sourceType: RpaSessionSupplementBinding['sourceType']
  sourceId: string
  sourceVersion?: string
  contentHash?: string
  sourceUri?: string
  scope: RpaSessionSupplementBinding['scope']
  requestId?: string
  requirement: RpaSessionSupplementRequirement
  lifecycle: RpaSessionSupplementLifecycle
  status: 'ready' | 'degraded'
  trust: RpaSessionSupplementBinding['trust']
  retention: RpaSessionSupplementBinding['retention']
}

export interface EffectiveRpaSessionSupplementSnapshot {
  schemaVersion: 1
  sessionId: string
  role: RpaRoleVersionReference
  supplementRevision: number
  requestId?: string
  bindings: EffectiveRpaSessionSupplementBinding[]
  evidenceSources: EffectiveRpaSessionSupplementBinding[]
  providerSelections: Array<{
    providerId: string
    kind: 'retrieval' | 'artifact'
    bindingId: string
  }>
  toolAllowlist: Record<string, string[]>
  issues: RpaSessionSupplementIssue[]
  executable: boolean
  resolvedAt: number
}

export interface RpaSessionSupplementResolverInput {
  effectiveRoleContext: EffectiveRpaRoleContext
  supplements: RpaSessionSupplements
  expectedSupplementRevision: number
  permissions: RpaSessionSupplementPermissions
  requestId?: string
  availability?: RpaSessionSupplementSourceAvailability[]
  now?: () => number
}

export class RpaSessionSupplementResolver {
  resolve(input: RpaSessionSupplementResolverInput): EffectiveRpaSessionSupplementSnapshot {
    if (input.supplements.supplementRevision !== input.expectedSupplementRevision) {
      throw new Error(
        `RPA Session Supplement revision conflict: expected ${input.expectedSupplementRevision}, current ${input.supplements.supplementRevision}`
      )
    }
    const issues: RpaSessionSupplementIssue[] = []
    const expectedRole = input.effectiveRoleContext.roleContext.primaryRole
    const resolvedAt = input.now?.() ?? Date.now()
    const permissionBoundaryValid =
      sameRole(input.supplements.role, expectedRole) && sameRole(input.permissions.role, expectedRole)
    validateRoleBoundary(input, expectedRole, issues)
    detectPolicyOverrides(input.supplements, issues)

    const availability = new Map(
      (input.availability ?? []).map((candidate) => [sourceKey(candidate.sourceType, candidate.sourceId), candidate])
    )
    const selected: EffectiveRpaSessionSupplementBinding[] = []
    const providerSelections: EffectiveRpaSessionSupplementSnapshot['providerSelections'] = []
    const toolAllowlist = new Map<string, Set<string>>()

    for (const binding of input.supplements.bindings) {
      if (binding.scope === 'request' && binding.requestId !== input.requestId) continue
      detectPolicyOverrides(binding, issues, binding)
      if (isRetentionExpired(binding, resolvedAt)) {
        addAvailabilityIssue(binding, issues, 'Retention period expired')
        continue
      }
      if (!isLiveLifecycle(binding.lifecycle)) {
        addAvailabilityIssue(binding, issues, `Supplement lifecycle is ${binding.lifecycle}`)
        continue
      }
      if (!authorizeBinding(binding, input.permissions, issues, toolAllowlist, permissionBoundaryValid)) continue

      const sourceAvailability = availability.get(sourceKey(binding.sourceType, binding.sourceId))
      if (requiresAvailability(binding.sourceType) && !sourceAvailability) {
        addAvailabilityIssue(binding, issues, 'Source availability was not resolved')
        continue
      }
      if (sourceAvailability && ['missing', 'blocked'].includes(sourceAvailability.status)) {
        addAvailabilityIssue(binding, issues, sourceAvailability.message || `Source is ${sourceAvailability.status}`)
        continue
      }
      if (!matchesVersionAndHash(binding, sourceAvailability, issues)) continue

      const status =
        binding.lifecycle === 'degraded' || sourceAvailability?.status === 'degraded' ? 'degraded' : 'ready'
      if (status === 'degraded') {
        issues.push({
          severity: 'warning',
          code: 'optional_source_unavailable',
          bindingId: binding.id,
          sourceId: binding.sourceId,
          message: sourceAvailability?.message || `Supplement source "${binding.sourceId}" is degraded`
        })
      }
      const snapshotBinding = snapshot(binding, status)
      selected.push(snapshotBinding)
      if (binding.sourceType === 'retrieval_provider' || binding.sourceType === 'artifact_provider') {
        providerSelections.push({
          providerId: binding.sourceId,
          kind: binding.sourceType === 'retrieval_provider' ? 'retrieval' : 'artifact',
          bindingId: binding.id
        })
      }
    }

    const result: EffectiveRpaSessionSupplementSnapshot = {
      schemaVersion: 1,
      sessionId: input.supplements.sessionId,
      role: { ...input.supplements.role },
      supplementRevision: input.supplements.supplementRevision,
      requestId: cleanText(input.requestId) || undefined,
      bindings: selected,
      evidenceSources: selected.filter((binding) =>
        ['knowledge', 'artifact', 'temporary_index', 'approved_url'].includes(binding.sourceType)
      ),
      providerSelections,
      toolAllowlist: Object.fromEntries(
        [...toolAllowlist.entries()].map(([providerId, tools]) => [providerId, [...tools].sort()])
      ),
      issues,
      executable: input.effectiveRoleContext.executable && !issues.some((issue) => issue.severity === 'error'),
      resolvedAt
    }
    return deepFreeze(result)
  }
}

function validateRoleBoundary(
  input: RpaSessionSupplementResolverInput,
  expectedRole: RpaRoleVersionReference,
  issues: RpaSessionSupplementIssue[]
): void {
  if (!input.effectiveRoleContext.executable) {
    issues.push({
      severity: 'error',
      code: 'role_context_non_executable',
      message: 'Effective Role Context is not executable'
    })
  }
  if (!sameRole(input.supplements.role, expectedRole)) {
    issues.push({
      severity: 'error',
      code: 'role_version_changed',
      message: `Session Role ${input.supplements.role.id}@${input.supplements.role.version} does not match Effective Role ${expectedRole.id}@${expectedRole.version}`
    })
  }
  if (!sameRole(input.permissions.role, expectedRole)) {
    issues.push({
      severity: 'error',
      code: 'permission_snapshot_role_mismatch',
      message: 'Provider and Tool permissions do not belong to the immutable Session Role version'
    })
  }
}

function authorizeBinding(
  binding: RpaSessionSupplementBinding,
  permissions: RpaSessionSupplementPermissions,
  issues: RpaSessionSupplementIssue[],
  selectedTools: Map<string, Set<string>>,
  permissionBoundaryValid: boolean
): boolean {
  if (!permissionBoundaryValid && binding.sourceType === 'tool_selection') {
    return false
  }
  if (binding.sourceType === 'retrieval_provider' || binding.sourceType === 'artifact_provider') {
    if (!permissions.workspaceProviderIds.includes(binding.sourceId)) {
      issues.push(
        permissionIssue(
          'provider_not_trusted',
          binding,
          `Provider "${binding.sourceId}" is not trusted by the workspace`
        )
      )
      return false
    }
  }
  if (binding.sourceType !== 'tool_selection') return true
  const allowed = new Set(permissions.toolAllowlist[binding.sourceId] ?? [])
  const blocked = binding.toolNames.filter((tool) => !allowed.has(tool))
  if (!binding.toolNames.length || blocked.length) {
    issues.push(
      permissionIssue(
        'tool_not_authorized',
        binding,
        blocked.length
          ? `Tools are not authorized by the immutable Role: ${blocked.join(', ')}`
          : 'Tool selection is empty'
      )
    )
    return false
  }
  const tools = selectedTools.get(binding.sourceId) ?? new Set<string>()
  for (const tool of binding.toolNames) tools.add(tool)
  selectedTools.set(binding.sourceId, tools)
  return true
}

function permissionIssue(
  code: Extract<RpaSessionSupplementIssueCode, 'provider_not_trusted' | 'tool_not_authorized'>,
  binding: RpaSessionSupplementBinding,
  message: string
): RpaSessionSupplementIssue {
  return { severity: 'error', code, bindingId: binding.id, sourceId: binding.sourceId, message }
}

function matchesVersionAndHash(
  binding: RpaSessionSupplementBinding,
  availability: RpaSessionSupplementSourceAvailability | undefined,
  issues: RpaSessionSupplementIssue[]
): boolean {
  if (binding.sourceVersion && binding.sourceVersion !== availability?.version) {
    issues.push({
      severity: severity(binding),
      code: 'source_version_mismatch',
      bindingId: binding.id,
      sourceId: binding.sourceId,
      message: availability?.version
        ? `Supplement source version ${availability.version} does not match bound version ${binding.sourceVersion}`
        : `Supplement source did not report required version ${binding.sourceVersion}`
    })
    return false
  }
  if (binding.contentHash && binding.contentHash !== availability?.contentHash) {
    issues.push({
      severity: severity(binding),
      code: 'source_hash_mismatch',
      bindingId: binding.id,
      sourceId: binding.sourceId,
      message: 'Supplement source content hash changed after binding'
    })
    return false
  }
  return true
}

function addAvailabilityIssue(
  binding: RpaSessionSupplementBinding,
  issues: RpaSessionSupplementIssue[],
  reason: string
): void {
  issues.push({
    severity: severity(binding),
    code: binding.requirement === 'required' ? 'required_source_unavailable' : 'optional_source_unavailable',
    bindingId: binding.id,
    sourceId: binding.sourceId,
    message: `${binding.requirement === 'required' ? 'Required' : 'Optional'} Supplement source "${binding.sourceId}" is unavailable: ${reason}`
  })
}

function detectPolicyOverrides(
  value: unknown,
  issues: RpaSessionSupplementIssue[],
  binding?: RpaSessionSupplementBinding
): void {
  if (!isRecord(value)) return
  const forbidden = [
    'model',
    'models',
    'modelDefaults',
    'modelOverrides',
    'prompt',
    'prompts',
    'systemPrompt',
    'safetyPolicy',
    'providerPermissions',
    'dslSchema'
  ].filter((field) => field in value)
  if (!forbidden.length) return
  issues.push({
    severity: 'error',
    code: 'policy_override_attempt',
    bindingId: binding?.id,
    sourceId: binding?.sourceId,
    message: `Session Supplements cannot override Role policy: ${forbidden.join(', ')}`
  })
}

function snapshot(
  binding: RpaSessionSupplementBinding,
  status: EffectiveRpaSessionSupplementBinding['status']
): EffectiveRpaSessionSupplementBinding {
  return {
    bindingId: binding.id,
    sourceType: binding.sourceType,
    sourceId: binding.sourceId,
    sourceVersion: binding.sourceVersion,
    contentHash: binding.contentHash,
    sourceUri: binding.sourceUri,
    scope: binding.scope,
    requestId: binding.requestId,
    requirement: binding.requirement,
    lifecycle: binding.lifecycle,
    status,
    trust: structuredClone(binding.trust),
    retention: structuredClone(binding.retention)
  }
}

function requiresAvailability(sourceType: RpaSessionSupplementBinding['sourceType']): boolean {
  return ['knowledge', 'artifact', 'temporary_index', 'retrieval_provider', 'artifact_provider'].includes(sourceType)
}

function isLiveLifecycle(lifecycle: RpaSessionSupplementLifecycle): boolean {
  return ['ready', 'degraded', 'retained', 'promotion_proposed', 'promoted'].includes(lifecycle)
}

function isRetentionExpired(binding: RpaSessionSupplementBinding, resolvedAt: number): boolean {
  return (
    binding.retention.mode === 'until' &&
    typeof binding.retention.expiresAt === 'number' &&
    binding.retention.expiresAt <= resolvedAt
  )
}

function severity(binding: RpaSessionSupplementBinding): RpaSessionSupplementIssue['severity'] {
  return binding.requirement === 'required' ? 'error' : 'warning'
}

function sourceKey(sourceType: RpaSessionSupplementBinding['sourceType'], sourceId: string): string {
  return `${sourceType}:${sourceId}`
}

function sameRole(left: RpaRoleVersionReference, right: RpaRoleVersionReference): boolean {
  return left.id === right.id && left.version === right.version
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 256) : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

export const rpaSessionSupplementResolver = new RpaSessionSupplementResolver()
