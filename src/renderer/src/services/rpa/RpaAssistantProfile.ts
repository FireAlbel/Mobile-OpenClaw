import { loggerService } from '@logger'

const logger = loggerService.withContext('RpaAssistantProfile')

export interface RpaKnowledgeBinding {
  knowledgeId: string
  version?: string
  enabled: boolean
  priority: number
  retrievalLimit?: number
  filters?: {
    appPackages?: string[]
    tags?: string[]
  }
}

export interface RpaSkillBinding {
  skillId: string
  versionRange?: string
  enabled: boolean
  allowAutoMatch: boolean
  priority: number
}

export type RpaTemplateBindingUsage = 'recommended' | 'quick_start'

export interface RpaTemplateBinding {
  templateId: string
  version?: string
  enabled: boolean
  priority: number
  usage: RpaTemplateBindingUsage
}

export interface RpaModelReference {
  providerId: string
  modelId: string
}

export interface RpaAssistantModelOverrides {
  planner?: RpaModelReference
  vision?: RpaModelReference
  verification?: RpaModelReference
  recovery?: RpaModelReference
}

export interface RpaLegacyAssistantMigration {
  schemaVersion: 1
  sourceKnowledgeIds: string[]
  importedKnowledgeIds: string[]
  missingKnowledgeIds: string[]
  preservedFieldNames: string[]
  migratedAt: number
}

export interface RpaAssistantProfile {
  assistantId: string
  version: number
  knowledgeBindings: RpaKnowledgeBinding[]
  skillBindings: RpaSkillBinding[]
  templateBindings: RpaTemplateBinding[]
  modelOverrides?: RpaAssistantModelOverrides
  legacyMigration?: RpaLegacyAssistantMigration
  createdAt: number
  updatedAt: number
}

export type RpaAssistantAssetType = 'knowledge' | 'skill' | 'template'

export interface RpaAssistantProfileStorage {
  loadProfiles(): Promise<RpaAssistantProfile[]>
  saveProfiles(profiles: RpaAssistantProfile[]): Promise<void>
}

export function createDefaultRpaAssistantProfile(assistantId: string, now = Date.now()): RpaAssistantProfile {
  const normalizedAssistantId = normalizeId(assistantId)
  if (!normalizedAssistantId) {
    throw new Error('assistantId is required')
  }

  return {
    assistantId: normalizedAssistantId,
    version: 1,
    knowledgeBindings: [],
    skillBindings: [],
    templateBindings: [],
    createdAt: now,
    updatedAt: now
  }
}

export function sanitizeRpaAssistantProfile(value: unknown): RpaAssistantProfile | undefined {
  if (!isRecord(value)) return undefined

  const assistantId = normalizeId(value.assistantId)
  if (!assistantId) return undefined

  const createdAt = normalizeTimestamp(value.createdAt, 0)
  const updatedAt = Math.max(createdAt, normalizeTimestamp(value.updatedAt, createdAt))

  return {
    assistantId,
    version: normalizePositiveInteger(value.version, 1),
    knowledgeBindings: sanitizeKnowledgeBindings(value.knowledgeBindings),
    skillBindings: sanitizeSkillBindings(value.skillBindings),
    templateBindings: sanitizeTemplateBindings(value.templateBindings),
    modelOverrides: sanitizeModelOverrides(value.modelOverrides),
    legacyMigration: sanitizeLegacyMigration(value.legacyMigration),
    createdAt,
    updatedAt
  }
}

export function sanitizeRpaAssistantProfiles(value: unknown): RpaAssistantProfile[] {
  if (!Array.isArray(value)) return []

  const profiles = new Map<string, RpaAssistantProfile>()
  for (const candidate of value) {
    const profile = sanitizeRpaAssistantProfile(candidate)
    if (!profile) continue

    const current = profiles.get(profile.assistantId)
    if (!current || profile.version > current.version || profile.updatedAt > current.updatedAt) {
      profiles.set(profile.assistantId, profile)
    }
  }

  return [...profiles.values()].sort((left, right) => left.assistantId.localeCompare(right.assistantId))
}

export class LocalStorageRpaAssistantProfileStorage implements RpaAssistantProfileStorage {
  private readonly storageKey = 'rpa_assistant_profiles'

  async loadProfiles(): Promise<RpaAssistantProfile[]> {
    if (typeof localStorage === 'undefined') return []

    try {
      const stored = localStorage.getItem(this.storageKey)
      return stored ? sanitizeRpaAssistantProfiles(JSON.parse(stored)) : []
    } catch (error) {
      logger.warn('Failed to load local RPA assistant profiles', { error })
      return []
    }
  }

