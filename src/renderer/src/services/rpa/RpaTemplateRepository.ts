import { loggerService } from '@logger'
import type { RpaTaskFlowRoleReference } from '@shared/types/RpaTaskFlowSchedule'

import { createDefaultRpaModuleRegistry } from './RpaDefaultRegistry'
import { RpaTaskValidator } from './RpaTaskValidator'
import type { RpaRiskLevel, RpaTask, RpaValidationIssue } from './RpaTypes'

const logger = loggerService.withContext('RpaTemplateRepository')

export interface RpaTemplateSkillLink {
  skillId: string
  version: string
}

export interface RpaTemplateRevision {
  version: number
  dsl: unknown
  validationIssues: RpaValidationIssue[]
  updatedAt: number
}

export interface RpaTemplateSourceContext {
  messageId?: string
  topicId?: string
  blockId?: string
  assistantId?: string
  appPackage?: string
  moduleIds: string[]
  createdFrom: 'chat_rpa_block' | 'rpa_template_editor' | 'artifact_import'
}

export interface RpaTemplateRecord {
  id: string
  version: number
  name: string
  goal: string
  dsl: unknown
  status: 'draft' | 'executable'
  validationIssues: RpaValidationIssue[]
  tags: string[]
  skillLinks: RpaTemplateSkillLink[]
  role?: RpaTaskFlowRoleReference
  source: 'manual' | 'chat' | 'artifact_import'
  sourceRef?: string
  sourceContext?: RpaTemplateSourceContext
  revisions: RpaTemplateRevision[]
  createdAt: number
  updatedAt: number
}

export interface RpaTemplateStorage {
  loadTemplates(): Promise<RpaTemplateRecord[]>
  saveTemplates(templates: RpaTemplateRecord[]): Promise<void>
}

export interface SaveRpaTemplateInput {
  id?: string
  name?: string
  goal?: string
  dsl: unknown
  tags?: string[]
  skillLinks?: RpaTemplateSkillLink[]
  role?: RpaTaskFlowRoleReference
  source?: RpaTemplateRecord['source']
  sourceRef?: string
  sourceContext?: RpaTemplateSourceContext
  saveMode?: 'new' | 'overwrite' | 'new_version'
}

class LocalStorageRpaTemplateStorage implements RpaTemplateStorage {
  private readonly storageKey = 'rpa_templates'

  async loadTemplates(): Promise<RpaTemplateRecord[]> {
    if (typeof localStorage === 'undefined') return []
    try {
      const stored = localStorage.getItem(this.storageKey)
      return stored ? sanitizeTemplates(JSON.parse(stored)) : []
    } catch (error) {
      logger.warn('Failed to load local RPA templates', { error })
      return []
    }
  }

  async saveTemplates(templates: RpaTemplateRecord[]): Promise<void> {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(this.storageKey, JSON.stringify(sanitizeTemplates(templates)))
  }
}

class IpcRpaTemplateStorage implements RpaTemplateStorage {
  constructor(private readonly fallback: RpaTemplateStorage = new LocalStorageRpaTemplateStorage()) {}

  async loadTemplates(): Promise<RpaTemplateRecord[]> {
    if (!window.api?.rpa?.loadTemplates) return this.fallback.loadTemplates()
    try {
      return sanitizeTemplates(await window.api.rpa.loadTemplates())
    } catch (error) {
      logger.warn('Failed to load RPA templates through IPC', { error })
      return this.fallback.loadTemplates()
    }
  }

  async saveTemplates(templates: RpaTemplateRecord[]): Promise<void> {
    const sanitized = sanitizeTemplates(templates)
    if (!window.api?.rpa?.saveTemplates) return this.fallback.saveTemplates(sanitized)
    try {
      await window.api.rpa.saveTemplates(sanitized)
    } catch (error) {
      logger.warn('Failed to save RPA templates through IPC', { error })
      await this.fallback.saveTemplates(sanitized)
    }
  }
}

