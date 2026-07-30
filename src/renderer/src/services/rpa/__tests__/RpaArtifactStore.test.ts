import { describe, expect, it } from 'vitest'

import type { RpaArtifact, RpaArtifactStorage } from '../RpaArtifactStore'
import { artifactInputFromFile, categorizeRpaArtifact, RpaArtifactStore } from '../RpaArtifactStore'

class MemoryArtifactStorage implements RpaArtifactStorage {
  artifacts: RpaArtifact[] = []

  async loadArtifacts() {
    return structuredClone(this.artifacts)
  }

  async saveArtifacts(artifacts: RpaArtifact[]) {
    this.artifacts = structuredClone(artifacts)
  }
}

describe('RpaArtifactStore', () => {
  it('categorizes RPA evidence while preserving generic file references', () => {
    expect(categorizeRpaArtifact('pdf', 'document')).toBe('sop_import')
    expect(categorizeRpaArtifact('.json', 'document')).toBe('exported_dsl')
    expect(categorizeRpaArtifact('.uix')).toBe('ui_tree')
    expect(categorizeRpaArtifact('.png', 'image')).toBe('app_reference_image')
    expect(
      artifactInputFromFile({
        id: 'file-1',
        name: 'manual.pdf',
        origin_name: 'Manual.pdf',
        ext: '.pdf',
        type: 'document',
        size: 100,
        count: 1,
        created_at: new Date().toISOString()
      } as never)
    ).toMatchObject({ contentHash: 'file:file-1', locator: { fileId: 'file-1' } })
  })

  it('deduplicates by content hash and merges evidence links', async () => {
    const storage = new MemoryArtifactStorage()
    const store = new RpaArtifactStore(storage, undefined, () => 1_000)
    const input = {
      title: 'screen.png',
      category: 'screenshot' as const,
      contentHash: 'sha256:same',
      sizeBytes: 120,
      source: 'observation' as const,
      locator: { externalPath: 'D:/evidence/screen.png', extension: '.png' }
    }

    const first = await store.register({
      ...input,
      links: [{ targetType: 'run', targetId: 'run-1', relation: 'failure' }]
    })
    const second = await store.register({
      ...input,
      links: [{ targetType: 'bug_report', targetId: 'bug-1', relation: 'evidence' }]
    })

    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(true)
    expect(await store.getAll()).toHaveLength(1)
    expect(second.artifact.links).toHaveLength(2)
  })

  it('applies category and total size limits as metadata policies', async () => {
    const storage = new MemoryArtifactStorage()
    const store = new RpaArtifactStore(
      storage,
      {
        maxTotalBytes: 150,
        maxArtifactBytes: 100,
        maxBytesByCategory: { run_log: 50 },
        retentionDaysByCategory: {}
      },
      () => 2_000
    )

    const oversized = await store.register({
      title: 'run.log',
      category: 'run_log',
      sizeBytes: 80,
      source: 'generated',
      locator: { externalPath: 'D:/run.log' }
    })
    const totalLimited = await store.register({
      title: 'bundle.zip',
      category: 'debug_bundle',
      sizeBytes: 100,
      source: 'debug_export',
      locator: { externalPath: 'D:/bundle.zip' }
    })

    expect(oversized.artifact.policyAction).toBe('summarized')
    expect(totalLimited.artifact.policyAction).toBe('metadata_only')
    expect(totalLimited.policyWarnings).toContainEqual(expect.stringContaining('total capacity'))
  })

  it('redacts sensitive text and removes only expired metadata', async () => {
    const storage = new MemoryArtifactStorage()
    const store = new RpaArtifactStore(storage, undefined, () => 10_000)
    const registered = await store.register({
      title: 'capture.log',
      category: 'run_log',
      sizeBytes: 20,
      source: 'generated',
      locator: { externalPath: 'D:/capture.log' },
      textForRedaction: 'api_key=sk-1234567890123456'
    })

    expect(registered.artifact.description).toContain('[REDACTED:credential_field]')
    expect(registered.artifact.redaction.status).toBe('redacted')
    const expired = await store.cleanupExpired(Number.MAX_SAFE_INTEGER)
    expect(expired).toEqual([registered.artifact.id])
    expect(await store.getAll()).toEqual([])
    expect(registered.artifact.locator.externalPath).toBe('D:/capture.log')
  })
})
