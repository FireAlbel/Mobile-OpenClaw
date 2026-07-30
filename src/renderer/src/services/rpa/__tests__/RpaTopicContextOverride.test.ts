import { describe, expect, it } from 'vitest'

import {
  createDefaultRpaTopicContextOverride,
  type RpaTopicContextOverride,
  RpaTopicContextOverrideRepository,
  type RpaTopicContextOverrideStorage,
  sanitizeRpaTopicContextOverride
} from '../RpaTopicContextOverride'

class MemoryOverrideStorage implements RpaTopicContextOverrideStorage {
  overrides: RpaTopicContextOverride[] = []

  async loadOverrides(): Promise<RpaTopicContextOverride[]> {
    return structuredClone(this.overrides)
  }

  async saveOverrides(overrides: RpaTopicContextOverride[]): Promise<void> {
    this.overrides = structuredClone(overrides)
  }
}

describe('RpaTopicContextOverride', () => {
  it('sanitizes additions, exclusions, app scope, and model overrides', () => {
    expect(
      sanitizeRpaTopicContextOverride({
        topicId: ' topic-1 ',
        assistantId: ' assistant-1 ',
        version: 0,
        knowledgeBindings: [{ knowledgeId: ' kb-1 ', enabled: true, priority: 200 }],
        skillBindings: [{ skillId: ' skill-1 ', enabled: true, allowAutoMatch: true }],
        templateBindings: [{ templateId: ' template-1 ', usage: 'quick_start' }],
        exclusions: { skillIds: [' skill-2 ', 'skill-2', ''] },
        appPackages: [' com.example.app ', 'com.example.app'],
        modelOverrides: { vision: { providerId: ' provider-1 ', modelId: ' model-1 ' } },
        createdAt: 1,
        updatedAt: 2
      })
    ).toMatchObject({
      topicId: 'topic-1',
      assistantId: 'assistant-1',
      version: 1,
      knowledgeBindings: [{ knowledgeId: 'kb-1', priority: 100 }],
      skillBindings: [{ skillId: 'skill-1', priority: 0 }],
      templateBindings: [{ templateId: 'template-1', enabled: true, priority: 0 }],
      exclusions: { skillIds: ['skill-2'] },
      appPackages: ['com.example.app'],
      modelOverrides: { vision: { providerId: 'provider-1', modelId: 'model-1' } }
    })
  })

  it('creates lazily, increments versions, and removes only the requested topic', async () => {
    const storage = new MemoryOverrideStorage()
    let now = 10
    const repository = new RpaTopicContextOverrideRepository(storage, () => now)
    const [first, concurrent] = await Promise.all([
      repository.getOrCreateDefault('topic-1', 'assistant-1'),
      repository.getOrCreateDefault('topic-1', 'assistant-1')
    ])

    expect(first).toEqual(concurrent)
    expect(storage.overrides).toHaveLength(1)
    now = 20
    const saved = await repository.save({ ...first, appPackages: ['com.example.app'] })
    expect(saved).toMatchObject({ version: 2, createdAt: 10, updatedAt: 20 })

    storage.overrides.push(createDefaultRpaTopicContextOverride('topic-2', 'assistant-1', 30))
    await expect(repository.remove('topic-1')).resolves.toBe(true)
    await expect(repository.getByTopicId('topic-2')).resolves.toMatchObject({ topicId: 'topic-2' })
  })
})
