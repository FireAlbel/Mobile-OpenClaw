import { describe, expect, it } from 'vitest'

import { createRpaPlanningAssetContext, validateRpaAssistantBindings } from '../RpaAssistantBindingService'
import { createDefaultRpaAssistantProfile } from '../RpaAssistantProfile'

const catalogs = {
  knowledge: [{ id: 'kb-1', name: 'SOP', version: '2', status: 'ready' as const }],
  skills: [{ id: 'skill-1', name: 'Open app', version: '2.1.0', status: 'ready' as const }],
  templates: [
    {
      id: 'template-1',
      name: 'Daily task',
      version: '3',
      status: 'ready' as const,
      requiredSkills: [{ skillId: 'skill-1', versionRange: '^2.0.0' }],
      optionalKnowledge: [{ knowledgeId: 'kb-1' }]
    }
  ]
}

function profile() {
  return {
    ...createDefaultRpaAssistantProfile('assistant-1', 1),
    knowledgeBindings: [{ knowledgeId: 'kb-1', enabled: true, priority: 2 }],
    skillBindings: [{ skillId: 'skill-1', versionRange: '^2', enabled: true, allowAutoMatch: true, priority: 5 }],
    templateBindings: [
      { templateId: 'template-1', version: '3', enabled: true, priority: 4, usage: 'recommended' as const }
    ]
  }
}

describe('RpaAssistantBindingService', () => {
  it('keeps legacy Template validation separate from the planning context', () => {
    const validation = validateRpaAssistantBindings(profile(), catalogs, ['template-1'])
    const context = createRpaPlanningAssetContext(profile(), catalogs)

    expect(validation).toMatchObject({ executable: true, errors: [] })
    expect(context).toMatchObject({
      assistantId: 'assistant-1',
      templates: [],
      skills: [{ id: 'skill-1', version: '2.1.0' }],
      knowledge: [{ id: 'kb-1', version: '2' }]
    })
  })

  it('blocks a selected Template when a required Skill is missing', () => {
    const missingSkillProfile = { ...profile(), skillBindings: [] }
    const validation = validateRpaAssistantBindings(missingSkillProfile, catalogs, ['template-1'])
    const context = createRpaPlanningAssetContext(missingSkillProfile, catalogs)

    expect(validation.executable).toBe(false)
    expect(validation.errors).toEqual([
      expect.objectContaining({ code: 'required_skill_missing', templateId: 'template-1' })
    ])
    expect(context.templates).toEqual([])
    expect(context.warnings).toEqual([])
  })

  it('degrades with a warning when optional Knowledge is unavailable', () => {
    const missingKnowledgeProfile = { ...profile(), knowledgeBindings: [] }
    const validation = validateRpaAssistantBindings(missingKnowledgeProfile, catalogs, ['template-1'])

    expect(validation.executable).toBe(true)
    expect(validation.warnings).toEqual([
      expect.objectContaining({ code: 'optional_knowledge_missing', assetId: 'kb-1' })
    ])
  })

  it('blocks a selected Template when the bound Skill version is incompatible', () => {
    const incompatibleCatalogs = {
      ...catalogs,
      skills: [{ id: 'skill-1', name: 'Open app', version: '1.5.0', status: 'ready' as const }]
    }

    expect(validateRpaAssistantBindings(profile(), incompatibleCatalogs, ['template-1'])).toMatchObject({
      executable: false,
      errors: [{ code: 'required_skill_version_mismatch', assetId: 'skill-1' }]
    })
  })

  it('preserves missing references as remappable warnings', () => {
    const missingReferenceProfile = {
      ...profile(),
      knowledgeBindings: [{ knowledgeId: 'deleted-kb', enabled: true, priority: 0 }]
    }

    expect(validateRpaAssistantBindings(missingReferenceProfile, catalogs).warnings).toEqual([
      expect.objectContaining({ code: 'asset_missing', assetId: 'deleted-kb' })
    ])
  })
})
