import type { Model } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/config/models/vision', () => ({
  isVisionModel: (model: Model) => model.id === 'gpt-5'
}))

import {
  adaptRpaTopicOverrideForAssistant,
  assessRpaTopicOverrideCompatibility,
  resolveEffectiveRpaContext
} from '../EffectiveRpaContextResolver'
import { createDefaultRpaAssistantProfile } from '../RpaAssistantProfile'
import { createDefaultRpaTopicContextOverride } from '../RpaTopicContextOverride'

const visionModel = {
  id: 'gpt-5',
  name: 'GPT-5',
  provider: 'provider-1',
  group: 'gpt'
} as Model
const textModel = {
  id: 'o3-mini',
  name: 'o3-mini',
  provider: 'provider-1',
  group: 'o3'
} as Model
const catalogs = {
  knowledge: [
    { id: 'kb-1', name: 'Default SOP', version: '1', status: 'ready' as const },
    { id: 'kb-2', name: 'Topic SOP', version: '2', status: 'ready' as const }
  ],
  skills: [{ id: 'skill-1', name: 'Navigate', version: '2.1.0', status: 'ready' as const }],
  templates: [
    {
      id: 'template-1',
      name: 'Quick start',
      version: '3',
      status: 'ready' as const,
      requiredSkills: [{ skillId: 'skill-1', versionRange: '^2' }],
      optionalKnowledge: [{ knowledgeId: 'kb-1' }]
    }
  ]
}

function profile() {
  return {
    ...createDefaultRpaAssistantProfile('assistant-1', 1),
    version: 4,
    knowledgeBindings: [{ knowledgeId: 'kb-1', enabled: true, priority: 1 }],
    skillBindings: [{ skillId: 'skill-1', enabled: true, allowAutoMatch: true, priority: 2, versionRange: '^2' }],
    templateBindings: [{ templateId: 'template-1', enabled: true, priority: 3, usage: 'recommended' as const }]
  }
}

function topicOverride() {
  return {
    ...createDefaultRpaTopicContextOverride('topic-1', 'assistant-1', 2),
    version: 3,
    knowledgeBindings: [{ knowledgeId: 'kb-2', enabled: true, priority: 8 }],
    exclusions: { knowledgeIds: ['kb-1'], skillIds: ['skill-1'], templateIds: [] },
    appPackages: ['com.topic.app']
  }
}

