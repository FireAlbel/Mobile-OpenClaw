import { loggerService } from '@logger'

import {
  type RpaAssistantModelOverrides,
  type RpaKnowledgeBinding,
  type RpaSkillBinding,
  type RpaTemplateBinding,
  sanitizeRpaAssistantProfile
} from './RpaAssistantProfile'

const logger = loggerService.withContext('RpaTopicContextOverride')

export interface RpaTopicAssetExclusions {
  knowledgeIds: string[]
  skillIds: string[]
  templateIds: string[]
}

export interface RpaTopicContextOverride {
  topicId: string
  assistantId: string
  version: number
  knowledgeBindings: RpaKnowledgeBinding[]
  skillBindings: RpaSkillBinding[]
  templateBindings: RpaTemplateBinding[]
  exclusions: RpaTopicAssetExclusions
  appPackages: string[]
  modelOverrides?: RpaAssistantModelOverrides
  createdAt: number
  updatedAt: number
}

export interface RpaTopicContextOverrideStorage {
  loadOverrides(): Promise<RpaTopicContextOverride[]>
  saveOverrides(overrides: RpaTopicContextOverride[]): Promise<void>
}

export function createDefaultRpaTopicContextOverride(
  topicId: string,
  assistantId: string,
  now = Date.now()
): RpaTopicContextOverride {
  const normalizedTopicId = requireId(topicId, 'topicId')
  const normalizedAssistantId = requireId(assistantId, 'assistantId')
  return {
    topicId: normalizedTopicId,
    assistantId: normalizedAssistantId,
    version: 1,
    knowledgeBindings: [],
    skillBindings: [],
    templateBindings: [],
    exclusions: { knowledgeIds: [], skillIds: [], templateIds: [] },
    appPackages: [],
    createdAt: now,
    updatedAt: now
  }
}

export function sanitizeRpaTopicContextOverride(value: unknown): RpaTopicContextOverride | undefined {
  if (!isRecord(value)) return undefined
  const topicId = normalizeId(value.topicId)
  const assistantId = normalizeId(value.assistantId)
  if (!topicId || !assistantId) return undefined

  const createdAt = normalizeTimestamp(value.createdAt, 0)
  const updatedAt = Math.max(createdAt, normalizeTimestamp(value.updatedAt, createdAt))
  const bindings = sanitizeRpaAssistantProfile({
    assistantId,
    version: 1,
    knowledgeBindings: value.knowledgeBindings,
    skillBindings: value.skillBindings,
    templateBindings: value.templateBindings,
    modelOverrides: value.modelOverrides,
    createdAt,
    updatedAt
  })!
  const exclusions = isRecord(value.exclusions) ? value.exclusions : {}

  return {
    topicId,
    assistantId,
    version: normalizePositiveInteger(value.version, 1),
    knowledgeBindings: bindings.knowledgeBindings,
    skillBindings: bindings.skillBindings,
    templateBindings: bindings.templateBindings,
    exclusions: {
      knowledgeIds: sanitizeIds(exclusions.knowledgeIds),
      skillIds: sanitizeIds(exclusions.skillIds),
      templateIds: sanitizeIds(exclusions.templateIds)
    },
    appPackages: sanitizeIds(value.appPackages),
    modelOverrides: bindings.modelOverrides,
    createdAt,
    updatedAt
  }
}

export function sanitizeRpaTopicContextOverrides(value: unknown): RpaTopicContextOverride[] {
  if (!Array.isArray(value)) return []
  const overrides = new Map<string, RpaTopicContextOverride>()
  for (const candidate of value) {
    const override = sanitizeRpaTopicContextOverride(candidate)
    if (!override) continue
    const current = overrides.get(override.topicId)
    if (!current || override.version > current.version || override.updatedAt > current.updatedAt) {
      overrides.set(override.topicId, override)
    }
  }
  return [...overrides.values()].sort((left, right) => left.topicId.localeCompare(right.topicId))
}

export class LocalStorageRpaTopicContextOverrideStorage implements RpaTopicContextOverrideStorage {
  private readonly storageKey = 'rpa_topic_context_overrides'

  async loadOverrides(): Promise<RpaTopicContextOverride[]> {
    if (typeof localStorage === 'undefined') return []
    try {
      const stored = localStorage.getItem(this.storageKey)
      return stored ? sanitizeRpaTopicContextOverrides(JSON.parse(stored)) : []
    } catch (error) {
      logger.warn('Failed to load RPA topic context overrides', { error })
      return []
    }
  }

  async saveOverrides(overrides: RpaTopicContextOverride[]): Promise<void> {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(sanitizeRpaTopicContextOverrides(overrides)))
    } catch (error) {
      logger.warn('Failed to save RPA topic context overrides', { error })
      throw error
    }
  }
}

export class RpaTopicContextOverrideRepository {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: RpaTopicContextOverrideStorage = new LocalStorageRpaTopicContextOverrideStorage(),
    private readonly now: () => number = Date.now
  ) {}

  async getByTopicId(topicId: string): Promise<RpaTopicContextOverride | undefined> {
    await this.writeQueue
    const normalizedTopicId = requireId(topicId, 'topicId')
    return (await this.storage.loadOverrides()).find((override) => override.topicId === normalizedTopicId)
  }

  async getOrCreateDefault(topicId: string, assistantId: string): Promise<RpaTopicContextOverride> {
    const existing = await this.getByTopicId(topicId)
    if (existing) return existing
    return this.enqueueWrite(async () => {
      const overrides = sanitizeRpaTopicContextOverrides(await this.storage.loadOverrides())
      const concurrent = overrides.find((override) => override.topicId === topicId.trim())
      if (concurrent) return concurrent
      const created = createDefaultRpaTopicContextOverride(topicId, assistantId, this.now())
      await this.storage.saveOverrides([...overrides, created])
      return created
    })
  }

  async save(override: RpaTopicContextOverride): Promise<RpaTopicContextOverride> {
    const input = sanitizeRpaTopicContextOverride(override)
    if (!input) throw new Error('Invalid RPA topic context override')
    return this.enqueueWrite(async () => {
      const overrides = sanitizeRpaTopicContextOverrides(await this.storage.loadOverrides())
      const existing = overrides.find((candidate) => candidate.topicId === input.topicId)
      const saved: RpaTopicContextOverride = {
        ...input,
        version: existing ? existing.version + 1 : 1,
        createdAt: existing?.createdAt ?? input.createdAt ?? this.now(),
        updatedAt: this.now()
      }
      await this.storage.saveOverrides([...overrides.filter((item) => item.topicId !== saved.topicId), saved])
      return saved
    })
  }

  async remove(topicId: string): Promise<boolean> {
    const normalizedTopicId = requireId(topicId, 'topicId')
    return this.enqueueWrite(async () => {
      const overrides = sanitizeRpaTopicContextOverrides(await this.storage.loadOverrides())
      const next = overrides.filter((override) => override.topicId !== normalizedTopicId)
      if (next.length === overrides.length) return false
      await this.storage.saveOverrides(next)
      return true
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

function sanitizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(normalizeId).filter((id): id is string => Boolean(id)))]
}

function normalizeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requireId(value: string, field: string): string {
  const normalized = normalizeId(value)
  if (!normalized) throw new Error(`${field} is required`)
  return normalized
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const rpaTopicContextOverrideRepository = new RpaTopicContextOverrideRepository()
