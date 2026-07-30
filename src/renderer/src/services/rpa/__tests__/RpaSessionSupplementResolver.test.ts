import { describe, expect, it } from 'vitest'

import type { EffectiveRpaRoleContext } from '../EffectiveRpaRoleContextResolver'
import type { RpaSessionSupplementBinding, RpaSessionSupplements } from '../RpaSessionSupplement'
import { RpaSessionSupplementResolver } from '../RpaSessionSupplementResolver'

const role = { id: 'role-1', version: 3 }

function context(executable = true): EffectiveRpaRoleContext {
  return {
    executable,
    roleContext: { primaryRole: role, supportingRoles: [], systemCapabilities: [] }
  } as unknown as EffectiveRpaRoleContext
}

function binding(
  id: string,
  sourceType: RpaSessionSupplementBinding['sourceType'],
  sourceId: string,
  overrides: Partial<RpaSessionSupplementBinding> = {}
): RpaSessionSupplementBinding {
  return {
    id,
    sessionId: 'session-1',
    sourceType,
    sourceId,
    toolNames: [],
    scope: 'session',
    requirement: 'optional',
    lifecycle: 'ready',
    trust: { classification: 'untrusted', reviewed: false },
    retention: { mode: 'session' },
    created: { actor: 'user', at: 1 },
    updatedAt: 1,
    ...overrides
  }
}

function supplements(bindings: RpaSessionSupplementBinding[]): RpaSessionSupplements {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    role,
    supplementRevision: 4,
    bindings,
    auditEvents: [],
    createdAt: 1,
    updatedAt: 2
  }
}

function permissions() {
  return {
    role,
    workspaceProviderIds: ['search-provider'],
    toolAllowlist: { 'device-tools': ['tap', 'swipe'] }
  }
}

