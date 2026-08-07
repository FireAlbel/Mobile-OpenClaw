import type { Model } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/config/models/vision', () => ({ isVisionModel: () => true }))

import { resolveEffectiveRpaRoleContext } from '../EffectiveRpaRoleContextResolver'
import { createDefaultRpaAppRole, type RpaAppRole, type RpaAppRoleAssetBinding } from '../RpaAppRole'
import { createDefaultRpaAssistantProfile } from '../RpaAssistantProfile'

const defaultModel = { id: 'gpt-5', name: 'GPT-5', provider: 'provider-1', group: 'gpt' } as Model
const plannerModel = { id: 'planner-1', name: 'Planner', provider: 'provider-2', group: 'planner' } as Model
const catalogs = {
  knowledge: [{ id: 'kb-1', name: 'SOP', version: '1', status: 'ready' as const }],
  skills: [{ id: 'skill-1', name: 'Navigate', version: '2.2.0', status: 'ready' as const }],
  templates: [
    {
      id: 'template-1',
      name: 'Flow',
      version: '3',
      status: 'ready' as const,
      requiredSkills: [],
      optionalKnowledge: []
    }
  ]
}

function binding(
  roleId: string,
  assetType: RpaAppRoleAssetBinding['ref']['assetType'],
  assetId: string,
  options: Partial<RpaAppRoleAssetBinding> & { version?: string } = {}
): RpaAppRoleAssetBinding {
  return {
    ref: { roleId, assetType, assetId, version: options.version },
    ownership: options.ownership ?? 'owned',
    requirement: options.requirement ?? 'optional',
    enabled: options.enabled ?? true,
    priority: options.priority ?? 0
  }
}

function role(id: string, bindings: RpaAppRoleAssetBinding[] = []): RpaAppRole {
  return {
    ...createDefaultRpaAppRole(id, id, 1),
    status: 'enabled',
    appPackages: [`com.example.${id}`],
    assetBindings: bindings
  }
}

