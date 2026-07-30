import type { EffectiveRpaContext } from './EffectiveRpaContextResolver'
import { type RpaRoleContextProvenance, sanitizeRpaRoleContextProvenance } from './RpaAppRole'
import type { RpaAssistantModelOverrides, RpaModelReference } from './RpaAssistantProfile'
import {
  readEmbeddedRpaModelContext,
  type RpaModelContextProvenance,
  sanitizeRpaModelContextProvenance
} from './RpaModelContextBuilder'
import type { RpaTopicContextOverride } from './RpaTopicContextOverride'

const SECRET_VALUE = /(bearer\s+)[a-z0-9._~+/-]+=*|\bsk-[a-z0-9_-]{12,}\b/gi

export interface RpaVersionedAssetReference {
  id: string
  version?: string
}

export interface RpaDslProvenance {
  assistantId: string
  assistantProfileVersion: number
  topicOverrideVersion?: number
  generatedAt: number
  sourceTemplate?: RpaVersionedAssetReference
  compiledSkills: RpaVersionedAssetReference[]
  retrievedKnowledge: RpaVersionedAssetReference[]
  activeAssetCounts: { knowledge: number; skills: number; templates: number }
  models: {
    planner: RpaModelReference
    vision: RpaModelReference
    verification: RpaModelReference
    recovery: RpaModelReference
  }
  warnings: string[]
  roleContext?: RpaRoleContextProvenance
  modelContexts?: RpaModelContextProvenance[]
  supplementRevision?: number
  supplementalContextSnapshotId?: string
}

export interface RpaRunContextSnapshot {
  schemaVersion: 1
  createdAt: number
  topicId: string
  assistantId: string
  assistantProfileVersion: number
  models: RpaDslProvenance['models']
  sourceTemplate?: RpaVersionedAssetReference
  skills: RpaVersionedAssetReference[]
  knowledge: RpaVersionedAssetReference[]
  appPackages: string[]
  topicOverride?: {
    assistantId: string
    version: number
    knowledge: RpaVersionedAssetReference[]
    skills: Array<RpaVersionedAssetReference & { versionRange?: string }>
    templates: RpaVersionedAssetReference[]
    exclusions: {
      knowledgeIds: string[]
      skillIds: string[]
      templateIds: string[]
    }
    appPackages: string[]
    modelOverrides?: RpaAssistantModelOverrides
  }
  resolutionWarnings: string[]
  roleContext?: RpaRoleContextProvenance
  modelContexts?: RpaModelContextProvenance[]
  supplementRevision?: number
  supplementalContextSnapshotId?: string
}

export function createRpaDslProvenance(
  context: EffectiveRpaContext,
  taskMetadata: Record<string, unknown>
): RpaDslProvenance {
  const selection = readTaskAssetSelection(taskMetadata)
  const sourceTemplateId =
    selection.templateId ?? (context.selectedTemplateIds.length === 1 ? context.selectedTemplateIds[0] : undefined)
  const sourceTemplate = sourceTemplateId
    ? context.assets.templates.find((asset) => asset.id === sourceTemplateId)
    : undefined
  const selectedSkillIds = new Set(selection.skillIds)
  const selectedKnowledgeIds = new Set(selection.knowledgeIds)

  return {
    assistantId: context.assistantId,
    assistantProfileVersion: context.assistantProfileVersion,
    topicOverrideVersion: context.topicOverrideVersion,
    generatedAt: context.resolvedAt,
    sourceTemplate: sourceTemplate ? { id: sourceTemplate.id, version: sourceTemplate.version } : undefined,
    compiledSkills: context.assets.skills
      .filter((asset) => selectedSkillIds.has(asset.id))
      .map((asset) => ({ id: asset.id, version: asset.version })),
    retrievedKnowledge: context.assets.knowledge
      .filter((asset) => selectedKnowledgeIds.has(asset.id))
      .map((asset) => ({ id: asset.id, version: asset.version })),
    activeAssetCounts: {
      knowledge: context.assets.knowledge.length,
      skills: context.assets.skills.length,
      templates: context.assets.templates.length
    },
    models: cloneModelReferences(context.modelReferences),
    warnings: sanitizeWarnings(context.warnings.map((warning) => warning.message)),
    roleContext: sanitizeRpaRoleContextProvenance(context.roleContext),
    modelContexts: readTaskModelContexts(taskMetadata)
  }
}