  async saveProfiles(profiles: RpaAssistantProfile[]): Promise<void> {
    if (typeof localStorage === 'undefined') return

    try {
      localStorage.setItem(this.storageKey, JSON.stringify(sanitizeRpaAssistantProfiles(profiles)))
    } catch (error) {
      logger.warn('Failed to save local RPA assistant profiles', { error })
      throw error
    }
  }
}

export class IpcRpaAssistantProfileStorage implements RpaAssistantProfileStorage {
  constructor(private readonly fallback: RpaAssistantProfileStorage = new LocalStorageRpaAssistantProfileStorage()) {}

  async loadProfiles(): Promise<RpaAssistantProfile[]> {
    if (!window.api?.rpa?.loadAssistantProfiles) {
      return this.fallback.loadProfiles()
    }

    try {
      return sanitizeRpaAssistantProfiles(await window.api.rpa.loadAssistantProfiles())
    } catch (error) {
      logger.warn('Failed to load RPA assistant profiles through IPC', { error })
      return this.fallback.loadProfiles()
    }
  }

  async saveProfiles(profiles: RpaAssistantProfile[]): Promise<void> {
    const sanitized = sanitizeRpaAssistantProfiles(profiles)
    if (!window.api?.rpa?.saveAssistantProfiles) {
      await this.fallback.saveProfiles(sanitized)
      return
    }

    try {
      await window.api.rpa.saveAssistantProfiles(sanitized)
    } catch (error) {
      logger.warn('Failed to save RPA assistant profiles through IPC', { error })
      await this.fallback.saveProfiles(sanitized)
    }
  }
}

export class RpaAssistantProfileRepository {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: RpaAssistantProfileStorage = new IpcRpaAssistantProfileStorage(),
    private readonly now: () => number = Date.now
  ) {}

  async getAll(): Promise<RpaAssistantProfile[]> {
    await this.writeQueue
    return sanitizeRpaAssistantProfiles(await this.storage.loadProfiles())
  }

  async getByAssistantId(assistantId: string): Promise<RpaAssistantProfile | undefined> {
    const normalizedAssistantId = requireId(assistantId, 'assistantId')
    return (await this.getAll()).find((profile) => profile.assistantId === normalizedAssistantId)
  }

  async getOrCreateDefault(assistantId: string): Promise<RpaAssistantProfile> {
    const normalizedAssistantId = requireId(assistantId, 'assistantId')
    const existing = await this.getByAssistantId(normalizedAssistantId)
    if (existing) return existing

    return this.enqueueWrite(async () => {
      const profiles = sanitizeRpaAssistantProfiles(await this.storage.loadProfiles())
      const concurrent = profiles.find((profile) => profile.assistantId === normalizedAssistantId)
      if (concurrent) return concurrent

      const profile = createDefaultRpaAssistantProfile(normalizedAssistantId, this.now())
      await this.storage.saveProfiles([...profiles, profile])
      return profile
    })
  }

  async save(profile: RpaAssistantProfile): Promise<RpaAssistantProfile> {
    const sanitizedInput = sanitizeRpaAssistantProfile(profile)
    if (!sanitizedInput) {
      throw new Error('Invalid RPA assistant profile')
    }

    return this.enqueueWrite(async () => {
      const profiles = sanitizeRpaAssistantProfiles(await this.storage.loadProfiles())
      const existing = profiles.find((item) => item.assistantId === sanitizedInput.assistantId)
      const saved: RpaAssistantProfile = {
        ...sanitizedInput,
        version: existing ? existing.version + 1 : 1,
        createdAt: existing?.createdAt ?? sanitizedInput.createdAt ?? this.now(),
        updatedAt: this.now()
      }
      const nextProfiles = [...profiles.filter((item) => item.assistantId !== saved.assistantId), saved]
      await this.storage.saveProfiles(nextProfiles)
      return saved
    })
  }

  async removeAssistantAssociation(assistantId: string): Promise<boolean> {
    const normalizedAssistantId = requireId(assistantId, 'assistantId')
    return this.enqueueWrite(async () => {
      const profiles = sanitizeRpaAssistantProfiles(await this.storage.loadProfiles())
      const nextProfiles = profiles.filter((profile) => profile.assistantId !== normalizedAssistantId)
      if (nextProfiles.length === profiles.length) return false

      await this.storage.saveProfiles(nextProfiles)
      return true
    })
  }

  async findProfilesReferencingAsset(
    assetType: RpaAssistantAssetType,
    assetId: string
  ): Promise<RpaAssistantProfile[]> {
    const normalizedAssetId = requireId(assetId, 'assetId')
    const profiles = await this.getAll()

    return profiles.filter((profile) => {
      if (assetType === 'knowledge') {
        return profile.knowledgeBindings.some((binding) => binding.knowledgeId === normalizedAssetId)
      }
      if (assetType === 'skill') {
        return profile.skillBindings.some((binding) => binding.skillId === normalizedAssetId)
      }
      return profile.templateBindings.some((binding) => binding.templateId === normalizedAssetId)
    })
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function sanitizeKnowledgeBindings(value: unknown): RpaKnowledgeBinding[] {
  if (!Array.isArray(value)) return []
  const bindings = new Map<string, RpaKnowledgeBinding>()

  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    const knowledgeId = normalizeId(candidate.knowledgeId)
    if (!knowledgeId) continue

    bindings.set(knowledgeId, {
      knowledgeId,
      version: normalizeOptionalString(candidate.version),
      enabled: candidate.enabled !== false,
      priority: clampNumber(candidate.priority, -100, 100, 0),
      retrievalLimit:
        candidate.retrievalLimit === undefined
          ? undefined
          : normalizePositiveInteger(candidate.retrievalLimit, 5, 1, 20),
      filters: sanitizeKnowledgeFilters(candidate.filters)
    })
  }

  return [...bindings.values()]
}

