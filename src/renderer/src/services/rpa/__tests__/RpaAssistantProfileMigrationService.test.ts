import type { Assistant, KnowledgeBase, Model } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import {
  type RpaAssistantProfile,
  RpaAssistantProfileRepository,
  type RpaAssistantProfileStorage
} from '../RpaAssistantProfile'
import {
  createLegacyAssistantCompatibilityExport,
  RpaAssistantProfileMigrationService
} from '../RpaAssistantProfileMigrationService'

class MemoryProfileStorage implements RpaAssistantProfileStorage {
  profiles: RpaAssistantProfile[] = []
  saveCount = 0

  async loadProfiles(): Promise<RpaAssistantProfile[]> {
    return structuredClone(this.profiles)
  }

  async saveProfiles(profiles: RpaAssistantProfile[]): Promise<void> {
    this.saveCount += 1
    this.profiles = structuredClone(profiles)
  }
}

const selectedModel = {
  id: 'gpt-5',
  name: 'GPT-5',
  provider: 'openai',
  group: 'gpt'
} as Model

function createAssistant(id = 'assistant-1'): Assistant {
  return {
    id,
    name: 'Legacy assistant',
    prompt: 'Keep this prompt',
    model: selectedModel,
    topics: [],
    type: 'assistant',
    knowledge_bases: [{ id: 'kb-1' }, { id: 'kb-missing' }] as KnowledgeBase[],
    mcpMode: 'manual',
    mcpServers: [{ id: 'mcp-1', name: 'Legacy MCP', isActive: true }],
    legacyExtension: { keep: true }
  } as Assistant
}

describe('RpaAssistantProfileMigrationService', () => {
  it('imports compatible knowledge once without mutating legacy assistant data', async () => {
    const storage = new MemoryProfileStorage()
    const service = new RpaAssistantProfileMigrationService(
      new RpaAssistantProfileRepository(storage, () => 100),
      () => 100
    )
    const assistant = createAssistant()
    const before = structuredClone(assistant)

    const first = await service.getOrMigrateAssistant(assistant, { availableKnowledgeIds: ['kb-1'] })
    const second = await service.getOrMigrateAssistant(assistant, { availableKnowledgeIds: ['kb-1'] })

    expect(first).toMatchObject({ created: true, changed: true, importedKnowledgeIds: ['kb-1'] })
    expect(first.profile.knowledgeBindings).toEqual([{ knowledgeId: 'kb-1', enabled: true, priority: 0 }])
    expect(first.missingKnowledgeIds).toEqual(['kb-missing'])
    expect(second).toMatchObject({ created: false, changed: false })
    expect(second.profile.version).toBe(1)
    expect(storage.saveCount).toBe(1)
    expect(assistant).toEqual(before)
  })

  it('imports a previously missing reference when it becomes available', async () => {
    const storage = new MemoryProfileStorage()
    const service = new RpaAssistantProfileMigrationService(
      new RpaAssistantProfileRepository(storage, () => 100),
      () => 100
    )
    const assistant = createAssistant()

    await service.getOrMigrateAssistant(assistant, { availableKnowledgeIds: ['kb-1'] })
    const result = await service.getOrMigrateAssistant(assistant, {
      availableKnowledgeIds: ['kb-1', 'kb-missing']
    })

    expect(result.changed).toBe(true)
    expect(result.profile.version).toBe(2)
    expect(result.profile.knowledgeBindings.map((binding) => binding.knowledgeId)).toEqual(['kb-1', 'kb-missing'])
    expect(result.missingKnowledgeIds).toEqual([])
  })

  it('preserves existing profile settings and does not restore a manually removed migrated binding', async () => {
    const storage = new MemoryProfileStorage()
    const repository = new RpaAssistantProfileRepository(storage, () => 100)
    const service = new RpaAssistantProfileMigrationService(repository, () => 100)
    const assistant = createAssistant()
    const migrated = await service.getOrMigrateAssistant(assistant, { availableKnowledgeIds: ['kb-1'] })
    const customized = await repository.save({
      ...migrated.profile,
      knowledgeBindings: [],
      skillBindings: [{ skillId: 'skill-1', enabled: true, allowAutoMatch: false, priority: 8 }]
    })

    const result = await service.getOrMigrateAssistant(assistant, { availableKnowledgeIds: ['kb-1'] })

    expect(result.changed).toBe(false)
    expect(result.profile).toEqual(customized)
    expect(result.profile.knowledgeBindings).toEqual([])
    expect(result.profile.skillBindings).toEqual(customized.skillBindings)
  })

  it('keeps unsupported legacy fields readable in compatibility exports', async () => {
    const storage = new MemoryProfileStorage()
    const service = new RpaAssistantProfileMigrationService(
      new RpaAssistantProfileRepository(storage, () => 100),
      () => 100
    )
    const assistant = createAssistant() as Assistant & { legacyExtension: { keep: boolean } }
    const { profile } = await service.getOrMigrateAssistant(assistant, { availableKnowledgeIds: ['kb-1'] })

    const exported = createLegacyAssistantCompatibilityExport(assistant, profile)

    expect(exported.assistant).not.toBe(assistant)
    expect(exported.assistant).toMatchObject({
      id: assistant.id,
      prompt: 'Keep this prompt',
      model: selectedModel,
      mcpMode: 'manual',
      legacyExtension: { keep: true }
    })
    expect(exported.migration?.preservedFieldNames).toContain('legacyExtension')
  })
})
