import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createDefaultRpaAssistantProfile,
  IpcRpaAssistantProfileStorage,
  type RpaAssistantProfile,
  RpaAssistantProfileRepository,
  type RpaAssistantProfileStorage,
  sanitizeRpaAssistantProfile
} from '../RpaAssistantProfile'

class MemoryProfileStorage implements RpaAssistantProfileStorage {
  profiles: RpaAssistantProfile[] = []

  async loadProfiles(): Promise<RpaAssistantProfile[]> {
    return structuredClone(this.profiles)
  }

  async saveProfiles(profiles: RpaAssistantProfile[]): Promise<void> {
    this.profiles = structuredClone(profiles)
  }
}

describe('RpaAssistantProfile', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('sanitizes bindings, limits retrieval, and keeps the latest duplicate reference', () => {
    const profile = sanitizeRpaAssistantProfile({
      assistantId: ' assistant-1 ',
      version: 0,
      createdAt: 10,
      updatedAt: 20,
      knowledgeBindings: [
        { knowledgeId: 'kb-1', priority: -200, retrievalLimit: 0 },
        { knowledgeId: 'kb-1', priority: 200, retrievalLimit: 50, filters: { tags: [' a ', 'a', ''] } },
        { knowledgeId: ' ' }
      ],
      skillBindings: [
        { skillId: 'skill-1', enabled: false, allowAutoMatch: false },
        { skillId: 'skill-1', versionRange: ' ^2 ', enabled: true }
      ],
      templateBindings: [{ templateId: 'template-1', usage: 'quick_start' }],
      modelOverrides: { vision: { providerId: ' openai ', modelId: ' gpt-5 ' }, recovery: { modelId: '' } }
    })

    expect(profile).toMatchObject({
      assistantId: 'assistant-1',
      version: 1,
      knowledgeBindings: [
        { knowledgeId: 'kb-1', priority: 100, retrievalLimit: 20, filters: { tags: ['a'], appPackages: [] } }
      ],
      skillBindings: [{ skillId: 'skill-1', versionRange: '^2', enabled: true, allowAutoMatch: true, priority: 0 }],
      templateBindings: [{ templateId: 'template-1', enabled: true, priority: 0, usage: 'quick_start' }],
      modelOverrides: { vision: { providerId: 'openai', modelId: 'gpt-5' } }
    })
  })

  it('lazily creates one default profile and increments versions on save', async () => {
    const storage = new MemoryProfileStorage()
    let now = 100
    const repository = new RpaAssistantProfileRepository(storage, () => now)

    const [first, concurrent] = await Promise.all([
      repository.getOrCreateDefault('assistant-1'),
      repository.getOrCreateDefault('assistant-1')
    ])
    expect(first).toEqual(concurrent)
    expect(storage.profiles).toHaveLength(1)

    now = 200
    const saved = await repository.save({
      ...first,
      skillBindings: [{ skillId: 'skill-1', enabled: true, allowAutoMatch: true, priority: 0 }]
    })

    expect(saved).toMatchObject({ version: 2, createdAt: 100, updatedAt: 200 })
    await expect(repository.getByAssistantId('assistant-1')).resolves.toEqual(saved)
  })

  it('shares assets across assistants and removes only the requested association', async () => {
    const storage = new MemoryProfileStorage()
    const repository = new RpaAssistantProfileRepository(storage, () => 100)
    const first = createDefaultRpaAssistantProfile('assistant-1', 1)
    const second = createDefaultRpaAssistantProfile('assistant-2', 2)

    await repository.save({
      ...first,
      knowledgeBindings: [{ knowledgeId: 'shared-kb', enabled: true, priority: 0 }]
    })
    await repository.save({
      ...second,
      knowledgeBindings: [{ knowledgeId: 'shared-kb', enabled: true, priority: 0 }]
    })

    await expect(repository.findProfilesReferencingAsset('knowledge', 'shared-kb')).resolves.toHaveLength(2)
    await expect(repository.removeAssistantAssociation('assistant-1')).resolves.toBe(true)
    await expect(repository.getByAssistantId('assistant-1')).resolves.toBeUndefined()
    await expect(repository.findProfilesReferencingAsset('knowledge', 'shared-kb')).resolves.toMatchObject([
      { assistantId: 'assistant-2' }
    ])
  })

  it('loads through IPC and falls back when the bridge fails', async () => {
    const fallback = new MemoryProfileStorage()
    fallback.profiles = [createDefaultRpaAssistantProfile('fallback-assistant', 1)]
    const loadAssistantProfiles = vi.fn(async () => [createDefaultRpaAssistantProfile('ipc-assistant', 2)])
    vi.stubGlobal('window', {
      api: {
        rpa: {
          loadAssistantProfiles,
          saveAssistantProfiles: vi.fn(async () => undefined)
        }
      }
    })
    const storage = new IpcRpaAssistantProfileStorage(fallback)

    await expect(storage.loadProfiles()).resolves.toMatchObject([{ assistantId: 'ipc-assistant' }])

    loadAssistantProfiles.mockRejectedValueOnce(new Error('IPC unavailable'))
    await expect(storage.loadProfiles()).resolves.toMatchObject([{ assistantId: 'fallback-assistant' }])
  })

  it('uses fallback persistence when the IPC bridge is absent', async () => {
    vi.stubGlobal('window', { api: {} })
    const fallback = new MemoryProfileStorage()
    const storage = new IpcRpaAssistantProfileStorage(fallback)
    const profile = createDefaultRpaAssistantProfile('assistant-1', 1)

    await storage.saveProfiles([profile])

    expect(fallback.profiles).toEqual([profile])
  })
})
