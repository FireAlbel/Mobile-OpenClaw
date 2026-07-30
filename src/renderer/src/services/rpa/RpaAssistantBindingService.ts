import semver from 'semver'

import type {
  RpaAssistantAssetCatalogItem,
  RpaSkillAssetCatalogItem,
  RpaTemplateAssetCatalogItem
} from './RpaAssistantAssetCatalog'
import type { RpaAssistantProfile } from './RpaAssistantProfile'

export type RpaAssetBindingIssueSeverity = 'error' | 'warning'

export type RpaAssetBindingIssueCode =
  | 'asset_missing'
  | 'asset_disabled'
  | 'asset_version_mismatch'
  | 'required_skill_missing'
  | 'required_skill_version_mismatch'
  | 'optional_knowledge_missing'
  | 'selected_template_missing'
  | 'required_dependency_restored'

export interface RpaAssetBindingIssue {
  severity: RpaAssetBindingIssueSeverity
  code: RpaAssetBindingIssueCode
  assetType: 'knowledge' | 'skill' | 'template'
  assetId: string
  templateId?: string
  message: string
}

export interface RpaAssistantAssetCatalogs {
  knowledge: RpaAssistantAssetCatalogItem[]
  skills: RpaSkillAssetCatalogItem[]
  templates: RpaTemplateAssetCatalogItem[]
}

export interface RpaAssistantBindingValidationResult {
  executable: boolean
  errors: RpaAssetBindingIssue[]
  warnings: RpaAssetBindingIssue[]
}

export interface RpaPlanningAssetContext {
  assistantId: string
  profileVersion: number
  knowledge: Array<{ id: string; name: string; version?: string; priority: number }>
  skills: Array<{ id: string; name: string; version: string; priority: number }>
  templates: Array<{
    id: string
    name: string
    version?: string
    priority: number
    usage: 'recommended' | 'quick_start'
    requiredSkills: RpaTemplateAssetCatalogItem['requiredSkills']
    optionalKnowledge: RpaTemplateAssetCatalogItem['optionalKnowledge']
  }>
  warnings: RpaAssetBindingIssue[]
}

export function validateRpaAssistantBindings(
  profile: RpaAssistantProfile,
  catalogs: RpaAssistantAssetCatalogs,
  selectedTemplateIds: string[] = []
): RpaAssistantBindingValidationResult {
  const issues: RpaAssetBindingIssue[] = []
  const selectedTemplates = new Set(selectedTemplateIds)
  const knowledgeById = new Map(catalogs.knowledge.map((asset) => [asset.id, asset]))
  const skillById = new Map(catalogs.skills.map((asset) => [asset.id, asset]))
  const templateById = new Map(catalogs.templates.map((asset) => [asset.id, asset]))

  for (const binding of profile.knowledgeBindings) {
    validateDirectBinding('knowledge', binding.knowledgeId, binding.enabled, binding.version, knowledgeById, issues)
  }
  for (const binding of profile.skillBindings) {
    validateDirectBinding('skill', binding.skillId, binding.enabled, binding.versionRange, skillById, issues, true)
  }
  for (const binding of profile.templateBindings) {
    validateDirectBinding('template', binding.templateId, binding.enabled, binding.version, templateById, issues)
  }

  for (const templateId of selectedTemplates) {
    const templateBinding = profile.templateBindings.find(
      (binding) => binding.templateId === templateId && binding.enabled
    )
    const template = templateById.get(templateId)
    if (!templateBinding || !template) {
      issues.push({
        severity: 'error',
        code: 'selected_template_missing',
        assetType: 'template',
        assetId: templateId,
        templateId,
        message: `Selected Template "${templateId}" is not enabled or available`
      })
      continue
    }

    for (const requirement of template.requiredSkills) {
      const binding = profile.skillBindings.find(
        (candidate) => candidate.skillId === requirement.skillId && candidate.enabled
      )
      const skill = skillById.get(requirement.skillId)
      if (!binding || !skill || skill.status !== 'ready') {
        issues.push({
          severity: 'error',
          code: 'required_skill_missing',
          assetType: 'skill',
          assetId: requirement.skillId,
          templateId,
          message: `Template "${templateId}" requires enabled Skill "${requirement.skillId}"`
        })
      } else if (
        !versionMatches(skill.version, requirement.versionRange) ||
        !versionMatches(skill.version, binding.versionRange)
      ) {
        issues.push({
          severity: 'error',
          code: 'required_skill_version_mismatch',
          assetType: 'skill',
          assetId: requirement.skillId,
          templateId,
          message: `Skill "${requirement.skillId}" version ${skill.version} does not satisfy the required range`
        })
      }
    }

    for (const reference of template.optionalKnowledge) {
      const binding = profile.knowledgeBindings.find(
        (candidate) => candidate.knowledgeId === reference.knowledgeId && candidate.enabled
      )
      const knowledge = knowledgeById.get(reference.knowledgeId)
      if (!binding || !knowledge || ['missing', 'error'].includes(knowledge.status)) {
        issues.push({
          severity: 'warning',
          code: 'optional_knowledge_missing',
          assetType: 'knowledge',
          assetId: reference.knowledgeId,
          templateId,
          message: `Optional Knowledge "${reference.knowledgeId}" is unavailable; generation will be degraded`
        })
      }
    }
  }

  const errors = deduplicateIssues(issues.filter((issue) => issue.severity === 'error'))
  const warnings = deduplicateIssues(issues.filter((issue) => issue.severity === 'warning'))
  return { executable: errors.length === 0, errors, warnings }
}

