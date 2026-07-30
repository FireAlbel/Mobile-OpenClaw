import { describe, expect, it } from 'vitest'

import {
  createDefaultRpaKnowledgeEntry,
  redactRpaKnowledgeText,
  type RpaKnowledgeEntry,
  RpaKnowledgeRepository,
  type RpaKnowledgeStorage,
  sanitizeRpaKnowledgeEntries,
  sanitizeRpaKnowledgeEntry
} from '../RpaKnowledge'

class MemoryKnowledgeStorage implements RpaKnowledgeStorage {
  entries: RpaKnowledgeEntry[] = []
  saveCount = 0

  async loadEntries(): Promise<RpaKnowledgeEntry[]> {
    return structuredClone(this.entries)
  }

  async saveEntries(entries: RpaKnowledgeEntry[]): Promise<void> {
    this.saveCount += 1
    this.entries = structuredClone(entries)
  }
}

describe('RpaKnowledge', () => {
  it('sanitizes typed references without accepting executable definitions', () => {
    const entry = sanitizeRpaKnowledgeEntry({
      ...createDefaultRpaKnowledgeEntry('kb-1', 'recovery_guidance', 10),
      title: ' Recover login ',
      reviewStatus: 'reviewed',
      confidence: 2,
      links: {
        templateIds: [' template-1 ', 'template-1'],
        skills: [{ skillId: ' skill-1 ', version: ' 2.0.0 ', actions: [{ type: 'tap' }] }],
        stateIds: ['login'],
        failureFingerprintIds: ['fingerprint-1'],
        executableTransitions: [{ from: 'a', to: 'b' }]
      }
    })

    expect(entry).toMatchObject({
      title: 'Recover login',
      confidence: 1,
      links: {
        templateIds: ['template-1'],
        skills: [{ skillId: 'skill-1', version: '2.0.0' }],
        stateIds: ['login'],
        failureFingerprintIds: ['fingerprint-1']
      }
    })
    expect(entry?.links).not.toHaveProperty('executableTransitions')
    expect(entry?.links.skills[0]).not.toHaveProperty('actions')
  })

  it('redacts credentials and personal account data', () => {
    const result = redactRpaKnowledgeText(
      'Bearer abc.def.ghi api_key=top-secret sk-abcdefghijklmnop user@example.com 13800138000'
    )

    expect(result.text).not.toContain('top-secret')
    expect(result.text).not.toContain('user@example.com')
    expect(result.text).not.toContain('13800138000')
    expect(result.redactions).toEqual(
      expect.arrayContaining(['bearer_token', 'api_key', 'credential_field', 'email', 'phone'])
    )
  })

  it('versions saves and keeps entries separated by knowledge base', async () => {
    const storage = new MemoryKnowledgeStorage()
    let now = 100
    const repository = new RpaKnowledgeRepository(storage, () => now)
    const first = await repository.save({
      ...createDefaultRpaKnowledgeEntry('kb-1', 'app_sop', 1),
      id: 'entry-1',
      title: 'Open app'
    })
    await repository.save({
      ...createDefaultRpaKnowledgeEntry('kb-2', 'policy_note', 2),
      id: 'entry-2',
      title: 'Policy'
    })
    now = 200
    const updated = await repository.save({ ...first, summary: 'Updated' })

    expect(updated).toMatchObject({ version: 2, createdAt: 1, updatedAt: 200 })
    await expect(repository.getByKnowledgeBaseId('kb-1')).resolves.toEqual([updated])
    expect(storage.saveCount).toBe(3)
  })

  it('retires legacy per-run summaries from retrieval and subsequent writes', async () => {
    const manual = { ...createDefaultRpaKnowledgeEntry('kb-1', 'app_sop', 1), id: 'manual-1', title: 'Stable SOP' }
    const runSummary = {
      ...createDefaultRpaKnowledgeEntry('kb-1', 'failure_case', 2),
      id: 'run-summary-1',
      title: 'Legacy run summary',
      source: { type: 'run_summary' as const, runId: 'run-1' }
    }

    expect(sanitizeRpaKnowledgeEntries([manual, runSummary])).toEqual([expect.objectContaining({ id: 'manual-1' })])

    const storage = new MemoryKnowledgeStorage()
    storage.entries = [manual, runSummary]
    const repository = new RpaKnowledgeRepository(storage, () => 100)
    await expect(repository.getAll()).resolves.toEqual([expect.objectContaining({ id: 'manual-1' })])
    await repository.save({ ...manual, summary: 'Updated SOP' })
    expect(storage.entries.map((entry) => entry.id)).toEqual(['manual-1'])
  })
})
