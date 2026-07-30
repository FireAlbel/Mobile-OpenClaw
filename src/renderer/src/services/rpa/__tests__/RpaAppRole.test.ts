import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  adaptAssistantProfileToRpaAppRole,
  createDefaultRpaAppRole,
  type RpaAppRole,
  RpaAppRoleRepository,
  type RpaAppRoleStorage,
  sanitizeRpaAppRole,
  sanitizeRpaRoleContextProvenance
} from '../RpaAppRole'
import { createDefaultRpaAssistantProfile } from '../RpaAssistantProfile'

class MemoryRoleStorage implements RpaAppRoleStorage {
  roles: RpaAppRole[] = []

  async loadRoles(): Promise<RpaAppRole[]> {
    return structuredClone(this.roles)
  }

  async saveRoles(roles: RpaAppRole[]): Promise<void> {
    this.roles = structuredClone(roles)
  }
}

describe('RpaAppRole', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('sanitizes qualified bindings and separates ownership from requirement', () => {
    const role = sanitizeRpaAppRole({
      ...createDefaultRpaAppRole(' role-1 ', ' Example Role ', 10),
      status: 'enabled',
      supportingRoleIds: [' role-2 ', 'role-1'],
      systemCapabilities: [' android.home ', 'android.home'],
      assetBindings: [
        {
          ref: { roleId: ' role-1 ', assetType: 'skill', assetId: ' skill-1 ', version: ' 2 ' },
          ownership: 'owned',
          requirement: 'required'
        },
        {
          ref: { roleId: 'role-1', assetType: 'skill', assetId: 'skill-1', version: '3' },
          ownership: 'shared',
          requirement: 'optional',
          enabled: false
        },
        {
          ref: { roleId: 'role-1', assetType: 'provider', assetId: 'legacy-mcp-provider' },
          ownership: 'linked',
          requirement: 'required',
          enabled: true
        }
      ]
    })

    expect(role).toMatchObject({
      id: 'role-1',
      name: 'Example Role',
      supportingRoleIds: ['role-2'],
      systemCapabilities: ['android.home'],
      assetBindings: [
        {
          ref: { roleId: 'role-1', assetType: 'skill', assetId: 'skill-1', version: '3' },
          ownership: 'shared',
          requirement: 'optional',
          enabled: false
        }
      ]
    })
  })

  it('adapts an Assistant Profile without copying asset bodies', () => {
    const profile = {
      ...createDefaultRpaAssistantProfile('assistant-1', 10),
      version: 4,
      updatedAt: 20,
      knowledgeBindings: [{ knowledgeId: 'kb-1', enabled: true, priority: 0 }],
      skillBindings: [{ skillId: 'skill-1', versionRange: '^2', enabled: true, allowAutoMatch: true, priority: 0 }],
      templateBindings: [
        { templateId: 'template-1', version: '3', enabled: false, priority: 0, usage: 'recommended' as const }
      ]
    }

    const role = adaptAssistantProfileToRpaAppRole({
      profile,
      assistantName: 'Meituan Operator',
      appPackages: ['com.sankuai.meituan'],
      systemCapabilities: ['android.home'],
      now: 20
    })

    expect(role).toMatchObject({
      id: 'assistant-role-assistant-1',
      name: 'Meituan Operator',
      status: 'enabled',
      version: 4,
      appPackages: ['com.sankuai.meituan'],
      compatibility: { assistantId: 'assistant-1', assistantProfileVersion: 4, adapterVersion: 1 }
    })
    expect(role.assetBindings).toEqual([
      expect.objectContaining({ ref: { roleId: role.id, assetType: 'knowledge', assetId: 'kb-1' } }),
      expect.objectContaining({ ref: { roleId: role.id, assetType: 'skill', assetId: 'skill-1', version: '^2' } })
    ])
    expect(role.assetBindings.some((binding) => binding.ref.assetId === 'template-1')).toBe(false)
    expect(JSON.stringify(role)).not.toContain('content')
  })

  it('versions roles and protects active or referenced roles from deletion', async () => {
    const storage = new MemoryRoleStorage()
    let now = 100
    const activeRoleIds = new Set<string>()
    const repository = new RpaAppRoleRepository(storage, () => now, {
      isRoleActive: async (roleId) => activeRoleIds.has(roleId)
    })
    const supporting = await repository.save(createDefaultRpaAppRole('supporting', 'Supporting', 1))
    now = 200
    const primary = await repository.save({
      ...createDefaultRpaAppRole('primary', 'Primary', 1),
      supportingRoleIds: ['supporting']
    })
    now = 300
    const updated = await repository.setStatus(primary.id, 'enabled')

    expect(updated).toMatchObject({ version: 2, createdAt: 1, updatedAt: 300, status: 'enabled' })
    await expect(repository.remove(supporting.id)).rejects.toThrow('referenced by: primary')
    activeRoleIds.add(primary.id)
    await expect(repository.remove(primary.id)).rejects.toThrow('active run')
    activeRoleIds.delete(primary.id)
    await expect(repository.remove(primary.id)).resolves.toBe(true)
    await expect(repository.remove(supporting.id)).resolves.toBe(true)
  })

  it('duplicates a Role as a draft and rewrites bindings owned by the source namespace', async () => {
    const storage = new MemoryRoleStorage()
    const repository = new RpaAppRoleRepository(storage, () => 100)
    await repository.save({
      ...createDefaultRpaAppRole('source', 'Source', 1),
      status: 'enabled',
      compatibility: {
        source: 'assistant_profile',
        assistantId: 'assistant-1',
        assistantProfileVersion: 2,
        adapterVersion: 1
      },
      assetBindings: [
        {
          ref: { roleId: 'source', assetType: 'skill', assetId: 'skill-1' },
          ownership: 'owned',
          requirement: 'required',
          enabled: true,
          priority: 0
        },
        {
          ref: { roleId: 'shared-role', assetType: 'knowledge', assetId: 'kb-1' },
          ownership: 'shared',
          requirement: 'optional',
          enabled: true,
          priority: 0
        }
      ]
    })

    const duplicate = await repository.duplicate('source', 'copy', 'Source Copy')

    expect(duplicate).toMatchObject({ id: 'copy', name: 'Source Copy', status: 'draft', compatibility: undefined })
    expect(duplicate.assetBindings.map((binding) => binding.ref.roleId)).toEqual(['copy', 'shared-role'])
  })

  it('rejects supporting Role cycles and reports the cycle path', async () => {
    const storage = new MemoryRoleStorage()
    const repository = new RpaAppRoleRepository(storage)
    await repository.save({ ...createDefaultRpaAppRole('a', 'A'), supportingRoleIds: ['b'] })

    await expect(repository.save({ ...createDefaultRpaAppRole('b', 'B'), supportingRoleIds: ['a'] })).rejects.toThrow(
      /Supporting Role cycle detected: (?:a -> b -> a|b -> a -> b)/
    )
    await expect(repository.getById('b')).resolves.toBeUndefined()
  })

  it('sanitizes primary and supporting Role provenance', () => {
    expect(
      sanitizeRpaRoleContextProvenance({
        primaryRole: { id: ' primary ', version: 2 },
        supportingRoles: [
          { id: 'support', version: 3 },
          { id: 'support', version: 4 },
          { id: 'primary', version: 5 }
        ],
        systemCapabilities: [' android.home ', 'android.home']
      })
    ).toEqual({
      primaryRole: { id: 'primary', version: 2 },
      supportingRoles: [{ id: 'support', version: 4 }],
      systemCapabilities: ['android.home'],
      compatibility: undefined
    })
  })
})