export function createRpaPlanningAssetContext(
  profile: RpaAssistantProfile,
  catalogs: RpaAssistantAssetCatalogs
): RpaPlanningAssetContext {
  const knowledgeById = new Map(catalogs.knowledge.map((asset) => [asset.id, asset]))
  const skillById = new Map(catalogs.skills.map((asset) => [asset.id, asset]))

  return {
    assistantId: profile.assistantId,
    profileVersion: profile.version,
    knowledge: profile.knowledgeBindings
      .filter((binding) => binding.enabled && knowledgeById.has(binding.knowledgeId))
      .map((binding) => {
        const asset = knowledgeById.get(binding.knowledgeId)!
        return { id: asset.id, name: asset.name, version: binding.version ?? asset.version, priority: binding.priority }
      })
      .sort(comparePriority),
    skills: profile.skillBindings
      .filter((binding) => binding.enabled && skillById.get(binding.skillId)?.status === 'ready')
      .map((binding) => {
        const asset = skillById.get(binding.skillId)!
        return { id: asset.id, name: asset.name, version: asset.version, priority: binding.priority }
      })
      .sort(comparePriority),
    templates: [],
    warnings: []
  }
}

function validateDirectBinding(
  assetType: RpaAssetBindingIssue['assetType'],
  assetId: string,
  enabled: boolean,
  pinnedVersion: string | undefined,
  catalog: Map<string, RpaAssistantAssetCatalogItem>,
  issues: RpaAssetBindingIssue[],
  versionIsRange = false
): void {
  const asset = catalog.get(assetId)
  if (!asset) {
    issues.push({
      severity: 'warning',
      code: 'asset_missing',
      assetType,
      assetId,
      message: `${assetType} asset "${assetId}" is missing and must be remapped`
    })
    return
  }
  if (!enabled) return
  if (['error', 'missing'].includes(asset.status)) {
    issues.push({
      severity: 'warning',
      code: 'asset_disabled',
      assetType,
      assetId,
      message: `${assetType} asset "${assetId}" is not currently available`
    })
  }
  if (pinnedVersion && asset.version) {
    const matches = versionIsRange ? versionMatches(asset.version, pinnedVersion) : asset.version === pinnedVersion
    if (!matches) {
      issues.push({
        severity: 'warning',
        code: 'asset_version_mismatch',
        assetType,
        assetId,
        message: `${assetType} asset "${assetId}" version ${asset.version} does not match ${pinnedVersion}`
      })
    }
  }
}

function versionMatches(version: string, range?: string): boolean {
  if (!range) return true
  const validVersion = semver.valid(version)
  const validRange = semver.validRange(range)
  if (validVersion && validRange) return semver.satisfies(validVersion, validRange)
  return version === range
}

function comparePriority(left: { priority: number }, right: { priority: number }): number {
  return right.priority - left.priority
}

function deduplicateIssues(issues: RpaAssetBindingIssue[]): RpaAssetBindingIssue[] {
  const unique = new Map<string, RpaAssetBindingIssue>()
  for (const issue of issues) {
    unique.set(`${issue.severity}:${issue.code}:${issue.templateId ?? ''}:${issue.assetId}`, issue)
  }
  return [...unique.values()]
}
