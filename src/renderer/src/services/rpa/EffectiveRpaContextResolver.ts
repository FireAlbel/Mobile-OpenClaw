import { isVisionModel } from '@renderer/config/models/vision'
import type { Model } from '@renderer/types'

import type { RpaRoleContextProvenance } from './RpaAppRole'
import {
  createRpaPlanningAssetContext,
  type RpaAssetBindingIssue,
  type RpaAssistantAssetCatalogs,
  validateRpaAssistantBindings
} from './RpaAssistantBindingService'
import type {
  RpaAssistantModelOverrides,
  RpaAssistantProfile,
  RpaKnowledgeBinding,
  RpaModelReference,
  RpaSkillBinding,
  RpaTemplateBinding
} from './RpaAssistantProfile'
import type { RpaTopicAssetExclusions, RpaTopicContextOverride } from './RpaTopicContextOverride'

export interface RpaExecutionContextOverride {
  knowledgeBindings?: RpaKnowledgeBinding[]
  skillBindings?: RpaSkillBinding[]
  templateBindings?: RpaTemplateBinding[]
  exclusions?: Partial<RpaTopicAssetExclusions>
  appPackages?: string[]
  selectedTemplateIds?: string[]
  modelOverrides?: RpaAssistantModelOverrides
}

export interface RpaContextCapabilityCheck {
  available: boolean
  compatible: boolean
  message?: string
}

export interface RpaContextModels {
  planner?: Model
  vision?: Model
  verification?: Model
  recovery?: Model
}

export interface RpaContextResolutionWarning {
  code: 'required_dependency_restored' | 'model_unavailable' | 'assistant_switch_decision_required'
  message: string
  assetId?: string
  assetType?: 'knowledge' | 'skill' | 'template'
}

export interface EffectiveRpaContext {
  topicId: string
  assistantId: string
  assistantProfileVersion: number
  topicOverrideVersion?: number
  appPackages: string[]
  selectedTemplateIds: string[]
  models: RpaContextModels
  modelReferences: {
    planner: RpaModelReference
    vision: RpaModelReference
    verification: RpaModelReference
    recovery: RpaModelReference
  }
  capabilityChecks: {
    planner: RpaContextCapabilityCheck
    vision: RpaContextCapabilityCheck
    verification: RpaContextCapabilityCheck
    recovery: RpaContextCapabilityCheck
  }
  assets: ReturnType<typeof createRpaPlanningAssetContext>
  warnings: Array<RpaAssetBindingIssue | RpaContextResolutionWarning>
  missingDependencies: RpaAssetBindingIssue[]
  executable: boolean
  resolvedAt: number
  roleContext?: RpaRoleContextProvenance
}

export interface EffectiveRpaContextResolverInput {
  topicId: string
  profile: RpaAssistantProfile
  catalogs: RpaAssistantAssetCatalogs
  defaultModel: Model
  availableModels: Model[]
  topicOverride?: RpaTopicContextOverride
  systemDefaults?: RpaAssistantProfile
  executionOverride?: RpaExecutionContextOverride
  now?: () => number
}

export interface RpaTopicOverrideCompatibility {
  compatible: boolean
  assistantChanged: boolean
  missingAssets: Array<{ type: 'knowledge' | 'skill' | 'template'; id: string }>
  recommendedAction: 'preserve' | 'remap' | 'clear'
}

export type RpaTopicOverrideSwitchDecision = 'preserve' | 'remap' | 'clear'

