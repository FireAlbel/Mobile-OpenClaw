import { describe, expect, it, vi } from 'vitest'

import { createDefaultRpaAppRole, type RpaAppRole } from '../RpaAppRole'
import {
  type RpaRolePackRepositorySnapshot,
  RpaRolePackService,
  type RpaRolePackStagedContent,
  type RpaRolePackTransactionAdapter
} from '../RpaRolePackService'

const hash = { sha256: async (content: string) => `hash:${content.length}:${content.charCodeAt(0) || 0}` }
const trustStore = { verify: vi.fn().mockResolvedValue(true), isTrustedPublisher: vi.fn().mockResolvedValue(true) }
class MemoryAdapter implements RpaRolePackTransactionAdapter {
  roles = new Map<string, RpaAppRole>()
  applied?: RpaRolePackStagedContent
  fail = false
  async snapshot(): Promise<RpaRolePackRepositorySnapshot> {
    return { values: { roles: [...this.roles.values()] } }
  }
  async restore(snapshot: RpaRolePackRepositorySnapshot): Promise<void> {
    this.roles = new Map((snapshot.values.roles as RpaAppRole[]).map((role) => [role.id, role]))
  }
  async findRole(roleId: string) {
    return this.roles.get(roleId)
  }
  async hasActiveRun() {
    return false
  }
  async apply(staged: RpaRolePackStagedContent) {
    if (this.fail) throw new Error('write failed')
    this.applied = staged
    this.roles.set(staged.role.id, staged.role)
  }
}

describe('RpaRolePackService', () => {
  it('round trips without credentials and quarantines unsigned imports', async () => {
    const service = new RpaRolePackService(hash, trustStore)
    const role = createDefaultRpaAppRole('role-1', 'Role One', 1)
    const pack = await service.export(
      {
        role,
        prompts: [],
        knowledge: [],
        skills: [],
        templates: [],
        artifacts: [],
        providers: [{ id: 'p', apiKey: 'secret' }]
      },
      { packId: 'pack-1' }
    )
    expect(JSON.stringify(pack)).not.toContain('secret')
    const adapter = new MemoryAdapter()
    const result = await service.import(pack, 'install', adapter)
    expect(result.quarantined).toBe(true)
    expect(adapter.applied?.role.status).toBe('draft')
  })

  it('rejects traversal and checksum changes before writing', async () => {
    const service = new RpaRolePackService(hash, trustStore)
    const pack = await service.export(
      {
        role: createDefaultRpaAppRole('role-1', 'Role One'),
        prompts: [],
        knowledge: [],
        skills: [],
        templates: [],
        artifacts: [],
        providers: []
      },
      { packId: 'pack-1' }
    )
    pack.manifest.files[0].path = '../role.json'
    await expect(service.import(pack, 'install', new MemoryAdapter())).rejects.toThrow('Unsafe pack path')
  })

  it('forks namespaces deterministically and rolls back failed transactions', async () => {
    const service = new RpaRolePackService(hash, trustStore)
    const role = {
      ...createDefaultRpaAppRole('role-1', 'Role One'),
      assetBindings: [
        {
          ref: { roleId: 'role-1', assetType: 'skill' as const, assetId: 's' },
          ownership: 'owned' as const,
          requirement: 'required' as const,
          enabled: true,
          priority: 0
        }
      ]
    }
    const pack = await service.export(
      { role, prompts: [{ roleId: 'role-1' }], knowledge: [], skills: [], templates: [], artifacts: [], providers: [] },
      { packId: 'pack-1' }
    )
    const adapter = new MemoryAdapter()
    await service.import(pack, 'fork', adapter, { forkRoleId: 'role-copy' })
    expect(adapter.applied?.role.id).toBe('role-copy')
    expect(adapter.applied?.role.assetBindings[0].ref.roleId).toBe('role-copy')
    const failing = new MemoryAdapter()
    failing.roles.set('existing', createDefaultRpaAppRole('existing', 'Existing'))
    failing.fail = true
    await expect(service.import(pack, 'install', failing)).rejects.toThrow('rolled back')
    expect(failing.roles.has('existing')).toBe(true)
  })
})
