import { describe, expect, it } from 'vitest'

import {
  RpaSessionSupplementRepository,
  type RpaSessionSupplements,
  RpaSessionSupplementService,
  type RpaSessionSupplementStorage,
  sanitizeRpaSessionSupplements
} from '../RpaSessionSupplement'

class MemoryStorage implements RpaSessionSupplementStorage {
  records: RpaSessionSupplements[] = []

  async loadRecords(): Promise<RpaSessionSupplements[]> {
    return structuredClone(this.records)
  }

  async saveRecords(records: RpaSessionSupplements[]): Promise<void> {
    this.records = structuredClone(records)
  }
}

function setup() {
  const storage = new MemoryStorage()
  let now = 100
  const repository = new RpaSessionSupplementRepository(storage, () => now)
  const service = new RpaSessionSupplementService(repository, () => now)
  return { storage, repository, service, setNow: (value: number) => (now = value) }
}

describe('RpaSessionSupplement', () => {
  it('creates an immutable Role-scoped record and versions binding writes', async () => {
    const { service, setNow } = setup()
    const role = { id: 'role-1', version: 3 }
    const initial = await service.initialize('session-1', role)
    expect(initial).toMatchObject({ supplementRevision: 0, role, bindings: [] })

    setNow(200)
    const saved = await service.bind(
      {
        sessionId: 'session-1',
        sourceType: 'knowledge',
        sourceId: 'knowledge-1',
        sourceVersion: '4',
        contentHash: 'sha256:abc',
        scope: 'request',
        requestId: 'request-1',
        requirement: 'required'
      },
      0,
      { role }
    )

    expect(saved).toMatchObject({ supplementRevision: 1, role })
    expect(saved.bindings[0]).toMatchObject({
      sessionId: 'session-1',
      sourceId: 'knowledge-1',
      scope: 'request',
      requestId: 'request-1',
      lifecycle: 'pending',
      retention: { mode: 'request_chain' },
      trust: { classification: 'untrusted' }
    })
    expect(saved.auditEvents[0]).toMatchObject({ type: 'bound', to: 'pending' })
  })

  it('rejects stale concurrent writes and immutable Role mismatches', async () => {
    const { service } = setup()
    const role = { id: 'role-1', version: 1 }
    await service.initialize('session-1', role)
    await service.bind(
      { sessionId: 'session-1', sourceType: 'artifact', sourceId: 'artifact-1', scope: 'session' },
      0,
      { role }
    )

    await expect(
      service.bind({ sessionId: 'session-1', sourceType: 'artifact', sourceId: 'artifact-2', scope: 'session' }, 0, {
        role
      })
    ).rejects.toThrow('revision conflict')
    await expect(service.initialize('session-1', { id: 'role-2', version: 1 })).rejects.toThrow(
      'immutable Session Role'
    )
  })

  it('only permits workspace-trusted providers and Role-authorized tools', async () => {
    const { service } = setup()
    const role = { id: 'role-1', version: 1 }
    await service.initialize('session-1', role)

    await expect(
      service.bind(
        {
          sessionId: 'session-1',
          sourceType: 'tool_selection',
          sourceId: 'device-tools',
          toolNames: ['tap', 'shell'],
          scope: 'session'
        },
        0,
        { role, toolAllowlist: { 'device-tools': ['tap'] } }
      )
    ).rejects.toThrow('shell')

    const saved = await service.bind(
      {
        sessionId: 'session-1',
        sourceType: 'tool_selection',
        sourceId: 'device-tools',
        toolNames: ['tap'],
        scope: 'session',
        trust: { classification: 'role_authorized', reviewed: true }
      },
      0,
      { role, toolAllowlist: { 'device-tools': ['tap', 'swipe'] } }
    )
    expect(saved.bindings[0]).toMatchObject({
      toolNames: ['tap'],
      trust: { classification: 'role_authorized', reviewed: true }
    })

    await expect(
      service.bind(
        {
          sessionId: 'session-1',
          sourceType: 'retrieval_provider',
          sourceId: 'remote-search',
          scope: 'session'
        },
        1,
        { role, workspaceProviderIds: [] }
      )
    ).rejects.toThrow('not trusted by the current workspace')
  })

  it('expires all live request-scoped bindings after a logical request chain finishes', async () => {
    const { service, setNow } = setup()
    const role = { id: 'role-1', version: 1 }
    await service.initialize('session-1', role)
    const first = await service.bind(
      {
        sessionId: 'session-1',
        sourceType: 'approved_url',
        sourceId: 'manual-url',
        sourceUri: 'https://example.com/manual#section',
        scope: 'request',
        requestId: 'request-1'
      },
      0,
      { role }
    )
    setNow(300)
    const expired = await service.expireRequestScope('session-1', 'request-1', first.supplementRevision, 'completed')

    expect(expired.bindings[0]).toMatchObject({ lifecycle: 'expired', sourceUri: 'https://example.com/manual' })
    expect(expired.auditEvents.at(-1)).toMatchObject({ type: 'expired', from: 'pending', to: 'expired' })
    await expect(
      service.transition('session-1', expired.bindings[0].id, 'ready', expired.supplementRevision, {
        actor: 'user'
      })
    ).rejects.toThrow('terminal')
  })

  it('blocks credentials embedded in URLs and strips unknown content fields during sanitization', async () => {
    const { service } = setup()
    const role = { id: 'role-1', version: 1 }
    await service.initialize('session-1', role)

    await expect(
      service.bind(
        {
          sessionId: 'session-1',
          sourceType: 'approved_url',
          sourceId: 'bad-url',
          sourceUri: 'https://user:secret@example.com/manual',
          scope: 'session'
        },
        0,
        { role }
      )
    ).rejects.toThrow('Credentials')
    await expect(
      service.bind(
        {
          sessionId: 'session-1',
          sourceType: 'retrieval_provider',
          sourceId: 'remote-search',
          credentialRef: 'sk-raw-secret-must-not-be-stored',
          scope: 'session'
        },
        0,
        { role, workspaceProviderIds: ['remote-search'] }
      )
    ).rejects.toThrow('credential reference')

    const sanitized = sanitizeRpaSessionSupplements({
      schemaVersion: 1,
      sessionId: 'session-1',
      role,
      supplementRevision: 1,
      bindings: [
        {
          id: 'binding-1',
          sessionId: 'session-1',
          sourceType: 'artifact',
          sourceId: 'artifact-1',
          scope: 'session',
          content: 'must not be stored',
          rawCredential: 'secret',
          lifecycle: 'ready',
          created: { actor: 'user', at: 1 },
          updatedAt: 1
        }
      ],
      auditEvents: [],
      createdAt: 1,
      updatedAt: 1
    })

    expect(sanitized?.bindings[0]).not.toHaveProperty('content')
    expect(sanitized?.bindings[0]).not.toHaveProperty('rawCredential')
  })

  it('drops bindings whose ownership does not match the containing Session', () => {
    const record = sanitizeRpaSessionSupplements({
      schemaVersion: 1,
      sessionId: 'session-1',
      role: { id: 'role-1', version: 1 },
      supplementRevision: 1,
      bindings: [
        {
          id: 'binding-1',
          sessionId: 'session-2',
          sourceType: 'artifact',
          sourceId: 'artifact-1',
          scope: 'session',
          created: { actor: 'user', at: 1 },
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })

    expect(record?.bindings).toEqual([])
  })
})