export class RpaTemplateRepository {
  private readonly validator = new RpaTaskValidator(createDefaultRpaModuleRegistry(), { requireDeviceIds: false })
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: RpaTemplateStorage = new IpcRpaTemplateStorage(),
    private readonly now: () => number = Date.now
  ) {}

  async getAll(): Promise<RpaTemplateRecord[]> {
    await this.writeQueue
    return sanitizeTemplates(await this.storage.loadTemplates())
  }

  async getById(id: string): Promise<RpaTemplateRecord | undefined> {
    return (await this.getAll()).find((template) => template.id === id)
  }

  async findByName(name: string): Promise<RpaTemplateRecord[]> {
    const normalized = normalizeText(name).toLocaleLowerCase()
    if (!normalized) return []
    return (await this.getAll()).filter((template) => template.name.toLocaleLowerCase() === normalized)
  }

  async save(input: SaveRpaTemplateInput): Promise<RpaTemplateRecord> {
    return this.enqueue(async () => {
      const templates = sanitizeTemplates(await this.storage.loadTemplates())
      const existing = input.id ? templates.find((template) => template.id === input.id) : undefined
      const timestamp = this.now()
      const saveMode = existing ? (input.saveMode ?? 'new_version') : 'new'
      const validation = this.validator.validate(input.dsl)
      const dsl = validation.task ? { ...validation.task, deviceIds: [] } : cloneJson(input.dsl)
      const name =
        normalizeText(input.name) || readTaskText(input.dsl, 'name') || existing?.name || 'Untitled RPA task flow'
      const goal = normalizeText(input.goal) || readTaskText(input.dsl, 'goal') || existing?.goal || name
      const revision =
        existing && saveMode === 'new_version'
          ? [
              {
                version: existing.version,
                dsl: existing.dsl,
                validationIssues: existing.validationIssues,
                updatedAt: existing.updatedAt
              },
              ...existing.revisions
            ].slice(0, 20)
          : []
      const template: RpaTemplateRecord = {
        id: existing?.id ?? input.id ?? createId(timestamp),
        version: existing ? (saveMode === 'new_version' ? existing.version + 1 : existing.version) : 1,
        name,
        goal,
        dsl,
        status: validation.success ? 'executable' : 'draft',
        validationIssues: validation.issues,
        tags: normalizeStrings(input.tags ?? existing?.tags),
        skillLinks: sanitizeSkillLinks(input.skillLinks ?? existing?.skillLinks),
        role: sanitizeRoleReference(input.role ?? existing?.role),
        source: input.source ?? existing?.source ?? 'manual',
        sourceRef: normalizeText(input.sourceRef) || existing?.sourceRef,
        sourceContext: sanitizeSourceContext(input.sourceContext) ?? existing?.sourceContext,
        revisions: revision,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      await this.storage.saveTemplates([template, ...templates.filter((item) => item.id !== template.id)])
      return template
    })
  }

  async duplicate(id: string): Promise<RpaTemplateRecord> {
    const template = await this.getById(id)
    if (!template) throw new Error(`RPA template not found: ${id}`)
    return this.save({
      name: `${template.name} Copy`,
      goal: template.goal,
      dsl: withNewTaskId(template.dsl, createId(this.now())),
      tags: template.tags,
      skillLinks: template.skillLinks,
      role: template.role,
      source: 'manual',
      sourceRef: template.id
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const templates = sanitizeTemplates(await this.storage.loadTemplates())
      const next = templates.filter((template) => template.id !== id)
      if (next.length === templates.length) return false
      await this.storage.saveTemplates(next)
      return true
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export function getTemplateTask(template: RpaTemplateRecord): RpaTask | undefined {
  const result = new RpaTaskValidator(createDefaultRpaModuleRegistry(), { requireDeviceIds: false }).validate(
    template.dsl
  )
  return result.success ? result.task : undefined
}

export function getTemplateAppPackage(template: RpaTemplateRecord): string | undefined {
  const task = getTemplateTask(template)
  const launch = task?.steps.find((step) => step.moduleId === 'launch_app')
  return typeof launch?.params.packageName === 'string' ? launch.params.packageName : undefined
}

export function inferTemplateRisk(template: RpaTemplateRecord): RpaRiskLevel {
  const task = getTemplateTask(template)
  if (!task) return 'low'
  const modules = createDefaultRpaModuleRegistry().listMetadata()
  const risks = task.steps.map((step) => modules.find((module) => module.id === step.moduleId)?.riskLevel ?? 'low')
  return risks.includes('high') ? 'high' : risks.includes('medium') ? 'medium' : 'low'
}

function sanitizeTemplates(value: unknown): RpaTemplateRecord[] {
  if (!Array.isArray(value)) return []
  return value
    .map(sanitizeTemplate)
    .filter((item): item is RpaTemplateRecord => Boolean(item))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function sanitizeTemplate(value: unknown): RpaTemplateRecord | undefined {
  if (!isRecord(value)) return undefined
  const id = normalizeText(value.id)
  const name = normalizeText(value.name)
  if (!id || !name) return undefined
  if (value.status === 'unsupported_legacy' || value.source === 'legacy_taskflow') return undefined
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : 0
  const status = ['draft', 'executable'].includes(String(value.status))
    ? (value.status as RpaTemplateRecord['status'])
    : 'draft'
  return {
    id,
    version: typeof value.version === 'number' ? Math.max(1, Math.floor(value.version)) : 1,
    name,
    goal: normalizeText(value.goal) || name,
    dsl: cloneJson(value.dsl),
    status,
    validationIssues: sanitizeIssues(value.validationIssues),
    tags: normalizeStrings(value.tags),
    skillLinks: sanitizeSkillLinks(value.skillLinks),
    role: sanitizeRoleReference(value.role),
    source: ['manual', 'chat', 'artifact_import'].includes(String(value.source))
      ? (value.source as RpaTemplateRecord['source'])
      : 'manual',
    sourceRef: normalizeText(value.sourceRef) || undefined,
    sourceContext: sanitizeSourceContext(value.sourceContext),
    revisions: sanitizeRevisions(value.revisions),
    createdAt,
    updatedAt: typeof value.updatedAt === 'number' ? Math.max(createdAt, value.updatedAt) : createdAt
  }
}

function sanitizeIssues(value: unknown): RpaValidationIssue[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map((issue) => ({ path: normalizeText(issue.path), message: normalizeText(issue.message) }))
    .filter((issue) => issue.message)
}

function sanitizeSkillLinks(value: unknown): RpaTemplateSkillLink[] {
  if (!Array.isArray(value)) return []
  const links = new Map<string, RpaTemplateSkillLink>()
  value.filter(isRecord).forEach((link) => {
    const skillId = normalizeText(link.skillId)
    const version = normalizeText(link.version)
    if (skillId && version) links.set(`${skillId}@${version}`, { skillId, version })
  })
  return [...links.values()]
}

function sanitizeRoleReference(value: unknown): RpaTaskFlowRoleReference | undefined {
  if (!isRecord(value)) return undefined
  const id = normalizeText(value.id)
  if (!id) return undefined
  return {
    id,
    version:
      typeof value.version === 'number' && Number.isInteger(value.version) && value.version > 0 ? value.version : 1
  }
}

function sanitizeRevisions(value: unknown): RpaTemplateRevision[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .slice(0, 20)
    .map((revision) => ({
      version: typeof revision.version === 'number' ? revision.version : 1,
      dsl: cloneJson(revision.dsl),
      validationIssues: sanitizeIssues(revision.validationIssues),
      updatedAt: typeof revision.updatedAt === 'number' ? revision.updatedAt : 0
    }))
}

function sanitizeSourceContext(value: unknown): RpaTemplateSourceContext | undefined {
  if (!isRecord(value)) return undefined
  const createdFrom = ['chat_rpa_block', 'rpa_template_editor', 'artifact_import'].includes(String(value.createdFrom))
    ? (value.createdFrom as RpaTemplateSourceContext['createdFrom'])
    : undefined
  if (!createdFrom) return undefined
  return {
    messageId: normalizeText(value.messageId) || undefined,
    topicId: normalizeText(value.topicId) || undefined,
    blockId: normalizeText(value.blockId) || undefined,
    assistantId: normalizeText(value.assistantId) || undefined,
    appPackage: normalizeText(value.appPackage) || undefined,
    moduleIds: normalizeStrings(value.moduleIds),
    createdFrom
  }
}

function withNewTaskId(value: unknown, id: string): unknown {
  return isRecord(value) ? { ...cloneJson(value), id } : cloneJson(value)
}

function readTaskText(value: unknown, key: 'name' | 'goal'): string {
  return isRecord(value) ? normalizeText(value[key]) : ''
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeStrings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(normalizeText).filter(Boolean))] : []
}

function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    return null as T
  }
}

function createId(timestamp: number): string {
  return `rpa-template-${timestamp}-${Math.random().toString(36).slice(2, 10)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const rpaTemplateRepository = new RpaTemplateRepository()
