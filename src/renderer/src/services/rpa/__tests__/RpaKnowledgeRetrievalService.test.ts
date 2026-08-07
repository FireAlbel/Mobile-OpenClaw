import { describe, expect, it } from 'vitest'

import {
  createDefaultRpaKnowledgeEntry,
  type RpaKnowledgeEntry,
  RpaKnowledgeRepository,
  type RpaKnowledgeStorage
} from '../RpaKnowledge'
import { RpaKnowledgeRetrievalService } from '../RpaKnowledgeRetrievalService'

class MemoryKnowledgeStorage implements RpaKnowledgeStorage {
  constructor(public entries: RpaKnowledgeEntry[]) {}
  async loadEntries() {
    return structuredClone(this.entries)
  }
  async saveEntries(entries: RpaKnowledgeEntry[]) {
    this.entries = structuredClone(entries)
  }
}

function entry(id: string, overrides: Partial<RpaKnowledgeEntry> = {}): RpaKnowledgeEntry {
  return {
    ...createDefaultRpaKnowledgeEntry('kb-1', 'failure_case', 1),
    id,
    title: id,
    summary: `Summary ${id}`,
    reviewStatus: 'reviewed',
    confidence: 0.9,
    scope: {
      appPackages: ['com.example.app'],
      taskGoals: ['collect reward'],
      stateIds: ['reward-page'],
      errorClasses: ['failed']
    },
    ...overrides
  }
}

describe('RpaKnowledgeRetrievalService', () => {
  it('retrieves reviewed entries by app, task, state, and error classification', async () => {
    const storage = new MemoryKnowledgeStorage([
      entry('matching'),
      entry('draft', { reviewStatus: 'draft' }),
      entry('low-confidence', { confidence: 0.4 }),
      entry('other-app', {
        scope: { appPackages: ['com.other'], taskGoals: [], stateIds: [], errorClasses: [] }
      })
    ])
    const service = new RpaKnowledgeRetrievalService(new RpaKnowledgeRepository(storage))

    const result = await service.retrieve({
      knowledgeBaseIds: ['kb-1'],
      appPackage: 'com.example.app',
      taskGoal: 'collect reward',
      stateId: 'reward-page',
      errorClass: 'failed'
    })

    expect(result.summaries.map((summary) => summary.id)).toEqual(['matching'])
  })

  it('blocks conflicting reviewed guidance from automatic selection', async () => {
    const storage = new MemoryKnowledgeStorage([
      entry('allow', { summary: 'Tap allow to continue' }),
      entry('deny', { summary: 'Tap deny to continue' })
    ])
    const service = new RpaKnowledgeRetrievalService(new RpaKnowledgeRepository(storage))

    const result = await service.retrieve({ appPackage: 'com.example.app', errorClass: 'failed' })

    expect(result.summaries).toEqual([])
    expect(result.conflicts).toEqual([expect.objectContaining({ entryIds: ['allow', 'deny'] })])
    expect(result.warnings[0]).toContain('require user review')
  })

  it('returns Skill and Template references without executable definitions', async () => {
    const storage = new MemoryKnowledgeStorage([
      entry('linked', {
        links: {
          templateIds: ['template-1'],
          skills: [{ skillId: 'skill-1', version: '2.0.0' }],
          stateIds: [],
          failureFingerprintIds: [],
          artifactIds: []
        }
      })
    ])
    const service = new RpaKnowledgeRetrievalService(new RpaKnowledgeRepository(storage))

    const result = await service.retrieve({ appPackage: 'com.example.app' })

    expect(result.summaries[0]).toMatchObject({
      templateIds: ['template-1'],
      skills: [{ skillId: 'skill-1', version: '2.0.0' }]
    })
  })

  it('does not retrieve from unbound knowledge bases', async () => {
    const service = new RpaKnowledgeRetrievalService(
      new RpaKnowledgeRepository(new MemoryKnowledgeStorage([entry('not-bound')]))
    )

    await expect(service.retrieve({ knowledgeBaseIds: [], taskGoal: 'collect reward' })).resolves.toMatchObject({
      summaries: []
    })
  })

  it('distinguishes a bound Knowledge Base from one with usable reviewed RPA entries', async () => {
    const service = new RpaKnowledgeRetrievalService(
      new RpaKnowledgeRepository(
        new MemoryKnowledgeStorage([
          entry('draft-only', { knowledgeBaseId: 'kb-draft', reviewStatus: 'draft' }),
          entry('reviewed', { knowledgeBaseId: 'kb-ready' })
        ])
      )
    )

    await expect(service.getAvailability(['kb-empty', 'kb-draft', 'kb-ready'])).resolves.toEqual([
      expect.objectContaining({ knowledgeBaseId: 'kb-empty', status: 'error', usableEntryCount: 0 }),
      expect.objectContaining({ knowledgeBaseId: 'kb-draft', status: 'error', usableEntryCount: 0 }),
      expect.objectContaining({ knowledgeBaseId: 'kb-ready', status: 'ready', usableEntryCount: 1 })
    ])
  })
})