describe('RpaSessionSupplementResolver', () => {
  it('creates an immutable effective snapshot and narrows Role-authorized tools', () => {
    const resolver = new RpaSessionSupplementResolver()
    const result = resolver.resolve({
      effectiveRoleContext: context(),
      supplements: supplements([
        binding('knowledge-binding', 'knowledge', 'knowledge-1', {
          requirement: 'required',
          sourceVersion: '2',
          contentHash: 'sha256:knowledge'
        }),
        binding('url-binding', 'approved_url', 'manual-url', {
          sourceUri: 'https://example.com/manual'
        }),
        binding('provider-binding', 'retrieval_provider', 'search-provider'),
        binding('tool-binding', 'tool_selection', 'device-tools', {
          toolNames: ['tap'],
          trust: { classification: 'role_authorized', reviewed: true }
        })
      ]),
      expectedSupplementRevision: 4,
      permissions: permissions(),
      availability: [
        {
          sourceType: 'knowledge',
          sourceId: 'knowledge-1',
          status: 'ready',
          version: '2',
          contentHash: 'sha256:knowledge'
        },
        { sourceType: 'retrieval_provider', sourceId: 'search-provider', status: 'ready' }
      ],
      now: () => 10
    })

    expect(result).toMatchObject({
      supplementRevision: 4,
      executable: true,
      resolvedAt: 10,
      toolAllowlist: { 'device-tools': ['tap'] }
    })
    expect(result.evidenceSources.map((source) => source.sourceId)).toEqual(['knowledge-1', 'manual-url'])
    expect(result.providerSelections).toEqual([
      { providerId: 'search-provider', kind: 'retrieval', bindingId: 'provider-binding' }
    ])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.bindings[0])).toBe(true)
  })

  it('applies request scope without leaking another request chain', () => {
    const resolver = new RpaSessionSupplementResolver()
    const result = resolver.resolve({
      effectiveRoleContext: context(),
      supplements: supplements([
        binding('current', 'approved_url', 'current-url', { scope: 'request', requestId: 'request-2' }),
        binding('other', 'approved_url', 'other-url', {
          scope: 'request',
          requestId: 'request-1',
          requirement: 'required'
        })
      ]),
      expectedSupplementRevision: 4,
      permissions: permissions(),
      requestId: 'request-2'
    })

    expect(result.bindings.map((item) => item.bindingId)).toEqual(['current'])
    expect(result.executable).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('blocks unavailable required sources and degrades optional sources', () => {
    const resolver = new RpaSessionSupplementResolver()
    const result = resolver.resolve({
      effectiveRoleContext: context(),
      supplements: supplements([
        binding('required', 'artifact', 'artifact-required', { requirement: 'required' }),
        binding('optional', 'artifact', 'artifact-optional', { lifecycle: 'degraded' })
      ]),
      expectedSupplementRevision: 4,
      permissions: permissions(),
      availability: [
        {
          sourceType: 'artifact',
          sourceId: 'artifact-required',
          status: 'missing',
          message: 'artifact was deleted'
        },
        {
          sourceType: 'artifact',
          sourceId: 'artifact-optional',
          status: 'degraded',
          message: 'preview only'
        }
      ]
    })

    expect(result.executable).toBe(false)
    expect(result.bindings).toEqual([expect.objectContaining({ bindingId: 'optional', status: 'degraded' })])
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'required_source_unavailable', severity: 'error' }),
        expect.objectContaining({ code: 'optional_source_unavailable', severity: 'warning' })
      ])
    )
  })

  it('revalidates workspace Provider trust and Role tool authorization instead of trusting persisted bindings', () => {
    const resolver = new RpaSessionSupplementResolver()
    const result = resolver.resolve({
      effectiveRoleContext: context(),
      supplements: supplements([
        binding('provider', 'retrieval_provider', 'unapproved-provider'),
        binding('tool', 'tool_selection', 'device-tools', { toolNames: ['tap', 'shell'] })
      ]),
      expectedSupplementRevision: 4,
      permissions: permissions(),
      availability: [{ sourceType: 'retrieval_provider', sourceId: 'unapproved-provider', status: 'ready' }]
    })

    expect(result.executable).toBe(false)
    expect(result.providerSelections).toEqual([])
    expect(result.toolAllowlist).toEqual({})
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['provider_not_trusted', 'tool_not_authorized'])
    )
  })

  it('blocks changed Role versions, permission snapshots, and policy override attempts', () => {
    const resolver = new RpaSessionSupplementResolver()
    const record = supplements([
      binding('artifact', 'approved_url', 'manual'),
      binding('provider', 'retrieval_provider', 'search-provider'),
      binding('tool', 'tool_selection', 'device-tools', { toolNames: ['tap'] })
    ]) as RpaSessionSupplements & { modelOverrides: unknown }
    record.role = { id: 'role-1', version: 2 }
    record.modelOverrides = { planner: 'unapproved-model' }
    const result = resolver.resolve({
      effectiveRoleContext: context(),
      supplements: record,
      expectedSupplementRevision: 4,
      permissions: { ...permissions(), role: { id: 'role-2', version: 1 } }
    })

    expect(result.executable).toBe(false)
    expect(result.providerSelections).toEqual([])
    expect(result.toolAllowlist).toEqual({})
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['role_version_changed', 'permission_snapshot_role_mismatch', 'policy_override_attempt'])
    )
  })

  it('treats an elapsed until-retention binding as unavailable', () => {
    const resolver = new RpaSessionSupplementResolver()
    const result = resolver.resolve({
      effectiveRoleContext: context(),
      supplements: supplements([
        binding('expired-retention', 'approved_url', 'temporary-manual', {
          requirement: 'required',
          retention: { mode: 'until', expiresAt: 20 }
        })
      ]),
      expectedSupplementRevision: 4,
      permissions: permissions(),
      now: () => 21
    })

    expect(result.executable).toBe(false)
    expect(result.bindings).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'required_source_unavailable', message: expect.stringContaining('expired') })
    ])
  })

  it('rejects a stale supplementRevision before resolving evidence', () => {
    const resolver = new RpaSessionSupplementResolver()
    expect(() =>
      resolver.resolve({
        effectiveRoleContext: context(),
        supplements: supplements([]),
        expectedSupplementRevision: 3,
        permissions: permissions()
      })
    ).toThrow('revision conflict')
  })

  it('rejects changed source versions and hashes according to requirement', () => {
    const resolver = new RpaSessionSupplementResolver()
    const result = resolver.resolve({
      effectiveRoleContext: context(),
      supplements: supplements([
        binding('versioned', 'knowledge', 'knowledge-1', {
          requirement: 'required',
          sourceVersion: '1',
          contentHash: 'sha256:old'
        })
      ]),
      expectedSupplementRevision: 4,
      permissions: permissions(),
      availability: [
        {
          sourceType: 'knowledge',
          sourceId: 'knowledge-1',
          status: 'ready',
          version: '2',
          contentHash: 'sha256:new'
        }
      ]
    })

    expect(result.executable).toBe(false)
    expect(result.bindings).toEqual([])
    expect(result.issues).toEqual([expect.objectContaining({ code: 'source_version_mismatch', severity: 'error' })])
  })
})