export function sanitizeRpaDslProvenance(provenance: RpaDslProvenance): RpaDslProvenance {
  return {
    assistantId: cleanId(provenance.assistantId),
    assistantProfileVersion: positiveInteger(provenance.assistantProfileVersion),
    topicOverrideVersion:
      provenance.topicOverrideVersion === undefined ? undefined : positiveInteger(provenance.topicOverrideVersion),
    generatedAt: finiteTimestamp(provenance.generatedAt),
    sourceTemplate: sanitizeAsset(provenance.sourceTemplate),
    compiledSkills: sanitizeAssets(provenance.compiledSkills),
    retrievedKnowledge: sanitizeAssets(provenance.retrievedKnowledge),
    activeAssetCounts: {
      knowledge: nonNegativeInteger(provenance.activeAssetCounts.knowledge),
      skills: nonNegativeInteger(provenance.activeAssetCounts.skills),
      templates: nonNegativeInteger(provenance.activeAssetCounts.templates)
    },
    models: cloneModelReferences(provenance.models),
    warnings: sanitizeWarnings(provenance.warnings),
    roleContext: sanitizeRpaRoleContextProvenance(provenance.roleContext),
    modelContexts: (provenance.modelContexts ?? []).map(sanitizeRpaModelContextProvenance),
    supplementRevision:
      provenance.supplementRevision === undefined ? undefined : nonNegativeInteger(provenance.supplementRevision),
    supplementalContextSnapshotId: cleanOptional(provenance.supplementalContextSnapshotId)
  }
}

export function createRpaRunContextSnapshot(
  context: EffectiveRpaContext,
  provenance: RpaDslProvenance,
  topicOverride?: RpaTopicContextOverride
): RpaRunContextSnapshot {
  return sanitizeRpaRunContextSnapshot({
    schemaVersion: 1,
    createdAt: context.resolvedAt,
    topicId: context.topicId,
    assistantId: context.assistantId,
    assistantProfileVersion: context.assistantProfileVersion,
    models: cloneModelReferences(context.modelReferences),
    sourceTemplate: provenance.sourceTemplate,
    skills: context.assets.skills.map((asset) => ({ id: asset.id, version: asset.version })),
    knowledge: context.assets.knowledge.map((asset) => ({ id: asset.id, version: asset.version })),
    appPackages: [...context.appPackages],
    topicOverride: topicOverride
      ? {
          assistantId: topicOverride.assistantId,
          version: topicOverride.version,
          knowledge: topicOverride.knowledgeBindings.map((binding) => ({
            id: binding.knowledgeId,
            version: binding.version
          })),
          skills: topicOverride.skillBindings.map((binding) => ({
            id: binding.skillId,
            versionRange: binding.versionRange
          })),
          templates: topicOverride.templateBindings.map((binding) => ({
            id: binding.templateId,
            version: binding.version
          })),
          exclusions: {
            knowledgeIds: [...topicOverride.exclusions.knowledgeIds],
            skillIds: [...topicOverride.exclusions.skillIds],
            templateIds: [...topicOverride.exclusions.templateIds]
          },
          appPackages: [...topicOverride.appPackages],
          modelOverrides: topicOverride.modelOverrides
        }
      : undefined,
    resolutionWarnings: sanitizeWarnings(context.warnings.map((warning) => warning.message)),
    roleContext: sanitizeRpaRoleContextProvenance(context.roleContext ?? provenance.roleContext),
    modelContexts: (provenance.modelContexts ?? []).map(sanitizeRpaModelContextProvenance),
    supplementRevision: provenance.supplementRevision,
    supplementalContextSnapshotId: provenance.supplementalContextSnapshotId
  })
}

export function sanitizeRpaRunContextSnapshot(snapshot: RpaRunContextSnapshot): RpaRunContextSnapshot {
  return {
    schemaVersion: 1,
    createdAt: finiteTimestamp(snapshot.createdAt),
    topicId: cleanId(snapshot.topicId),
    assistantId: cleanId(snapshot.assistantId),
    assistantProfileVersion: positiveInteger(snapshot.assistantProfileVersion),
    models: cloneModelReferences(snapshot.models),
    sourceTemplate: sanitizeAsset(snapshot.sourceTemplate),
    skills: sanitizeAssets(snapshot.skills),
    knowledge: sanitizeAssets(snapshot.knowledge),
    appPackages: sanitizeIds(snapshot.appPackages),
    topicOverride: snapshot.topicOverride
      ? {
          assistantId: cleanId(snapshot.topicOverride.assistantId),
          version: positiveInteger(snapshot.topicOverride.version),
          knowledge: sanitizeAssets(snapshot.topicOverride.knowledge),
          skills: sanitizeTopicSkills(snapshot.topicOverride.skills),
          templates: sanitizeAssets(snapshot.topicOverride.templates),
          exclusions: {
            knowledgeIds: sanitizeIds(snapshot.topicOverride.exclusions.knowledgeIds),
            skillIds: sanitizeIds(snapshot.topicOverride.exclusions.skillIds),
            templateIds: sanitizeIds(snapshot.topicOverride.exclusions.templateIds)
          },
          appPackages: sanitizeIds(snapshot.topicOverride.appPackages),
          modelOverrides: sanitizeModelOverrides(snapshot.topicOverride.modelOverrides)
        }
      : undefined,
    resolutionWarnings: sanitizeWarnings(snapshot.resolutionWarnings),
    roleContext: sanitizeRpaRoleContextProvenance(snapshot.roleContext),
    modelContexts: (snapshot.modelContexts ?? []).map(sanitizeRpaModelContextProvenance),
    supplementRevision:
      snapshot.supplementRevision === undefined ? undefined : nonNegativeInteger(snapshot.supplementRevision),
    supplementalContextSnapshotId: cleanOptional(snapshot.supplementalContextSnapshotId)
  }
}

