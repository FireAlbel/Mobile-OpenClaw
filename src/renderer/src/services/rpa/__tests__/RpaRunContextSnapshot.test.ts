import type { Model } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/config/models/vision', () => ({ isVisionModel: () => true }))

import { resolveEffectiveRpaContext } from '../EffectiveRpaContextResolver'
import { createDefaultRpaAssistantProfile } from '../RpaAssistantProfile'
import { buildRpaModelContext, createEmbeddedRpaModelContext } from '../RpaModelContextBuilder'
import {
  createRpaDslProvenance,
  createRpaRunContextSnapshot,
  sanitizeRpaRunContextSnapshot
} from '../RpaRunContextSnapshot'
import { createDefaultRpaTopicContextOverride } from '../RpaTopicContextOverride'

const model = { id: 'gpt-5', name: 'GPT-5', provider: 'provider-1', group: 'gpt' } as Model
const catalogs = {
  knowledge: [{ id: 'kb-1', name: 'SOP', version: '2', status: 'ready' as const }],
  skills: [{ id: 'skill-1', name: 'Navigate', version: '3.1.0', status: 'ready' as const }],
  templates: [
    {
      id: 'template-1',
      name: 'Flow',
      version: '4',
      status: 'ready' as const,
      requiredSkills: [],
      optionalKnowledge: []
    }
  ]
}

function effectiveContext() {
  const profile = {
    ...createDefaultRpaAssistantProfile('assistant-1', 1),
    version: 5,
    knowledgeBindings: [{ knowledgeId: 'kb-1', enabled: true, priority: 1 }],
    skillBindings: [{ skillId: 'skill-1', enabled: true, allowAutoMatch: true, priority: 1 }],
    templateBindings: [{ templateId: 'template-1', enabled: true, priority: 1, usage: 'recommended' as const }]
  }
  return resolveEffectiveRpaContext({
    topicId: 'topic-1',
    profile,
    catalogs,
    defaultModel: model,
    availableModels: [model],
    now: () => 100
  })
}

describe('RpaRunContextSnapshot', () => {
  it('records exact DSL provenance selected by planner metadata', () => {
    const provenance = createRpaDslProvenance(effectiveContext(), {
      rpaAssets: { templateId: 'template-1', skillIds: ['skill-1'], knowledgeIds: ['kb-1'] }
    })

    expect(provenance).toMatchObject({
      assistantProfileVersion: 5,
      generatedAt: 100,
      sourceTemplate: undefined,
      compiledSkills: [{ id: 'skill-1', version: '3.1.0' }],
      retrievedKnowledge: [{ id: 'kb-1', version: '2' }],
      activeAssetCounts: { knowledge: 1, skills: 1, templates: 0 },
      models: { planner: { providerId: 'provider-1', modelId: 'gpt-5' } }
    })
  })

  it('creates a replay-safe snapshot with only structural topic override data', () => {
    const context = effectiveContext()
    const provenance = createRpaDslProvenance(context, { rpaAssets: { templateId: 'template-1' } })
    const override = {
      ...createDefaultRpaTopicContextOverride('topic-1', 'assistant-1', 1),
      appPackages: ['com.example.app']
    }
    const snapshot = createRpaRunContextSnapshot(context, provenance, override)

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      topicId: 'topic-1',
      assistantId: 'assistant-1',
      assistantProfileVersion: 5,
      sourceTemplate: undefined,
      skills: [{ id: 'skill-1', version: '3.1.0' }],
      knowledge: [{ id: 'kb-1', version: '2' }],
      topicOverride: { appPackages: ['com.example.app'] }
    })
    expect(JSON.stringify(snapshot)).not.toContain('prompt')
  })

  it('redacts secrets in warnings and discards unrecognized private fields', () => {
    const snapshot = createRpaRunContextSnapshot(
      effectiveContext(),
      createRpaDslProvenance(effectiveContext(), {}),
      undefined
    )
    const unsafe = {
      ...snapshot,
      privatePrompt: 'do not export',
      resolutionWarnings: ['Bearer abcdefghijklmnop', 'sk-1234567890abcdef']
    }
    const sanitized = sanitizeRpaRunContextSnapshot(unsafe)

    expect(JSON.stringify(sanitized)).not.toContain('do not export')
    expect(JSON.stringify(sanitized)).not.toContain('abcdefghijklmnop')
    expect(sanitized.resolutionWarnings.join(' ')).toContain('[REDACTED]')
  })

  it('adds optional Role provenance without breaking legacy snapshots', () => {
    const context = {
      ...effectiveContext(),
      roleContext: {
        primaryRole: { id: 'meituan-role', version: 2 },
        supportingRoles: [{ id: 'android-system-role', version: 1 }],
        systemCapabilities: ['android.home'],
        compatibility: {
          source: 'assistant_profile' as const,
          assistantId: 'assistant-1',
          assistantProfileVersion: 5,
          adapterVersion: 1 as const
        }
      }
    }
    const provenance = createRpaDslProvenance(context, {})
    const snapshot = createRpaRunContextSnapshot(context, provenance)

    expect(provenance.roleContext).toEqual(context.roleContext)
    expect(snapshot.roleContext).toEqual(context.roleContext)

    const legacy = { ...snapshot, roleContext: undefined }
    expect(sanitizeRpaRunContextSnapshot(legacy).roleContext).toBeUndefined()
  })

  it('persists model-context provenance without copying prompt or evidence content into the run snapshot', () => {
    const context = effectiveContext()
    const embedded = createEmbeddedRpaModelContext(
      buildRpaModelContext({
        callType: 'planner',
        rolePrompts: [
          {
            schemaVersion: 1,
            id: 'planner-prompt',
            roleId: 'role-1',
            version: '3',
            kind: 'planner',
            content: 'Private role guidance',
            priority: 0,
            status: 'enabled',
            createdAt: 1,
            updatedAt: 1
          }
        ],
        observations: [{ id: 'observation-1', text: 'Private screen text' }],
        model: { providerId: 'provider-1', modelId: 'gpt-5' },
        now: () => 200
      })
    )
    const provenance = createRpaDslProvenance(context, { rpaModelContext: embedded })
    const snapshot = createRpaRunContextSnapshot(context, provenance)
    const serialized = JSON.stringify(snapshot)

    expect(snapshot.modelContexts?.[0]).toMatchObject({
      callType: 'planner',
      model: { providerId: 'provider-1', modelId: 'gpt-5' },
      sources: expect.arrayContaining([
        expect.objectContaining({ sourceId: 'planner-prompt', version: '3' }),
        expect.objectContaining({ sourceId: 'observation-1' })
      ])
    })
    expect(serialized).not.toContain('Private role guidance')
    expect(serialized).not.toContain('Private screen text')
  })
})
