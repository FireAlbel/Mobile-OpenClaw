import { loggerService } from '@logger'

import type { RpaAssistantProfile, RpaModelReference } from './RpaAssistantProfile'

const logger = loggerService.withContext('RpaAppRole')

export const RPA_APP_ROLE_ASSET_TYPES = ['knowledge', 'skill', 'artifact', 'prompt', 'provider'] as const

export type RpaAppRoleAssetType = (typeof RPA_APP_ROLE_ASSET_TYPES)[number]
export type RpaAppRoleStatus = 'draft' | 'enabled' | 'disabled'
export type RpaAppRoleAssetOwnership = 'owned' | 'linked' | 'shared'
export type RpaAppRoleAssetRequirement = 'required' | 'optional'

export interface RpaQualifiedRoleAssetReference {
  roleId: string
  assetType: RpaAppRoleAssetType
  assetId: string
  version?: string
}

export interface RpaAppRoleAssetBinding {
  ref: RpaQualifiedRoleAssetReference
  ownership: RpaAppRoleAssetOwnership
  requirement: RpaAppRoleAssetRequirement
  enabled: boolean
  priority: number
}

export interface RpaAppRoleModelDefaults {
  planner?: RpaModelReference
  vision?: RpaModelReference
  verification?: RpaModelReference
  recovery?: RpaModelReference
}

export interface RpaAppRoleCompatibilitySource {
  source: 'assistant_profile'
  assistantId: string
  assistantProfileVersion: number
  adapterVersion: 1
}

export interface RpaAppRole {
  schemaVersion: 1
  id: string
  name: string
  description?: string
  appPackages: string[]
  supportedAppVersions: string[]
  status: RpaAppRoleStatus
  version: number
  supportingRoleIds: string[]
  systemCapabilities: string[]
  assetBindings: RpaAppRoleAssetBinding[]
  modelDefaults?: RpaAppRoleModelDefaults
  compatibility?: RpaAppRoleCompatibilitySource
  createdAt: number
  updatedAt: number
}

export interface RpaRoleVersionReference {
  id: string
  version: number
}

export interface RpaRoleContextProvenance {
  primaryRole: RpaRoleVersionReference
  supportingRoles: RpaRoleVersionReference[]
  systemCapabilities: string[]
  compatibility?: RpaAppRoleCompatibilitySource
}

export interface RpaAppRoleStorage {
  loadRoles(): Promise<RpaAppRole[]>
  saveRoles(roles: RpaAppRole[]): Promise<void>
}

export interface RpaAppRoleUsageGuard {
  isRoleActive(roleId: string): Promise<boolean>
}

export interface AdaptAssistantProfileToRoleInput {
  profile: RpaAssistantProfile
  assistantName?: string
  appPackages?: string[]
  supportedAppVersions?: string[]
  systemCapabilities?: string[]
  now?: number
}

export function createDefaultRpaAppRole(id: string, name: string, now = Date.now()): RpaAppRole {
  const roleId = requireId(id, 'id')
  const roleName = requireText(name, 'name')
  return {
    schemaVersion: 1,
    id: roleId,
    name: roleName,
    appPackages: [],
    supportedAppVersions: [],
    status: 'draft',
    version: 1,
    supportingRoleIds: [],
    systemCapabilities: [],
    assetBindings: [],
    createdAt: now,
    updatedAt: now
  }
}

export function adaptAssistantProfileToRpaAppRole(input: AdaptAssistantProfileToRoleInput): RpaAppRole {
  const timestamp = input.now ?? input.profile.updatedAt
  const roleId = assistantProfileRoleId(input.profile.assistantId)
  const assetBindings: RpaAppRoleAssetBinding[] = [
    ...input.profile.knowledgeBindings.map((binding) =>
      compatibilityBinding(roleId, 'knowledge', binding.knowledgeId, binding.version, binding.enabled, binding.priority)
    ),
    ...input.profile.skillBindings.map((binding) =>
      compatibilityBinding(roleId, 'skill', binding.skillId, binding.versionRange, binding.enabled, binding.priority)
    )
  ]
  return sanitizeRpaAppRole({
    schemaVersion: 1,
    id: roleId,
    name: input.assistantName?.trim() || `Assistant ${input.profile.assistantId}`,
    description: 'Compatibility Role generated from an existing RPA Assistant Profile',
    appPackages: input.appPackages,
    supportedAppVersions: input.supportedAppVersions,
    status: 'enabled',
    version: input.profile.version,
    supportingRoleIds: [],
    systemCapabilities: input.systemCapabilities,
    assetBindings,
    modelDefaults: input.profile.modelOverrides,
    compatibility: {
      source: 'assistant_profile',
      assistantId: input.profile.assistantId,
      assistantProfileVersion: input.profile.version,
      adapterVersion: 1
    },
    createdAt: input.profile.createdAt || timestamp,
    updatedAt: Math.max(input.profile.updatedAt, timestamp)
  })!
}