export function resolveEffectiveRpaContext(input: EffectiveRpaContextResolverInput): EffectiveRpaContext {
  const warnings: Array<RpaAssetBindingIssue | RpaContextResolutionWarning> = []
  const topicOverride = input.topicOverride
  const executionOverride = input.executionOverride
  const baseProfile = mergeProfiles(input.systemDefaults, input.profile)
  let mergedProfile = baseProfile

  if (topicOverride) {
    mergedProfile = mergeBindings(mergedProfile, topicOverride)
    mergedProfile = applyExclusions(mergedProfile, topicOverride.exclusions)
    if (topicOverride.assistantId !== input.profile.assistantId) {
      warnings.push({
        code: 'assistant_switch_decision_required',
        message: 'Topic overrides belong to another assistant and require preserve, remap, or clear confirmation'
      })
    }
  }

  if (executionOverride) {
    mergedProfile = mergeBindings(mergedProfile, executionOverride)
    mergedProfile = applyExclusions(mergedProfile, normalizeExclusions(executionOverride.exclusions))
  }

  const selectedTemplateIds = uniqueIds(
    executionOverride?.selectedTemplateIds ??
      mergedProfile.templateBindings
        .filter((binding) => binding.enabled && binding.usage === 'quick_start')
        .map((b) => b.templateId)
  )
  mergedProfile = restoreRequiredDependencies(
    mergedProfile,
    mergeBindings(mergeBindings(baseProfile, topicOverride ?? {}), executionOverride ?? {}),
    selectedTemplateIds,
    input.catalogs,
    warnings
  )

  const validation = validateRpaAssistantBindings(mergedProfile, input.catalogs, selectedTemplateIds)
  const assets = createRpaPlanningAssetContext(mergedProfile, input.catalogs)
  const modelOverrides = {
    ...input.systemDefaults?.modelOverrides,
    ...input.profile.modelOverrides,
    ...topicOverride?.modelOverrides,
    ...executionOverride?.modelOverrides
  }
  const defaultReference = toModelReference(input.defaultModel)
  const requestedModelReferences = {
    planner: modelOverrides.planner ?? defaultReference,
    vision: modelOverrides.vision ?? defaultReference,
    verification: modelOverrides.verification ?? defaultReference,
    recovery: modelOverrides.recovery ?? defaultReference
  }
  const modelResolutions = {
    planner: resolveModelWithChatFallback(requestedModelReferences.planner, input.defaultModel, input.availableModels),
    vision: resolveModelWithChatFallback(requestedModelReferences.vision, input.defaultModel, input.availableModels),
    verification: resolveModelWithChatFallback(
      requestedModelReferences.verification,
      input.defaultModel,
      input.availableModels
    ),
    recovery: resolveModelWithChatFallback(requestedModelReferences.recovery, input.defaultModel, input.availableModels)
  }
  const models = {
    planner: modelResolutions.planner.model,
    vision: modelResolutions.vision.model,
    verification: modelResolutions.verification.model,
    recovery: modelResolutions.recovery.model
  }
  const modelReferences = {
    planner: toModelReference(models.planner),
    vision: toModelReference(models.vision),
    verification: toModelReference(models.verification),
    recovery: toModelReference(models.recovery)
  }
  const capabilityChecks = {
    planner: modelCapability(models.planner),
    vision: visionCapability(models.vision),
    verification: modelCapability(models.verification),
    recovery: modelCapability(models.recovery)
  }

  for (const [capability, resolution] of Object.entries(modelResolutions)) {
    if (resolution.usedFallback) {
      warnings.push({
        code: 'model_unavailable',
        message: `${capability} model override is unavailable; the selected chat model is used instead`
      })
    }
  }

  for (const [capability, check] of Object.entries(capabilityChecks)) {
    if (!check.available) {
      warnings.push({ code: 'model_unavailable', message: `${capability} model is unavailable` })
    }
  }

  const assistantSwitchBlocked = warnings.some((warning) => warning.code === 'assistant_switch_decision_required')
  return deepFreeze({
    topicId: input.topicId,
    assistantId: input.profile.assistantId,
    assistantProfileVersion: input.profile.version,
    topicOverrideVersion: topicOverride?.version,
    appPackages: uniqueIds(executionOverride?.appPackages ?? topicOverride?.appPackages ?? []),
    selectedTemplateIds,
    models,
    modelReferences,
    capabilityChecks,
    assets: { ...assets, warnings: [...assets.warnings, ...validation.warnings] },
    warnings: [...warnings, ...validation.warnings],
    missingDependencies: validation.errors,
    executable: validation.executable && !assistantSwitchBlocked && capabilityChecks.planner.compatible,
    resolvedAt: (input.now ?? Date.now)()
  })
}

