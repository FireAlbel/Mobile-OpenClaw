import type {
  RpaAssistantModelOverrides,
  RpaAssistantProfile,
  RpaKnowledgeBinding,
  RpaModelReference,
  RpaSkillBinding,
  RpaTemplateBinding
} from './RpaAssistantProfile'

export type RpaModelOverrideCapability = keyof RpaAssistantModelOverrides

export function setKnowledgeBindingIds(profile: RpaAssistantProfile, knowledgeIds: string[]): RpaAssistantProfile {
  const existing = new Map(profile.knowledgeBindings.map((binding) => [binding.knowledgeId, binding]))
  return {
    ...profile,
    knowledgeBindings: uniqueIds(knowledgeIds).map(
      (knowledgeId) => existing.get(knowledgeId) ?? { knowledgeId, enabled: true, priority: 0, retrievalLimit: 5 }
    )
  }
}

export function setTemplateBindingIds(profile: RpaAssistantProfile, templateIds: string[]): RpaAssistantProfile {
  const existing = new Map(profile.templateBindings.map((binding) => [binding.templateId, binding]))
  return {
    ...profile,
    templateBindings: uniqueIds(templateIds).map(
      (templateId) => existing.get(templateId) ?? { templateId, enabled: true, priority: 0, usage: 'recommended' }
    )
  }
}

export function setSkillBindingIds(profile: RpaAssistantProfile, skillIds: string[]): RpaAssistantProfile {
  const existing = new Map(profile.skillBindings.map((binding) => [binding.skillId, binding]))
  return {
    ...profile,
    skillBindings: uniqueIds(skillIds).map(
      (skillId) =>
        existing.get(skillId) ?? {
          skillId,
          enabled: true,
          allowAutoMatch: true,
          priority: 0
        }
    )
  }
}

export function updateKnowledgeBinding(
  profile: RpaAssistantProfile,
  knowledgeId: string,
  patch: Partial<Omit<RpaKnowledgeBinding, 'knowledgeId'>>
): RpaAssistantProfile {
  return {
    ...profile,
    knowledgeBindings: profile.knowledgeBindings.map((binding) =>
      binding.knowledgeId === knowledgeId ? { ...binding, ...patch } : binding
    )
  }
}

export function updateSkillBinding(
  profile: RpaAssistantProfile,
  skillId: string,
  patch: Partial<Omit<RpaSkillBinding, 'skillId'>>
): RpaAssistantProfile {
  return {
    ...profile,
    skillBindings: profile.skillBindings.map((binding) =>
      binding.skillId === skillId ? { ...binding, ...patch } : binding
    )
  }
}

export function updateTemplateBinding(
  profile: RpaAssistantProfile,
  templateId: string,
  patch: Partial<Omit<RpaTemplateBinding, 'templateId'>>
): RpaAssistantProfile {
  return {
    ...profile,
    templateBindings: profile.templateBindings.map((binding) =>
      binding.templateId === templateId ? { ...binding, ...patch } : binding
    )
  }
}

export function setModelOverride(
  profile: RpaAssistantProfile,
  capability: RpaModelOverrideCapability,
  reference?: RpaModelReference
): RpaAssistantProfile {
  const modelOverrides = { ...profile.modelOverrides, [capability]: reference }
  if (!modelOverrides.vision && !modelOverrides.verification && !modelOverrides.recovery) {
    return { ...profile, modelOverrides: undefined }
  }
  return { ...profile, modelOverrides }
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
