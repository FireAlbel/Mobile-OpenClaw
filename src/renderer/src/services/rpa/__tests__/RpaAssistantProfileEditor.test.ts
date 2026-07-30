import { describe, expect, it } from 'vitest'

import { createDefaultRpaAssistantProfile } from '../RpaAssistantProfile'
import { setKnowledgeBindingIds, setModelOverride, setTemplateBindingIds } from '../RpaAssistantProfileEditor'

describe('RpaAssistantProfileEditor', () => {
  it('preserves existing binding options and creates defaults for new assets', () => {
    const profile = {
      ...createDefaultRpaAssistantProfile('assistant-1', 1),
      knowledgeBindings: [{ knowledgeId: 'kb-1', enabled: false, priority: 8, retrievalLimit: 10 }],
      templateBindings: [
        { templateId: 'template-1', version: '2', enabled: true, priority: 5, usage: 'quick_start' as const }
      ]
    }

    const withKnowledge = setKnowledgeBindingIds(profile, ['kb-1', 'kb-2', 'kb-2'])
    const withTemplates = setTemplateBindingIds(withKnowledge, ['template-1', 'template-2'])

    expect(withTemplates.knowledgeBindings).toEqual([
      { knowledgeId: 'kb-1', enabled: false, priority: 8, retrievalLimit: 10 },
      { knowledgeId: 'kb-2', enabled: true, priority: 0, retrievalLimit: 5 }
    ])
    expect(withTemplates.templateBindings).toEqual([
      { templateId: 'template-1', version: '2', enabled: true, priority: 5, usage: 'quick_start' },
      { templateId: 'template-2', enabled: true, priority: 0, usage: 'recommended' }
    ])
  })

  it('updates one model override without losing the others and removes an empty override object', () => {
    const profile = createDefaultRpaAssistantProfile('assistant-1', 1)
    const withVision = setModelOverride(profile, 'vision', { providerId: 'openai', modelId: 'vision-1' })
    const withRecovery = setModelOverride(withVision, 'recovery', { providerId: 'openai', modelId: 'text-1' })

    expect(withRecovery.modelOverrides).toEqual({
      vision: { providerId: 'openai', modelId: 'vision-1' },
      recovery: { providerId: 'openai', modelId: 'text-1' }
    })
    expect(
      setModelOverride(setModelOverride(withRecovery, 'vision', undefined), 'recovery', undefined).modelOverrides
    ).toBe(undefined)
  })
})