export function assessRpaTopicOverrideCompatibility(
  override: RpaTopicContextOverride,
  assistantId: string,
  catalogs: RpaAssistantAssetCatalogs
): RpaTopicOverrideCompatibility {
  const catalogIds = {
    knowledge: new Set(catalogs.knowledge.map((asset) => asset.id)),
    skill: new Set(catalogs.skills.map((asset) => asset.id)),
    template: new Set(catalogs.templates.map((asset) => asset.id))
  }
  const missingAssets = [
    ...override.knowledgeBindings
      .filter((binding) => !catalogIds.knowledge.has(binding.knowledgeId))
      .map((binding) => ({ type: 'knowledge' as const, id: binding.knowledgeId })),
    ...override.skillBindings
      .filter((binding) => !catalogIds.skill.has(binding.skillId))
      .map((binding) => ({ type: 'skill' as const, id: binding.skillId })),
    ...override.templateBindings
      .filter((binding) => !catalogIds.template.has(binding.templateId))
      .map((binding) => ({ type: 'template' as const, id: binding.templateId }))
  ]
  const assistantChanged = override.assistantId !== assistantId
  return {
    compatible: !assistantChanged && missingAssets.length === 0,
    assistantChanged,
    missingAssets,
    recommendedAction:
      !assistantChanged && missingAssets.length === 0 ? 'preserve' : missingAssets.length ? 'remap' : 'clear'
  }
}

export function adaptRpaTopicOverrideForAssistant(
  override: RpaTopicContextOverride,
  assistantId: string,
  decision: RpaTopicOverrideSwitchDecision,
  catalogs: RpaAssistantAssetCatalogs
): RpaTopicContextOverride | undefined {
  if (decision === 'clear') return undefined
  if (decision === 'preserve') return { ...override, assistantId }

  const knowledgeIds = new Set(catalogs.knowledge.map((asset) => asset.id))
  const skillIds = new Set(catalogs.skills.map((asset) => asset.id))
  const templateIds = new Set(catalogs.templates.map((asset) => asset.id))
  return {
    ...override,
    assistantId,
    knowledgeBindings: override.knowledgeBindings.filter((binding) => knowledgeIds.has(binding.knowledgeId)),
    skillBindings: override.skillBindings.filter((binding) => skillIds.has(binding.skillId)),
    templateBindings: override.templateBindings.filter((binding) => templateIds.has(binding.templateId)),
    exclusions: {
      knowledgeIds: override.exclusions.knowledgeIds.filter((id) => knowledgeIds.has(id)),
      skillIds: override.exclusions.skillIds.filter((id) => skillIds.has(id)),
      templateIds: override.exclusions.templateIds.filter((id) => templateIds.has(id))
    }
  }
}

function mergeProfiles(
  systemDefaults: RpaAssistantProfile | undefined,
  profile: RpaAssistantProfile
): RpaAssistantProfile {
  return systemDefaults ? mergeBindings({ ...systemDefaults, assistantId: profile.assistantId }, profile) : profile
}

function mergeBindings(
  profile: RpaAssistantProfile,
  override: Partial<
    Pick<RpaAssistantProfile, 'knowledgeBindings' | 'skillBindings' | 'templateBindings' | 'modelOverrides'>
  >
): RpaAssistantProfile {
  return {
    ...profile,
    knowledgeBindings: mergeById(profile.knowledgeBindings, override.knowledgeBindings ?? [], 'knowledgeId'),
    skillBindings: mergeById(profile.skillBindings, override.skillBindings ?? [], 'skillId'),
    templateBindings: mergeById(profile.templateBindings, override.templateBindings ?? [], 'templateId'),
    modelOverrides: { ...profile.modelOverrides, ...override.modelOverrides }
  }
}