describe('EffectiveRpaContextResolver', () => {
  it('applies topic and execution precedence and returns an immutable context', () => {
    const systemDefaults = {
      ...createDefaultRpaAssistantProfile('system', 0),
      knowledgeBindings: [{ knowledgeId: 'kb-2', enabled: true, priority: -1 }]
    }
    const context = resolveEffectiveRpaContext({
      topicId: 'topic-1',
      profile: profile(),
      catalogs,
      defaultModel: visionModel,
      availableModels: [visionModel],
      systemDefaults,
      topicOverride: topicOverride(),
      executionOverride: {
        knowledgeBindings: [{ knowledgeId: 'kb-2', enabled: true, priority: 20, version: '2' }],
        appPackages: ['com.execution.app']
      },
      now: () => 100
    })

    expect(context).toMatchObject({
      assistantProfileVersion: 4,
      topicOverrideVersion: 3,
      appPackages: ['com.execution.app'],
      resolvedAt: 100,
      assets: { knowledge: [{ id: 'kb-2', priority: 20, version: '2' }] }
    })
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.assets.knowledge)).toBe(true)
  })

  it('restores an excluded required Skill after a Template is selected', () => {
    const context = resolveEffectiveRpaContext({
      topicId: 'topic-1',
      profile: profile(),
      catalogs,
      defaultModel: visionModel,
      availableModels: [visionModel],
      topicOverride: topicOverride(),
      executionOverride: { selectedTemplateIds: ['template-1'] }
    })

    expect(context.executable).toBe(true)
    expect(context.assets.skills).toEqual([expect.objectContaining({ id: 'skill-1' })])
    expect(context.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'required_dependency_restored', assetId: 'skill-1' })])
    )
  })

  it('blocks execution when a selected Template dependency is not permitted by the assistant', () => {
    const withoutSkill = { ...profile(), skillBindings: [] }
    const context = resolveEffectiveRpaContext({
      topicId: 'topic-1',
      profile: withoutSkill,
      catalogs,
      defaultModel: visionModel,
      availableModels: [visionModel],
      executionOverride: { selectedTemplateIds: ['template-1'] }
    })

    expect(context.executable).toBe(false)
    expect(context.missingDependencies).toEqual([expect.objectContaining({ code: 'required_skill_missing' })])
  })

  it('applies topic model overrides and reports incompatible visual capability', () => {
    const override = {
      ...topicOverride(),
      modelOverrides: { vision: { providerId: 'provider-1', modelId: 'o3-mini' } }
    }
    const context = resolveEffectiveRpaContext({
      topicId: 'topic-1',
      profile: profile(),
      catalogs,
      defaultModel: visionModel,
      availableModels: [visionModel, textModel],
      topicOverride: override
    })

    expect(context.executable).toBe(true)
    expect(context.models.vision).toEqual(textModel)
    expect(context.capabilityChecks.vision).toMatchObject({ available: true, compatible: false })
  })

  it('falls back to the selected chat model when a capability override is unavailable', () => {
    const overriddenProfile = {
      ...profile(),
      modelOverrides: {
        vision: { providerId: 'removed-provider', modelId: 'removed-model' },
        verification: { providerId: 'removed-provider', modelId: 'removed-model' },
        recovery: { providerId: 'removed-provider', modelId: 'removed-model' }
      }
    }
    const context = resolveEffectiveRpaContext({
      topicId: 'topic-1',
      profile: overriddenProfile,
      catalogs,
      defaultModel: visionModel,
      availableModels: [visionModel]
    })

    expect(context.models).toEqual({
      planner: visionModel,
      vision: visionModel,
      verification: visionModel,
      recovery: visionModel
    })
    expect(context.modelReferences.vision).toEqual({ providerId: 'provider-1', modelId: 'gpt-5' })
    expect(context.executable).toBe(true)
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'model_unavailable',
          message: expect.stringContaining('selected chat model')
        })
      ])
    )
  })

  it('requires an explicit decision when overrides belong to another assistant', () => {
    const override = { ...topicOverride(), assistantId: 'assistant-old' }
    const compatibility = assessRpaTopicOverrideCompatibility(override, 'assistant-1', catalogs)
    const context = resolveEffectiveRpaContext({
      topicId: 'topic-1',
      profile: profile(),
      catalogs,
      defaultModel: visionModel,
      availableModels: [visionModel],
      topicOverride: override
    })

    expect(compatibility).toMatchObject({ compatible: false, assistantChanged: true, recommendedAction: 'clear' })
    expect(context.executable).toBe(false)
    expect(context.warnings).toEqual([expect.objectContaining({ code: 'assistant_switch_decision_required' })])
  })

  it('remaps compatible topic assets or clears the override after an assistant switch', () => {
    const override = {
      ...topicOverride(),
      assistantId: 'assistant-old',
      knowledgeBindings: [
        ...topicOverride().knowledgeBindings,
        { knowledgeId: 'deleted-kb', enabled: true, priority: 0 }
      ]
    }

    expect(adaptRpaTopicOverrideForAssistant(override, 'assistant-1', 'remap', catalogs)).toMatchObject({
      assistantId: 'assistant-1',
      knowledgeBindings: [{ knowledgeId: 'kb-2' }]
    })
    expect(adaptRpaTopicOverrideForAssistant(override, 'assistant-1', 'clear', catalogs)).toBeUndefined()
  })
})