export function trySanitizeRpaRunContextSnapshot(value: unknown): RpaRunContextSnapshot | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.models)) return undefined
  if (
    typeof value.topicId !== 'string' ||
    typeof value.assistantId !== 'string' ||
    typeof value.createdAt !== 'number' ||
    typeof value.assistantProfileVersion !== 'number'
  ) {
    return undefined
  }
  for (const capability of ['planner', 'vision', 'verification', 'recovery']) {
    const reference = value.models[capability]
    if (!isRecord(reference) || typeof reference.providerId !== 'string' || typeof reference.modelId !== 'string') {
      return undefined
    }
  }
  return sanitizeRpaRunContextSnapshot(value as unknown as RpaRunContextSnapshot)
}

function readTaskAssetSelection(metadata: Record<string, unknown>): {
  templateId?: string
  skillIds: string[]
  knowledgeIds: string[]
} {
  const assets = metadata.rpaAssets
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) {
    return { skillIds: [], knowledgeIds: [] }
  }
  const record = assets as Record<string, unknown>
  return {
    templateId: cleanOptional(record.templateId),
    skillIds: sanitizeIds(record.skillIds),
    knowledgeIds: sanitizeIds(record.knowledgeIds)
  }
}

function readTaskModelContexts(metadata: Record<string, unknown>): RpaModelContextProvenance[] {
  const context = readEmbeddedRpaModelContext(metadata.rpaModelContext)
  return context ? [context.provenance] : []
}

function cloneModelReferences(models: RpaDslProvenance['models']): RpaDslProvenance['models'] {
  return {
    planner: sanitizeModelReference(models.planner),
    vision: sanitizeModelReference(models.vision),
    verification: sanitizeModelReference(models.verification),
    recovery: sanitizeModelReference(models.recovery)
  }
}

function sanitizeModelOverrides(value?: RpaAssistantModelOverrides): RpaAssistantModelOverrides | undefined {
  if (!value) return undefined
  const planner = value.planner ? sanitizeModelReference(value.planner) : undefined
  const vision = value.vision ? sanitizeModelReference(value.vision) : undefined
  const verification = value.verification ? sanitizeModelReference(value.verification) : undefined
  const recovery = value.recovery ? sanitizeModelReference(value.recovery) : undefined
  return planner || vision || verification || recovery ? { planner, vision, verification, recovery } : undefined
}

function sanitizeModelReference(reference: RpaModelReference): RpaModelReference {
  return { providerId: cleanId(reference.providerId), modelId: cleanId(reference.modelId) }
}

function sanitizeAssets(values: RpaVersionedAssetReference[]): RpaVersionedAssetReference[] {
  const assets = new Map<string, RpaVersionedAssetReference>()
  for (const value of values ?? []) {
    const asset = sanitizeAsset(value)
    if (asset) assets.set(asset.id, asset)
  }
  return [...assets.values()]
}

function sanitizeTopicSkills(
  values: Array<RpaVersionedAssetReference & { versionRange?: string }>
): Array<RpaVersionedAssetReference & { versionRange?: string }> {
  const skills = new Map<string, RpaVersionedAssetReference & { versionRange?: string }>()
  for (const value of values ?? []) {
    const asset = sanitizeAsset(value)
    if (!asset) continue
    skills.set(asset.id, { ...asset, versionRange: cleanOptional(value.versionRange) })
  }
  return [...skills.values()]
}

function sanitizeAsset(value?: RpaVersionedAssetReference): RpaVersionedAssetReference | undefined {
  if (!value?.id?.trim()) return undefined
  return { id: cleanId(value.id), version: cleanOptional(value.version) }
}

function sanitizeIds(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map(cleanId)
        .filter(Boolean)
    )
  ]
}

function sanitizeWarnings(values: string[]): string[] {
  return [...new Set((values ?? []).map((value) => value.replace(SECRET_VALUE, '$1[REDACTED]').slice(0, 500)))]
}

function cleanId(value: string): string {
  return value.trim().slice(0, 256)
}

function cleanOptional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : undefined
}

function positiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function finiteTimestamp(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
