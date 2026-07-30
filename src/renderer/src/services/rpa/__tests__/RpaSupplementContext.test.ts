import type { FileMetadata } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { rpaArtifactStore } from '../RpaArtifactStore'
import {
  RpaArtifactExtractionService,
  RpaContextSnapshotService,
  RpaSupplementContextRepository,
  type RpaSupplementContextState,
  type RpaSupplementContextStorage
} from '../RpaSupplementContext'

class MemoryStorage implements RpaSupplementContextStorage {
  state: RpaSupplementContextState = { schemaVersion: 1, indexes: [], snapshots: [], promotionProposals: [] }

  async load() {
    return structuredClone(this.state)
  }

  async save(state: RpaSupplementContextState) {
    this.state = structuredClone(state)
  }
}

const file: FileMetadata = {
  id: 'file-1',
  name: 'guide.md',
  origin_name: 'guide.md',
  path: 'C:/tmp/guide.md',
  size: 200,
  ext: '.md',
  type: FILE_TYPE.DOCUMENT,
  created_at: '2026-07-27T00:00:00.000Z',
  count: 1
}

describe('RpaSupplementContext', () => {
  beforeEach(() => {
    vi.spyOn(rpaArtifactStore, 'register').mockResolvedValue({
      artifact: {
        id: 'artifact-1',
        version: 1,
        category: 'sop_import',
        title: 'guide.md',
        contentHash: 'file:file-1',
        sizeBytes: 200,
        source: 'uploaded',
        locator: { externalPath: file.path },
        links: [],
        retention: { policy: 'temporary', expiresAt: 999_999 },
        redaction: { status: 'not_required', fields: [] },
        policyAction: 'stored',
        createdAt: 100,
        updatedAt: 100
      },
      deduplicated: false,
      policyWarnings: []
    })
    window.api = {
      file: { readExternal: vi.fn(async () => 'Open Settings.\n\nTap About phone.\n\nBearer secret-token') }
    } as unknown as typeof window.api
  })

  afterEach(() => vi.restoreAllMocks())

  it('extracts bounded redacted chunks into a temporary index', async () => {
    const storage = new MemoryStorage()
    const repository = new RpaSupplementContextRepository(storage)
    const service = new RpaArtifactExtractionService(repository, () => 100)

    const result = await service.extract({ sessionId: 'session-1', requestId: 'request-1', file })

    expect(result.index.status).toBe('ready')
    expect(result.index.chunks).toHaveLength(1)
    expect(result.index.chunks[0].content).toContain('Open Settings')
    expect(result.index.chunks[0].content).not.toContain('secret-token')
    expect(storage.state.indexes[0].artifactId).toBe('artifact-1')
  })

  it('separates audit replay from exact model replay after evidence expiry', async () => {
    const storage = new MemoryStorage()
    const repository = new RpaSupplementContextRepository(storage)
    const snapshots = new RpaContextSnapshotService(repository, () => 100)
    const snapshot = await snapshots.create({
      sessionId: 'session-1',
      requestId: 'request-1',
      role: { id: 'role-1', version: 1 },
      supplementRevision: 2,
      evidence: [
        {
          evidenceId: 'e-1',
          sourceId: 'chunk-1',
          sourceType: 'temporary_index',
          owner: 'session',
          contentHash: 'hash-1',
          boundedContent: 'exact evidence',
          localRank: 1,
          fusedRank: 1,
          authority: 0.5,
          relevance: 0.8,
          freshness: 1,
          extractionConfidence: 1,
          contributingSourceIds: ['index-1']
        }
      ],
      conflicts: [],
      omissions: [],
      providerCalls: [],
      ranking: { algorithm: 'rrf', version: '1', k: 60 },
      policy: { truncated: false, redacted: false, injectionAttempts: 0 },
      retention: { evidenceExpiresAt: 110, auditExpiresAt: 1_000, tombstonedSourceIds: [] }
    })

    await repository.cleanup(120)

    await expect(snapshots.replay(snapshot.id, 'audit')).resolves.toMatchObject({ available: true, degraded: false })
    await expect(snapshots.replay(snapshot.id, 'model')).resolves.toMatchObject({ available: false, degraded: true })
  })
})
