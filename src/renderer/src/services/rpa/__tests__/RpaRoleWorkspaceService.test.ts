import { describe, expect, it } from 'vitest'

import { createDefaultRpaAppRole } from '../RpaAppRole'
import { buildRpaRoleWorkspaceSummary } from '../RpaRoleWorkspaceService'

const emptyCatalogs = {
  knowledgeIds: [],
  skillIds: [],
  artifactIds: [],
  promptIds: []
}

describe('RpaRoleWorkspaceService', () => {
  it('blocks an enabled Role when a required asset or supporting Role is missing', () => {
    const role = {
      ...createDefaultRpaAppRole('role-1', 'Role 1', 1),
      status: 'enabled' as const,
      supportingRoleIds: ['missing-role'],
      assetBindings: [
        {
          ref: { roleId: 'role-1', assetType: 'skill' as const, assetId: 'missing-skill' },
          ownership: 'owned' as const,
          requirement: 'required' as const,
          enabled: true,
          priority: 0
        }
      ]
    }

    const summary = buildRpaRoleWorkspaceSummary({ role, roles: [role], catalogs: emptyCatalogs, runs: [] })

    expect(summary.readiness).toBe('blocked')
    expect(summary.missingSupportingRoleIds).toEqual(['missing-role'])
    expect(summary.brokenBindings).toContainEqual(expect.objectContaining({ assetId: 'missing-skill', required: true }))
  })

  it('marks optional broken assets as degraded and exposes active runs', () => {
    const role = {
      ...createDefaultRpaAppRole('role-1', 'Role 1', 1),
      status: 'enabled' as const,
      assetBindings: [
        {
          ref: { roleId: 'role-1', assetType: 'skill' as const, assetId: 'missing-skill' },
          ownership: 'linked' as const,
          requirement: 'optional' as const,
          enabled: true,
          priority: 0
        }
      ]
    }
    const run = {
      id: 'run-1',
      task: { id: 'task-1', name: 'Task', goal: 'Goal', deviceIds: [], steps: [], metadata: {} },
      deviceIds: [],
      status: 'running' as const,
      createdAt: 1,
      updatedAt: 2,
      deviceRuns: [],
      contextSnapshot: {
        schemaVersion: 1 as const,
        createdAt: 1,
        topicId: 'topic-1',
        assistantId: 'assistant-1',
        assistantProfileVersion: 1,
        models: {
          planner: { providerId: 'p', modelId: 'm' },
          vision: { providerId: 'p', modelId: 'm' },
          verification: { providerId: 'p', modelId: 'm' },
          recovery: { providerId: 'p', modelId: 'm' }
        },
        skills: [],
        knowledge: [],
        appPackages: [],
        resolutionWarnings: [],
        roleContext: { primaryRole: { id: 'role-1', version: 1 }, supportingRoles: [], systemCapabilities: [] }
      }
    }

    const summary = buildRpaRoleWorkspaceSummary({ role, roles: [role], catalogs: emptyCatalogs, runs: [run] })

    expect(summary.readiness).toBe('degraded')
    expect(summary.activeRunIds).toEqual(['run-1'])
  })

  it('ignores legacy provider bindings when calculating readiness', () => {
    const role = {
      ...createDefaultRpaAppRole('role-1', 'Role 1', 1),
      status: 'enabled' as const,
      assetBindings: [
        {
          ref: { roleId: 'role-1', assetType: 'provider' as const, assetId: 'missing-provider' },
          ownership: 'linked' as const,
          requirement: 'required' as const,
          enabled: true,
          priority: 0
        }
      ]
    }

    const summary = buildRpaRoleWorkspaceSummary({ role, roles: [role], catalogs: emptyCatalogs, runs: [] })

    expect(summary.readiness).toBe('ready')
    expect(summary.assetCounts.provider).toBe(0)
    expect(summary.brokenBindings).toEqual([])
  })
})