export function sanitizeRpaAppRole(value: unknown): RpaAppRole | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined
  const id = cleanId(value.id)
  const name = cleanText(value.name)
  if (!id || !name) return undefined
  const createdAt = timestamp(value.createdAt)
  return {
    schemaVersion: 1,
    id,
    name,
    description: optionalText(value.description),
    appPackages: stringList(value.appPackages),
    supportedAppVersions: stringList(value.supportedAppVersions),
    status: value.status === 'enabled' || value.status === 'disabled' ? value.status : 'draft',
    version: positiveInteger(value.version),
    supportingRoleIds: stringList(value.supportingRoleIds).filter((roleId) => roleId !== id),
    systemCapabilities: stringList(value.systemCapabilities),
    assetBindings: sanitizeAssetBindings(value.assetBindings),
    modelDefaults: sanitizeModelDefaults(value.modelDefaults),
    compatibility: sanitizeCompatibility(value.compatibility),
    createdAt,
    updatedAt: Math.max(createdAt, timestamp(value.updatedAt))
  }
}

export function sanitizeRpaAppRoles(value: unknown): RpaAppRole[] {
  if (!Array.isArray(value)) return []
  const roles = new Map<string, RpaAppRole>()
  for (const candidate of value) {
    const role = sanitizeRpaAppRole(candidate)
    if (!role) continue
    const current = roles.get(role.id)
    if (!current || role.version > current.version || role.updatedAt > current.updatedAt) roles.set(role.id, role)
  }
  return [...roles.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function sanitizeRpaRoleContextProvenance(value: unknown): RpaRoleContextProvenance | undefined {
  if (!isRecord(value)) return undefined
  const primaryRole = sanitizeRoleReference(value.primaryRole)
  if (!primaryRole) return undefined
  const supportingRoles = Array.isArray(value.supportingRoles)
    ? value.supportingRoles.flatMap((candidate) => {
        const reference = sanitizeRoleReference(candidate)
        return reference && reference.id !== primaryRole.id ? [reference] : []
      })
    : []
  return {
    primaryRole,
    supportingRoles: uniqueRoleReferences(supportingRoles),
    systemCapabilities: stringList(value.systemCapabilities),
    compatibility: sanitizeCompatibility(value.compatibility)
  }
}

class LocalStorageRpaAppRoleStorage implements RpaAppRoleStorage {
  private readonly storageKey = 'rpa_app_roles'

  async loadRoles(): Promise<RpaAppRole[]> {
    if (typeof localStorage === 'undefined') return []
    try {
      const stored = localStorage.getItem(this.storageKey)
      return stored ? sanitizeRpaAppRoles(JSON.parse(stored)) : []
    } catch (error) {
      logger.warn('Failed to load local RPA app roles', { error })
      return []
    }
  }

  async saveRoles(roles: RpaAppRole[]): Promise<void> {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(this.storageKey, JSON.stringify(sanitizeRpaAppRoles(roles)))
  }
}

class IpcRpaAppRoleStorage implements RpaAppRoleStorage {
  constructor(private readonly fallback: RpaAppRoleStorage = new LocalStorageRpaAppRoleStorage()) {}

  async loadRoles(): Promise<RpaAppRole[]> {
    if (!window.api?.rpa?.loadAppRoles) return this.fallback.loadRoles()
    try {
      return sanitizeRpaAppRoles(await window.api.rpa.loadAppRoles())
    } catch (error) {
      logger.warn('Failed to load RPA app roles through IPC', { error })
      return this.fallback.loadRoles()
    }
  }

  async saveRoles(roles: RpaAppRole[]): Promise<void> {
    const sanitized = sanitizeRpaAppRoles(roles)
    if (!window.api?.rpa?.saveAppRoles) return this.fallback.saveRoles(sanitized)
    try {
      await window.api.rpa.saveAppRoles(sanitized)
    } catch (error) {
      logger.warn('Failed to save RPA app roles through IPC', { error })
      await this.fallback.saveRoles(sanitized)
    }
  }
}

export class RpaAppRoleRepository {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: RpaAppRoleStorage = new IpcRpaAppRoleStorage(),
    private readonly now: () => number = Date.now,
    private readonly usageGuard?: RpaAppRoleUsageGuard
  ) {}

  async getAll(): Promise<RpaAppRole[]> {
    await this.writeQueue
    return sanitizeRpaAppRoles(await this.storage.loadRoles())
  }

  async getById(id: string): Promise<RpaAppRole | undefined> {
    const roleId = requireId(id, 'id')
    return (await this.getAll()).find((role) => role.id === roleId)
  }

  async save(role: RpaAppRole): Promise<RpaAppRole> {
    const input = sanitizeRpaAppRole(role)
    if (!input) throw new Error('Invalid RPA app role')
    return this.enqueue(async () => {
      const roles = sanitizeRpaAppRoles(await this.storage.loadRoles())
      const existing = roles.find((candidate) => candidate.id === input.id)
      assertNoSupportingRoleCycle([input, ...roles.filter((candidate) => candidate.id !== input.id)])
      const saved = sanitizeRpaAppRole({
        ...input,
        version: existing ? existing.version + 1 : 1,
        createdAt: existing?.createdAt ?? input.createdAt ?? this.now(),
        updatedAt: this.now()
      })!
      await this.storage.saveRoles([saved, ...roles.filter((candidate) => candidate.id !== saved.id)])
      return saved
    })
  }

  async setStatus(id: string, status: RpaAppRoleStatus): Promise<RpaAppRole> {
    const existing = await this.getById(id)
    if (!existing) throw new Error(`RPA app role not found: ${id}`)
    return this.save({ ...existing, status })
  }

  async duplicate(id: string, newId: string, name?: string): Promise<RpaAppRole> {
    const existing = await this.getById(id)
    if (!existing) throw new Error(`RPA app role not found: ${id}`)
    const duplicateId = requireId(newId, 'newId')
    if (await this.getById(duplicateId)) throw new Error(`RPA app role already exists: ${duplicateId}`)
    const now = this.now()
    return this.save({
      ...existing,
      id: duplicateId,
      name: name?.trim() || `${existing.name} Copy`,
      status: 'draft',
      version: 1,
      supportingRoleIds: existing.supportingRoleIds.filter((roleId) => roleId !== duplicateId),
      assetBindings: existing.assetBindings.map((binding) => ({
        ...binding,
        ref: binding.ref.roleId === existing.id ? { ...binding.ref, roleId: duplicateId } : { ...binding.ref }
      })),
      compatibility: undefined,
      createdAt: now,
      updatedAt: now
    })
  }

  async remove(id: string): Promise<boolean> {
    const roleId = requireId(id, 'id')
    return this.enqueue(async () => {
      const roles = sanitizeRpaAppRoles(await this.storage.loadRoles())
      if (!roles.some((role) => role.id === roleId)) return false
      if (await this.usageGuard?.isRoleActive(roleId)) throw new Error('RPA app role is used by an active run')
      const referencing = roles.filter((role) => role.supportingRoleIds.includes(roleId))
      if (referencing.length)
        throw new Error(`RPA app role is referenced by: ${referencing.map((role) => role.id).join(', ')}`)
      await this.storage.saveRoles(roles.filter((role) => role.id !== roleId))
      return true
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function assistantProfileRoleId(assistantId: string): string {
  return `assistant-role-${requireId(assistantId, 'assistantId')}`
}

function compatibilityBinding(
  roleId: string,
  assetType: RpaAppRoleAssetType,
  assetId: string,
  version: string | undefined,
  enabled: boolean,
  priority = 0
): RpaAppRoleAssetBinding {
  return {
    ref: { roleId, assetType, assetId, version },
    ownership: 'linked',
    requirement: 'optional',
    enabled,
    priority
  }
}

function sanitizeAssetBindings(value: unknown): RpaAppRoleAssetBinding[] {
  if (!Array.isArray(value)) return []
  const bindings = new Map<string, RpaAppRoleAssetBinding>()
  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    const ref = sanitizeQualifiedReference(candidate.ref)
    if (!ref) continue
    if (ref.assetType === 'provider') continue
    bindings.set(JSON.stringify([ref.roleId, ref.assetType, ref.assetId]), {
      ref,
      ownership: candidate.ownership === 'owned' || candidate.ownership === 'shared' ? candidate.ownership : 'linked',
      requirement: candidate.requirement === 'required' ? 'required' : 'optional',
      enabled: candidate.enabled !== false,
      priority: boundedNumber(candidate.priority, -100, 100)
    })
  }
  return [...bindings.values()]
}

function sanitizeQualifiedReference(value: unknown): RpaQualifiedRoleAssetReference | undefined {
  if (!isRecord(value)) return undefined
  const roleId = cleanId(value.roleId)
  const assetId = cleanId(value.assetId)
  const assetType = RPA_APP_ROLE_ASSET_TYPES.includes(value.assetType as RpaAppRoleAssetType)
    ? (value.assetType as RpaAppRoleAssetType)
    : undefined
  return roleId && assetId && assetType
    ? { roleId, assetType, assetId, version: optionalText(value.version) }
    : undefined
}

function sanitizeModelDefaults(value: unknown): RpaAppRoleModelDefaults | undefined {
  if (!isRecord(value)) return undefined
  const planner = sanitizeModelReference(value.planner)
  const vision = sanitizeModelReference(value.vision)
  const verification = sanitizeModelReference(value.verification)
  const recovery = sanitizeModelReference(value.recovery)
  return planner || vision || verification || recovery ? { planner, vision, verification, recovery } : undefined
}

function sanitizeModelReference(value: unknown): RpaModelReference | undefined {
  if (!isRecord(value)) return undefined
  const providerId = cleanId(value.providerId)
  const modelId = cleanId(value.modelId)
  return providerId && modelId ? { providerId, modelId } : undefined
}

function sanitizeCompatibility(value: unknown): RpaAppRoleCompatibilitySource | undefined {
  if (!isRecord(value) || value.source !== 'assistant_profile' || value.adapterVersion !== 1) return undefined
  const assistantId = cleanId(value.assistantId)
  return assistantId
    ? {
        source: 'assistant_profile',
        assistantId,
        assistantProfileVersion: positiveInteger(value.assistantProfileVersion),
        adapterVersion: 1
      }
    : undefined
}

function sanitizeRoleReference(value: unknown): RpaRoleVersionReference | undefined {
  if (!isRecord(value)) return undefined
  const id = cleanId(value.id)
  return id ? { id, version: positiveInteger(value.version) } : undefined
}

function uniqueRoleReferences(values: RpaRoleVersionReference[]): RpaRoleVersionReference[] {
  const references = new Map<string, RpaRoleVersionReference>()
  for (const value of values) references.set(value.id, value)
  return [...references.values()]
}

function assertNoSupportingRoleCycle(roles: RpaAppRole[]): void {
  const graph = new Map(roles.map((role) => [role.id, role.supportingRoleIds]))
  const visited = new Set<string>()
  const active = new Set<string>()
  const path: string[] = []

  const visit = (roleId: string): void => {
    if (active.has(roleId)) {
      const start = path.indexOf(roleId)
      throw new Error(`Supporting Role cycle detected: ${[...path.slice(start), roleId].join(' -> ')}`)
    }
    if (visited.has(roleId)) return
    active.add(roleId)
    path.push(roleId)
    for (const supportingRoleId of graph.get(roleId) ?? []) if (graph.has(supportingRoleId)) visit(supportingRoleId)
    path.pop()
    active.delete(roleId)
    visited.add(roleId)
  }

  for (const roleId of graph.keys()) visit(roleId)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map(cleanId))].filter(Boolean)
}

function requireId(value: unknown, label: string): string {
  const id = cleanId(value)
  if (!id) throw new Error(`${label} is required`)
  return id
}

function requireText(value: unknown, label: string): string {
  const text = cleanText(value)
  if (!text) throw new Error(`${label} is required`)
  return text
}

function cleanId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 200) : ''
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : 0
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export const rpaAppRoleRepository = new RpaAppRoleRepository()