describe('EffectiveRpaRoleContextResolver', () => {
  it('combines primary, supporting, and compatibility assets into an immutable context', () => {
    const primary = {
      ...role('primary', [binding('primary', 'skill', 'skill-1', { version: '^2', requirement: 'required' })]),
      supportingRoleIds: ['support'],
      systemCapabilities: ['android.home']
    }
    const support = role('support', [binding('support', 'knowledge', 'kb-1', { ownership: 'shared', priority: 5 })])
    const compatibilityProfile = {
      ...createDefaultRpaAssistantProfile('assistant-1', 1),
      version: 4,
      templateBindings: [{ templateId: 'template-1', enabled: true, priority: 2, usage: 'recommended' as const }]
    }

    const context = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: primary,
      supportingRoles: [support],
      compatibilityProfile,
      catalogs,
      defaultModel,
      availableModels: [defaultModel],
      now: () => 100
    })

    expect(context).toMatchObject({
      executable: true,
      assistantId: 'assistant-1',
      assistantProfileVersion: 4,
      appPackages: ['com.example.primary', 'com.example.support'],
      roleContext: {
        primaryRole: { id: 'primary', version: 1 },
        supportingRoles: [{ id: 'support', version: 1 }],
        systemCapabilities: ['android.home']
      }
    })
    expect(context.assets.skills).toEqual([expect.objectContaining({ id: 'skill-1' })])
    expect(context.assets.knowledge).toEqual([expect.objectContaining({ id: 'kb-1', priority: 5 })])
    expect(context.assets.templates).toEqual([])
    expect(context.roleAssets.skill[0]).toMatchObject({ requirement: 'required', sourceRoleId: 'primary' })
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.roleAssets.skill)).toBe(true)
  })

  it('blocks required missing assets but only warns for optional missing assets', () => {
    const required = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: role('primary', [binding('primary', 'skill', 'missing', { requirement: 'required' })]),
      catalogs,
      defaultModel,
      availableModels: [defaultModel]
    })
    const optional = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: role('primary', [binding('primary', 'knowledge', 'missing')]),
      catalogs,
      defaultModel,
      availableModels: [defaultModel]
    })

    expect(required.executable).toBe(false)
    expect(required.roleIssues).toContainEqual(expect.objectContaining({ code: 'required_asset_missing' }))
    expect(optional.executable).toBe(true)
    expect(optional.roleIssues).toContainEqual(expect.objectContaining({ code: 'optional_asset_missing' }))
  })

  it('reports a bound Knowledge Base that has no usable reviewed RPA entries', () => {
    const optionalContext = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: role('primary', [binding('primary', 'knowledge', 'kb-1')]),
      catalogs,
      assetAvailability: [{ assetType: 'knowledge', assetId: 'kb-1', status: 'error' }],
      defaultModel,
      availableModels: [defaultModel]
    })
    const requiredContext = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: role('primary', [binding('primary', 'knowledge', 'kb-1', { requirement: 'required' })]),
      catalogs,
      assetAvailability: [{ assetType: 'knowledge', assetId: 'kb-1', status: 'error' }],
      defaultModel,
      availableModels: [defaultModel]
    })

    expect(optionalContext.executable).toBe(true)
    expect(optionalContext.roleIssues).toContainEqual(
      expect.objectContaining({ code: 'optional_asset_unavailable', severity: 'warning' })
    )
    expect(requiredContext.executable).toBe(false)
    expect(requiredContext.roleIssues).toContainEqual(
      expect.objectContaining({ code: 'required_asset_unavailable', severity: 'error' })
    )
  })

  it('treats legacy Role status as compatibility metadata instead of an execution gate', () => {
    const primary = {
      ...role('primary'),
      status: 'draft' as const,
      supportingRoleIds: ['support']
    }
    const support = { ...role('support'), status: 'disabled' as const }

    const context = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: primary,
      supportingRoles: [support],
      catalogs,
      defaultModel,
      availableModels: [defaultModel]
    })

    expect(context.executable).toBe(true)
    expect(context.roleContext).toMatchObject({
      primaryRole: { id: 'primary', version: 1 },
      supportingRoles: [{ id: 'support', version: 1 }]
    })
  })

  it('blocks conflicting required versions across Roles', () => {
    const primary = {
      ...role('primary', [binding('primary', 'skill', 'skill-1', { version: '^2', requirement: 'required' })]),
      supportingRoleIds: ['support']
    }
    const support = role('support', [
      binding('support', 'skill', 'skill-1', { version: '^3', requirement: 'required' })
    ])

    const context = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: primary,
      supportingRoles: [support],
      catalogs,
      defaultModel,
      availableModels: [defaultModel]
    })

    expect(context.executable).toBe(false)
    expect(context.roleIssues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'required_asset_version_conflict', severity: 'error' })])
    )
  })

  it('rejects undeclared cross-Role references and unresolved supporting Roles', () => {
    const primary = {
      ...role('primary', [binding('other-role', 'knowledge', 'kb-1', { ownership: 'linked' })]),
      supportingRoleIds: ['missing-support']
    }
    const context = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: primary,
      catalogs,
      defaultModel,
      availableModels: [defaultModel]
    })

    expect(context.executable).toBe(false)
    expect(context.roleIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'supporting_role_missing' }),
        expect.objectContaining({ code: 'cross_role_reference_not_permitted' })
      ])
    )
  })

  it('uses the primary Role model override and records a shadowed supporting model', () => {
    const primary = {
      ...role('primary'),
      supportingRoleIds: ['support'],
      modelDefaults: { planner: { providerId: 'provider-2', modelId: 'planner-1' } }
    }
    const support = {
      ...role('support'),
      modelDefaults: { planner: { providerId: 'provider-1', modelId: 'gpt-5' } }
    }
    const context = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: primary,
      supportingRoles: [support],
      catalogs,
      defaultModel,
      availableModels: [defaultModel, plannerModel]
    })

    expect(context.models.planner).toEqual(plannerModel)
    expect(context.roleIssues).toContainEqual(expect.objectContaining({ code: 'model_override_shadowed' }))
  })

  it('ignores legacy provider bindings while preserving Role model overrides', () => {
    const primary = {
      ...role('primary', [
        binding('primary', 'provider', 'missing-provider', {
          requirement: 'required'
        })
      ]),
      modelDefaults: { planner: { providerId: 'provider-2', modelId: 'planner-1' } }
    }

    const context = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: primary,
      catalogs,
      defaultModel,
      availableModels: [defaultModel, plannerModel]
    })

    expect(context.executable).toBe(true)
    expect(context.roleAssets.provider).toEqual([])
    expect(context.models.planner).toEqual(plannerModel)
    expect(context.roleIssues).not.toContainEqual(
      expect.objectContaining({ asset: expect.objectContaining({ assetType: 'provider' }) })
    )
  })

  it('ignores legacy file evidence bindings in the effective Role context', () => {
    const context = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: role('primary', [
        binding('primary', 'artifact', 'legacy-evidence', {
          requirement: 'required'
        })
      ]),
      catalogs,
      defaultModel,
      availableModels: [defaultModel]
    })

    expect(context.executable).toBe(true)
    expect(context.roleAssets.artifact).toEqual([])
    expect(context.roleIssues).not.toContainEqual(
      expect.objectContaining({ asset: expect.objectContaining({ assetType: 'artifact' }) })
    )
  })

  it('ignores supporting Roles that the primary Role did not declare', () => {
    const undeclared = {
      ...role('undeclared', [binding('undeclared', 'knowledge', 'kb-1')]),
      modelDefaults: { planner: { providerId: 'provider-2', modelId: 'planner-1' } }
    }

    const context = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: role('primary'),
      supportingRoles: [undeclared],
      catalogs,
      defaultModel,
      availableModels: [defaultModel, plannerModel]
    })

    expect(context.roleContext.supportingRoles).toEqual([])
    expect(context.roleAssets.knowledge).toEqual([])
    expect(context.models.planner).toEqual(defaultModel)
  })

  it('resolves versioned prompts only from declared Roles and preserves primary precedence', () => {
    const primary = {
      ...role('primary', [binding('primary', 'prompt', 'planner-prompt', { version: '2', priority: 5 })]),
      supportingRoleIds: ['support']
    }
    const support = role('support', [binding('support', 'prompt', 'support-prompt', { version: '1', priority: 100 })])
    const context = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: primary,
      supportingRoles: [support, role('undeclared')],
      promptCatalog: [
        {
          schemaVersion: 1,
          id: 'planner-prompt',
          roleId: 'primary',
          version: '2',
          kind: 'planner',
          content: 'Primary planner guidance',
          priority: 0,
          status: 'enabled',
          createdAt: 1,
          updatedAt: 2
        },
        {
          schemaVersion: 1,
          id: 'support-prompt',
          roleId: 'support',
          version: '1',
          kind: 'planner',
          content: 'Supporting planner guidance',
          priority: 0,
          status: 'enabled',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      catalogs,
      defaultModel,
      availableModels: [defaultModel]
    })

    expect(context.rolePrompts.map((prompt) => prompt.id)).toEqual(['planner-prompt', 'support-prompt'])
    expect(context.rolePrompts[0]).toMatchObject({ sourceRoleId: 'primary', version: '2' })
  })

  it('automatically resolves the latest enabled prompt owned by the selected Role', () => {
    const context = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole: role('primary'),
      promptCatalog: [
        {
          schemaVersion: 1,
          id: 'system-guidance',
          roleId: 'primary',
          version: '1',
          kind: 'system',
          content: 'Old guidance',
          priority: 10,
          status: 'enabled',
          createdAt: 1,
          updatedAt: 1
        },
        {
          schemaVersion: 1,
          id: 'system-guidance',
          roleId: 'primary',
          version: '2',
          kind: 'system',
          content: 'Current guidance',
          priority: 10,
          status: 'enabled',
          createdAt: 1,
          updatedAt: 2
        }
      ],
      catalogs,
      defaultModel,
      availableModels: [defaultModel]
    })

    expect(context.rolePrompts).toMatchObject([
      { id: 'system-guidance', version: '2', content: 'Current guidance', sourceRoleId: 'primary' }
    ])
  })
})
