import type { Assistant } from '@renderer/types'

import type { RpaAssistantProfileRepository } from './RpaAssistantProfile'
import {
  createDefaultRpaAssistantProfile,
  type RpaAssistantProfile,
  rpaAssistantProfileRepository
} from './RpaAssistantProfile'

const LEGACY_MIGRATION_SCHEMA_VERSION = 1 as const

export interface RpaAssistantProfileMigrationOptions {
  availableKnowledgeIds?: Iterable<string>
}

export interface RpaAssistantProfileMigrationResult {
  profile: RpaAssistantProfile
  changed: boolean
  created: boolean
  importedKnowledgeIds: string[]
  missingKnowledgeIds: string[]
  preservedLegacyFields: string[]
}

export interface RpaLegacyAssistantCompatibilityExport {
  schemaVersion: 1
  assistant: Assistant & Record<string, unknown>
  migration?: RpaAssistantProfile['legacyMigration']
}

export class RpaAssistantProfileMigrationService {
  private migrationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly repository: RpaAssistantProfileRepository = rpaAssistantProfileRepository,
    private readonly now: () => number = Date.now
  ) {}

  getOrMigrateAssistant(
    assistant: Assistant,
    options: RpaAssistantProfileMigrationOptions = {}
  ): Promise<RpaAssistantProfileMigrationResult> {
    return this.enqueueMigration(async () => {
      const existing = await this.repository.getByAssistantId(assistant.id)
      const baseProfile = existing ?? createDefaultRpaAssistantProfile(assistant.id, this.now())
      const migration = migrateLegacyAssistantProfile(baseProfile, assistant, options, this.now())

      if (!migration.changed) {
        return { ...migration, created: false }
      }

      const saved = await this.repository.save(migration.profile)
      return { ...migration, profile: saved, created: !existing }
    })
  }

  private enqueueMigration<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.migrationQueue.then(operation, operation)
    this.migrationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export function migrateLegacyAssistantProfile(
  profile: RpaAssistantProfile,
  assistant: Assistant,
  options: RpaAssistantProfileMigrationOptions = {},
  now = Date.now()
): Omit<RpaAssistantProfileMigrationResult, 'created'> {
  if (profile.assistantId !== assistant.id) {
    throw new Error('Assistant and RPA profile IDs do not match')
  }

  const sourceKnowledgeIds = uniqueIds(assistant.knowledge_bases?.map((knowledge) => knowledge.id) ?? [])
  const availableKnowledgeIds = options.availableKnowledgeIds
    ? new Set(uniqueIds([...options.availableKnowledgeIds]))
    : new Set(sourceKnowledgeIds)
  const existingBindingIds = new Set(profile.knowledgeBindings.map((binding) => binding.knowledgeId))
  const previouslyImportedIds = new Set(profile.legacyMigration?.importedKnowledgeIds ?? [])
  const importedKnowledgeIds = new Set(previouslyImportedIds)
  const newBindings = [] as RpaAssistantProfile['knowledgeBindings']
  const missingKnowledgeIds: string[] = []

  for (const knowledgeId of sourceKnowledgeIds) {
    if (existingBindingIds.has(knowledgeId)) {
      importedKnowledgeIds.add(knowledgeId)
      continue
    }
    if (previouslyImportedIds.has(knowledgeId)) continue
    if (!availableKnowledgeIds.has(knowledgeId)) {
      missingKnowledgeIds.push(knowledgeId)
      continue
    }

    newBindings.push({ knowledgeId, enabled: true, priority: 0 })
    importedKnowledgeIds.add(knowledgeId)
  }

  const preservedLegacyFields = Object.keys(assistant).sort()
  const legacyMigration = {
    schemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION,
    sourceKnowledgeIds,
    importedKnowledgeIds: [...importedKnowledgeIds].sort(),
    missingKnowledgeIds: missingKnowledgeIds.sort(),
    preservedFieldNames: preservedLegacyFields,
    migratedAt: now
  }
  const comparableMigration = profile.legacyMigration ? { ...profile.legacyMigration, migratedAt: now } : undefined
  const changed = newBindings.length > 0 || JSON.stringify(comparableMigration) !== JSON.stringify(legacyMigration)
  const nextProfile = changed
    ? {
        ...profile,
        knowledgeBindings: [...profile.knowledgeBindings, ...newBindings],
        legacyMigration
      }
    : profile

  return {
    profile: nextProfile,
    changed,
    importedKnowledgeIds: legacyMigration.importedKnowledgeIds,
    missingKnowledgeIds: legacyMigration.missingKnowledgeIds,
    preservedLegacyFields
  }
}

export function createLegacyAssistantCompatibilityExport(
  assistant: Assistant,
  profile?: RpaAssistantProfile
): RpaLegacyAssistantCompatibilityExport {
  return {
    schemaVersion: 1,
    assistant: cloneJsonValue(assistant) as Assistant & Record<string, unknown>,
    migration: profile?.legacyMigration ? cloneJsonValue(profile.legacyMigration) : undefined
  }
}

function uniqueIds(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].sort()
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export const rpaAssistantProfileMigrationService = new RpaAssistantProfileMigrationService()