function applyExclusions(profile: RpaAssistantProfile, exclusions: RpaTopicAssetExclusions): RpaAssistantProfile {
  const knowledgeIds = new Set(exclusions.knowledgeIds)
  const skillIds = new Set(exclusions.skillIds)
  const templateIds = new Set(exclusions.templateIds)
  return {
    ...profile,
    knowledgeBindings: profile.knowledgeBindings.map((binding) =>
      knowledgeIds.has(binding.knowledgeId) ? { ...binding, enabled: false } : binding
    ),
    skillBindings: profile.skillBindings.map((binding) =>
      skillIds.has(binding.skillId) ? { ...binding, enabled: false } : binding
    ),
    templateBindings: profile.templateBindings.map((binding) =>
      templateIds.has(binding.templateId) ? { ...binding, enabled: false } : binding
    )
  }
}

function restoreRequiredDependencies(
  profile: RpaAssistantProfile,
  permittedProfile: RpaAssistantProfile,
  selectedTemplateIds: string[],
  catalogs: RpaAssistantAssetCatalogs,
  warnings: Array<RpaAssetBindingIssue | RpaContextResolutionWarning>
): RpaAssistantProfile {
  let next = profile
  for (const templateId of selectedTemplateIds) {
    const permittedTemplate = permittedProfile.templateBindings.find((binding) => binding.templateId === templateId)
    if (
      permittedTemplate?.enabled &&
      !next.templateBindings.some((binding) => binding.templateId === templateId && binding.enabled)
    ) {
      next = mergeBindings(next, { templateBindings: [permittedTemplate] })
      warnings.push(restoredWarning('template', templateId, templateId))
    }
    const template = catalogs.templates.find((asset) => asset.id === templateId)
    for (const requirement of template?.requiredSkills ?? []) {
      const permittedSkill = permittedProfile.skillBindings.find(
        (binding) => binding.skillId === requirement.skillId && binding.enabled
      )
      if (
        permittedSkill &&
        !next.skillBindings.some((binding) => binding.skillId === requirement.skillId && binding.enabled)
      ) {
        next = mergeBindings(next, { skillBindings: [permittedSkill] })
        warnings.push(restoredWarning('skill', requirement.skillId, templateId))
      }
    }
  }
  return next
}

function restoredWarning(
  assetType: 'skill' | 'template',
  assetId: string,
  templateId: string
): RpaContextResolutionWarning {
  return {
    code: 'required_dependency_restored',
    assetType,
    assetId,
    message: `Required ${assetType} "${assetId}" was restored for Template "${templateId}"`
  }
}

function normalizeExclusions(value?: Partial<RpaTopicAssetExclusions>): RpaTopicAssetExclusions {
  return {
    knowledgeIds: uniqueIds(value?.knowledgeIds ?? []),
    skillIds: uniqueIds(value?.skillIds ?? []),
    templateIds: uniqueIds(value?.templateIds ?? [])
  }
}

function mergeById<T, K extends keyof T>(base: T[], overrides: T[], key: K): T[] {
  const merged = new Map(base.map((item) => [String(item[key]), item]))
  for (const item of overrides) merged.set(String(item[key]), { ...merged.get(String(item[key])), ...item })
  return [...merged.values()]
}

function resolveModelWithChatFallback(
  reference: RpaModelReference,
  selectedChatModel: Model,
  models: Model[]
): { model: Model; usedFallback: boolean } {
  const requested = models.find((model) => model.id === reference.modelId && model.provider === reference.providerId)
  if (requested) return { model: requested, usedFallback: false }

  const fallbackReference = toModelReference(selectedChatModel)
  return {
    model:
      models.find(
        (model) => model.id === fallbackReference.modelId && model.provider === fallbackReference.providerId
      ) ?? selectedChatModel,
    usedFallback:
      reference.modelId !== fallbackReference.modelId || reference.providerId !== fallbackReference.providerId
  }
}

function toModelReference(model: Model): RpaModelReference {
  return { providerId: model.provider, modelId: model.id }
}

function modelCapability(model?: Model): RpaContextCapabilityCheck {
  return model
    ? { available: true, compatible: true }
    : { available: false, compatible: false, message: 'Model unavailable' }
}

function visionCapability(model?: Model): RpaContextCapabilityCheck {
  if (!model) return { available: false, compatible: false, message: 'Vision model unavailable' }
  return isVisionModel(model)
    ? { available: true, compatible: true }
    : { available: true, compatible: false, message: 'Model does not support image input' }
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}
