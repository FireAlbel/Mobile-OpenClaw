import { loggerService } from '@logger'
import type { KnowledgeBase } from '@renderer/types'

import type { RpaTemplateRecord } from './RpaTemplateRepository'

const logger = loggerService.withContext('RpaAssistantAssetCatalog')

export type RpaAssistantAssetStatus = 'ready' | 'empty' | 'running' | 'error' | 'legacy' | 'missing'

export interface RpaAssistantAssetCatalogItem {
  id: string
  name: string
  version?: string
  status: RpaAssistantAssetStatus
  warning?: string
}

export interface RpaTemplateSkillRequirement {
  skillId: string
  versionRange?: string
}

export interface RpaTemplateKnowledgeReference {
  knowledgeId: string
  version?: string
}

export interface RpaTemplateAssetCatalogItem extends RpaAssistantAssetCatalogItem {
  requiredSkills: RpaTemplateSkillRequirement[]
  optionalKnowledge: RpaTemplateKnowledgeReference[]
}

export interface RpaSkillAssetCatalogItem extends RpaAssistantAssetCatalogItem {
  version: string
}

export interface RpaAssistantAssetRepository<T extends RpaAssistantAssetCatalogItem> {
  list(): Promise<T[]>
  getById(id: string): Promise<T | undefined>
}

export class ReadOnlyRpaAssistantAssetRepository<T extends RpaAssistantAssetCatalogItem>
  implements RpaAssistantAssetRepository<T>
{
  constructor(private readonly loader: () => T[] | Promise<T[]>) {}

  async list(): Promise<T[]> {
    return this.loader()
  }

  async getById(id: string): Promise<T | undefined> {
    return (await this.list()).find((asset) => asset.id === id)
  }
}

export function createKnowledgeAssetCatalog(bases: KnowledgeBase[]): RpaAssistantAssetCatalogItem[] {
  return bases
    .filter((base) => base.id?.trim() && base.name?.trim())
    .map((base) => ({
      id: base.id,
      name: base.name,
      version: base.version > 0 ? String(base.version) : undefined,
      status: getKnowledgeStatus(base),
      warning: base.items.length === 0 ? 'empty' : undefined
    }))
    .sort(compareCatalogItems)
}

export function createRpaTemplateAssetCatalog(templates: RpaTemplateRecord[]): RpaTemplateAssetCatalogItem[] {
  return templates
    .map((template) => {
      const dependencies = readTemplateDependencies(isRecord(template.dsl) ? template.dsl : {})
      return {
        id: template.id,
        name: template.name,
        version: String(template.version),
        status: template.status === 'executable' ? ('ready' as const) : ('error' as const),
        warning: template.status === 'executable' ? undefined : 'draft',
        requiredSkills: template.skillLinks.length
          ? template.skillLinks.map((link) => ({ skillId: link.skillId, versionRange: link.version }))
          : dependencies.requiredSkills,
        optionalKnowledge: dependencies.optionalKnowledge
      }
    })
    .sort(compareCatalogItems)
}

export function loadCompatibilitySkillCatalog(
  storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage
): RpaSkillAssetCatalogItem[] {
  if (!storage) return []

  for (const storageKey of ['rpa_skills', 'rpa_skill_library']) {
    try {
      const raw = storage.getItem(storageKey)
      if (!raw) continue
      const value = JSON.parse(raw) as unknown
      if (!Array.isArray(value)) continue

      const skills: RpaSkillAssetCatalogItem[] = []
      for (const candidate of value) {
        if (!isRecord(candidate)) continue
        const id = normalizeText(candidate.id)
        const name = normalizeText(candidate.name)
        const version = normalizeText(candidate.version)
        if (!id || !name || !version) continue
        skills.push({ id, name, version, status: candidate.enabled === false ? 'legacy' : 'ready' })
      }
      return skills.sort(compareCatalogItems)
    } catch (error) {
      logger.warn('Failed to load compatibility RPA skill catalog', { error, storageKey })
    }
  }

  return []
}

function readTemplateDependencies(
  task: Record<string, unknown>
): Pick<RpaTemplateAssetCatalogItem, 'requiredSkills' | 'optionalKnowledge'> {
  const flowData = isRecord(task.flowData) ? task.flowData : undefined
  const flowMetadata = flowData && isRecord(flowData.metadata) ? flowData.metadata : undefined
  const metadata = isRecord(task.metadata) ? task.metadata : undefined
  const dependencies =
    (isRecord(task.rpaDependencies) && task.rpaDependencies) ||
    (metadata && isRecord(metadata.rpaDependencies) && metadata.rpaDependencies) ||
    (flowMetadata && isRecord(flowMetadata.rpaDependencies) && flowMetadata.rpaDependencies)

  return {
    requiredSkills: sanitizeSkillRequirements(dependencies && dependencies.requiredSkills),
    optionalKnowledge: sanitizeKnowledgeReferences(dependencies && dependencies.optionalKnowledge)
  }
}

function sanitizeSkillRequirements(value: unknown): RpaTemplateSkillRequirement[] {
  if (!Array.isArray(value)) return []
  const requirements = new Map<string, RpaTemplateSkillRequirement>()
  for (const candidate of value) {
    if (typeof candidate === 'string') {
      const skillId = normalizeText(candidate)
      if (skillId) requirements.set(skillId, { skillId })
      continue
    }
    if (!isRecord(candidate)) continue
    const skillId = normalizeText(candidate.skillId) ?? normalizeText(candidate.id)
    if (!skillId) continue
    requirements.set(skillId, { skillId, versionRange: normalizeText(candidate.versionRange) })
  }
  return [...requirements.values()]
}

function sanitizeKnowledgeReferences(value: unknown): RpaTemplateKnowledgeReference[] {
  if (!Array.isArray(value)) return []
  const references = new Map<string, RpaTemplateKnowledgeReference>()
  for (const candidate of value) {
    if (typeof candidate === 'string') {
      const knowledgeId = normalizeText(candidate)
      if (knowledgeId) references.set(knowledgeId, { knowledgeId })
      continue
    }
    if (!isRecord(candidate)) continue
    const knowledgeId = normalizeText(candidate.knowledgeId) ?? normalizeText(candidate.id)
    if (!knowledgeId) continue
    references.set(knowledgeId, { knowledgeId, version: normalizeText(candidate.version) })
  }
  return [...references.values()]
}

function getKnowledgeStatus(base: KnowledgeBase): RpaAssistantAssetStatus {
  if (base.items.some((item) => item.processingStatus === 'failed')) return 'error'
  if (base.items.some((item) => item.processingStatus === 'pending' || item.processingStatus === 'processing')) {
    return 'running'
  }
  return base.items.length > 0 ? 'ready' : 'empty'
}

function compareCatalogItems(left: RpaAssistantAssetCatalogItem, right: RpaAssistantAssetCatalogItem): number {
  return left.name.localeCompare(right.name)
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