function sanitizeSkillBindings(value: unknown): RpaSkillBinding[] {
  if (!Array.isArray(value)) return []
  const bindings = new Map<string, RpaSkillBinding>()

  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    const skillId = normalizeId(candidate.skillId)
    if (!skillId) continue

    bindings.set(skillId, {
      skillId,
      versionRange: normalizeOptionalString(candidate.versionRange),
      enabled: candidate.enabled !== false,
      allowAutoMatch: candidate.allowAutoMatch !== false,
      priority: clampNumber(candidate.priority, -100, 100, 0)
    })
  }

  return [...bindings.values()]
}

function sanitizeTemplateBindings(value: unknown): RpaTemplateBinding[] {
  if (!Array.isArray(value)) return []
  const bindings = new Map<string, RpaTemplateBinding>()

  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    const templateId = normalizeId(candidate.templateId)
    if (!templateId) continue

    bindings.set(templateId, {
      templateId,
      version: normalizeOptionalString(candidate.version),
      enabled: candidate.enabled !== false,
      priority: clampNumber(candidate.priority, -100, 100, 0),
      usage: candidate.usage === 'quick_start' ? 'quick_start' : 'recommended'
    })
  }

  return [...bindings.values()]
}

function sanitizeKnowledgeFilters(value: unknown): RpaKnowledgeBinding['filters'] {
  if (!isRecord(value)) return undefined
  const appPackages = sanitizeStringList(value.appPackages)
  const tags = sanitizeStringList(value.tags)
  return appPackages.length || tags.length ? { appPackages, tags } : undefined
}

function sanitizeModelOverrides(value: unknown): RpaAssistantModelOverrides | undefined {
  if (!isRecord(value)) return undefined
  const planner = sanitizeModelReference(value.planner)
  const vision = sanitizeModelReference(value.vision)
  const verification = sanitizeModelReference(value.verification)
  const recovery = sanitizeModelReference(value.recovery)
  return planner || vision || verification || recovery ? { planner, vision, verification, recovery } : undefined
}

function sanitizeLegacyMigration(value: unknown): RpaLegacyAssistantMigration | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined

  return {
    schemaVersion: 1,
    sourceKnowledgeIds: sanitizeStringList(value.sourceKnowledgeIds),
    importedKnowledgeIds: sanitizeStringList(value.importedKnowledgeIds),
    missingKnowledgeIds: sanitizeStringList(value.missingKnowledgeIds),
    preservedFieldNames: sanitizeStringList(value.preservedFieldNames),
    migratedAt: normalizeTimestamp(value.migratedAt, 0)
  }
}

function sanitizeModelReference(value: unknown): RpaModelReference | undefined {
  if (!isRecord(value)) return undefined
  const providerId = normalizeId(value.providerId)
  const modelId = normalizeId(value.modelId)
  return providerId && modelId ? { providerId, modelId } : undefined
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(normalizeId).filter((item): item is string => Boolean(item)))]
}

function normalizeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requireId(value: string, field: string): string {
  const normalized = normalizeId(value)
  if (!normalized) throw new Error(`${field} is required`)
  return normalized
}

function normalizeOptionalString(value: unknown): string | undefined {
  return normalizeId(value)
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function normalizePositiveInteger(value: unknown, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const rpaAssistantProfileRepository = new RpaAssistantProfileRepository()
