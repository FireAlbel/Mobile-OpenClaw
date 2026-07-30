import { loggerService } from '@logger'
import semver from 'semver'
import * as z from 'zod'

import type { RpaSkillAssetCatalogItem } from './RpaAssistantAssetCatalog'
import { createDefaultRpaModuleRegistry } from './RpaDefaultRegistry'
import type { RpaModuleRegistry } from './RpaModuleRegistry'
import { RpaRetryPolicySchema, type RpaValidationIssue, RpaVerificationSchema } from './RpaTypes'

const logger = loggerService.withContext('RpaSkillRepository')

const identifierSchema = z.string().trim().min(1).max(160)
const stringListSchema = z.array(identifierSchema).default([])
const parameterSchema = z.object({
  name: identifierSchema,
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().default(false),
  defaultValue: z.unknown().optional(),
  description: z.string().trim().max(1_000).optional()
})
const stateSchema = z.object({
  stateId: identifierSchema,
  label: z.string().trim().max(240).optional(),
  aliases: stringListSchema,
  priority: z.number().min(-100).max(100).default(0),
  packageNames: stringListSchema,
  activityIncludes: stringListSchema,
  requiredTexts: stringListSchema,
  anyTexts: stringListSchema,
  excludedTexts: stringListSchema,
  requireScreenshot: z.boolean().default(false),
  blockingCondition: z
    .enum([
      'none',
      'permission_dialog',
      'popup',
      'authentication',
      'captcha',
      'payment',
      'account_security',
      'unsupported_app_version',
      'unknown'
    ])
    .default('none'),
  recoveryScope: z.enum(['none', 'dismiss_overlay', 'navigate', 'restart_app', 'human']).default('none'),
  suggestedTransitions: stringListSchema
})
const skillStepSchema = z.object({
  id: identifierSchema,
  name: identifierSchema,
  moduleId: identifierSchema,
  params: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(10 * 60_000)
    .optional(),
  retry: RpaRetryPolicySchema.optional(),
  verify: RpaVerificationSchema.optional(),
  continueOnFailure: z.boolean().default(false)
})
const transitionSchema = z.object({
  id: identifierSchema,
  fromStateIds: z.array(identifierSchema).min(1),
  toStateId: identifierSchema,
  steps: z.array(skillStepSchema).min(1),
  priority: z.number().min(-100).max(100).default(0)
})
const fallbackSchema = z.object({
  stateId: identifierSchema,
  resumeStateId: identifierSchema.optional(),
  steps: z.array(skillStepSchema).min(1)
})
const locatorSchema = z.object({
  id: identifierSchema,
  stateIds: z.array(identifierSchema).default([]),
  strategy: z.enum(['ui_text', 'ui_resource_id', 'ocr_text', 'visual_target', 'coordinate']),
  value: z.union([z.string().min(1), z.object({ x: z.number().min(0), y: z.number().min(0) })]),
  fallbackLocatorIds: stringListSchema,
  minConfidence: z.number().min(0).max(1).default(0.7)
})

export const RpaSkillDefinitionSchema = z.object({
  id: identifierSchema,
  version: z
    .string()
    .trim()
    .refine((value) => Boolean(semver.valid(value)), 'Skill version must use semver'),
  name: identifierSchema,
  description: z.string().trim().max(4_000).default(''),
  status: z.enum(['draft', 'ready', 'disabled']).default('draft'),
  appPackage: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/),
  appVersionRange: z.string().trim().optional(),
  goals: z.array(identifierSchema).min(1),
  tags: stringListSchema,
  parameters: z.array(parameterSchema).default([]),
  states: z.array(stateSchema).min(1),
  locators: z.array(locatorSchema).default([]),
  entryStateIds: z.array(identifierSchema).min(1),
  successStateIds: z.array(identifierSchema).min(1),
  transitions: z.array(transitionSchema).min(1),
  fallbackRules: z.array(fallbackSchema).default([]),
  successVerification: RpaVerificationSchema.optional(),
  prohibitedModuleIds: stringListSchema,
  metadata: z.record(z.string(), z.unknown()).default({})
})

export type RpaSkillDefinition = z.infer<typeof RpaSkillDefinitionSchema>
export type RpaSkillStepTemplate = z.infer<typeof skillStepSchema>

export interface RpaSkillRevision {
  version: string
  definition: RpaSkillDefinition
  validationIssues: RpaValidationIssue[]
  updatedAt: number
}

export interface RpaSkillRecord extends RpaSkillDefinition {
  validationIssues: RpaValidationIssue[]
  revisions: RpaSkillRevision[]
  createdAt: number
  updatedAt: number
}

export interface RpaSkillStorage {
  loadSkills(): Promise<RpaSkillRecord[]>
  saveSkills(skills: RpaSkillRecord[]): Promise<void>
}

export interface SaveRpaSkillInput {
  definition: unknown
  saveMode?: 'new' | 'new_version' | 'overwrite'
  nextVersion?: string
}

export interface RpaSkillMatchInput {
  goal: string
  appPackage?: string
  appVersion?: string
  currentStateId?: string
  allowedSkillIds?: string[]
  versionRanges?: Record<string, string | undefined>
}

export interface RpaSkillMatch {
  skill: RpaSkillRecord
  score: number
  confidence: number
  reasons: string[]
}

class LocalStorageRpaSkillStorage implements RpaSkillStorage {
  private readonly storageKey = 'rpa_skills'

  async loadSkills(): Promise<RpaSkillRecord[]> {
    if (typeof localStorage === 'undefined') return []
    try {
      const value = localStorage.getItem(this.storageKey)
      return value ? sanitizeSkillRecords(JSON.parse(value)) : []
    } catch (error) {
      logger.warn('Failed to load local RPA skills', { error })
      return []
    }
  }

  async saveSkills(skills: RpaSkillRecord[]): Promise<void> {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(this.storageKey, JSON.stringify(sanitizeSkillRecords(skills)))
  }
}

class IpcRpaSkillStorage implements RpaSkillStorage {
  constructor(private readonly fallback: RpaSkillStorage = new LocalStorageRpaSkillStorage()) {}

  async loadSkills(): Promise<RpaSkillRecord[]> {
    if (!window.api?.rpa?.loadSkills) return this.fallback.loadSkills()
    try {
      return sanitizeSkillRecords(await window.api.rpa.loadSkills())
    } catch (error) {
      logger.warn('Failed to load RPA skills through IPC', { error })
      return this.fallback.loadSkills()
    }
  }

  async saveSkills(skills: RpaSkillRecord[]): Promise<void> {
    const sanitized = sanitizeSkillRecords(skills)
    if (!window.api?.rpa?.saveSkills) return this.fallback.saveSkills(sanitized)
    try {
      await window.api.rpa.saveSkills(sanitized)
    } catch (error) {
      logger.warn('Failed to save RPA skills through IPC', { error })
      await this.fallback.saveSkills(sanitized)
    }
  }
}

export class RpaSkillRepository {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: RpaSkillStorage = new IpcRpaSkillStorage(),
    private readonly registry?: RpaModuleRegistry,
    private readonly now: () => number = Date.now
  ) {}

  async getAll(): Promise<RpaSkillRecord[]> {
    await this.writeQueue
    return sanitizeSkillRecords(await this.storage.loadSkills())
  }

  async getById(id: string): Promise<RpaSkillRecord | undefined> {
    const normalized = normalizeText(id)
    return (await this.getAll()).find((skill) => skill.id === normalized)
  }

  async save(input: SaveRpaSkillInput): Promise<RpaSkillRecord> {
    return this.enqueue(async () => {
      const parsed = RpaSkillDefinitionSchema.safeParse(input.definition)
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '))
      }
      const skills = sanitizeSkillRecords(await this.storage.loadSkills())
      const existing = skills.find((skill) => skill.id === parsed.data.id)
      const saveMode = existing ? (input.saveMode ?? 'new_version') : 'new'
      if (saveMode === 'new' && existing) throw new Error(`RPA Skill already exists: ${parsed.data.id}`)
      const version = resolveVersion(parsed.data.version, existing, saveMode, input.nextVersion)
      const definition = { ...parsed.data, version }
      const validationIssues = validateSkillDefinition(definition, this.registry)
      if (definition.status === 'ready' && validationIssues.length) {
        throw new Error(validationIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; '))
      }
      const timestamp = this.now()
      const revisions =
        existing && saveMode === 'new_version'
          ? [
              {
                version: existing.version,
                definition: getRpaSkillDefinition(existing),
                validationIssues: existing.validationIssues,
                updatedAt: existing.updatedAt
              },
              ...existing.revisions
            ].slice(0, 20)
          : (existing?.revisions ?? [])
      const record: RpaSkillRecord = {
        ...definition,
        validationIssues,
        revisions,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      await this.storage.saveSkills([record, ...skills.filter((skill) => skill.id !== record.id)])
      return record
    })
  }

  validate(input: unknown): RpaValidationIssue[] {
    const parsed = RpaSkillDefinitionSchema.safeParse(input)
    if (!parsed.success) {
      return parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    }
    return validateSkillDefinition(parsed.data, this.registry)
  }

  async setEnabled(id: string, enabled: boolean): Promise<RpaSkillRecord> {
    const skill = await this.getById(id)
    if (!skill) throw new Error(`RPA Skill not found: ${id}`)
    return this.save({
      definition: { ...getRpaSkillDefinition(skill), status: enabled ? 'ready' : 'disabled' },
      saveMode: 'overwrite'
    })
  }

  async rollback(id: string, version: string): Promise<RpaSkillRecord> {
    const skill = await this.getById(id)
    if (!skill) throw new Error(`RPA Skill not found: ${id}`)
    const revision = skill.revisions.find((item) => item.version === version)
    if (!revision) throw new Error(`RPA Skill revision not found: ${id}@${version}`)
    return this.save({
      definition: revision.definition,
      nextVersion: semver.inc(skill.version, 'patch') ?? skill.version
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const skills = sanitizeSkillRecords(await this.storage.loadSkills())
      const next = skills.filter((skill) => skill.id !== id)
      if (next.length === skills.length) return false
      await this.storage.saveSkills(next)
      return true
    })
  }

  async match(input: RpaSkillMatchInput): Promise<RpaSkillMatch[]> {
    const allowed = input.allowedSkillIds?.length ? new Set(input.allowedSkillIds) : undefined
    const normalizedGoal = normalizeForMatch(input.goal)
    const matches: RpaSkillMatch[] = []
    for (const skill of await this.getAll()) {
      if (skill.status !== 'ready' || skill.validationIssues.length) continue
      if (allowed && !allowed.has(skill.id)) continue
      if (input.appPackage && skill.appPackage !== input.appPackage) continue
      if (input.appVersion && skill.appVersionRange && !versionMatches(input.appVersion, skill.appVersionRange))
        continue
      const requestedRange = input.versionRanges?.[skill.id]
      if (requestedRange && !versionMatches(skill.version, requestedRange)) continue

      let score = input.appPackage === skill.appPackage ? 35 : 0
      const reasons = input.appPackage === skill.appPackage ? ['app_package'] : []
      const goalHits = skill.goals.filter((goal) => {
        const normalizedSkillGoal = normalizeForMatch(goal)
        return normalizedGoal.includes(normalizedSkillGoal) || normalizedSkillGoal.includes(normalizedGoal)
      }).length
      if (goalHits) {
        score += Math.min(50, goalHits * 50)
        reasons.push('goal')
      }
      if (input.currentStateId && skill.states.some((state) => stateMatches(state, input.currentStateId!))) {
        score += 15
        reasons.push('current_state')
      }
      if (!goalHits && input.appPackage !== skill.appPackage) continue
      matches.push({ skill, score, confidence: Math.min(1, score / 100), reasons })
    }
    return matches.sort((left, right) => right.score - left.score || right.skill.updatedAt - left.skill.updatedAt)
  }

  async toCatalog(): Promise<RpaSkillAssetCatalogItem[]> {
    return (await this.getAll()).map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: skill.version,
      status:
        skill.status === 'ready' && !skill.validationIssues.length
          ? 'ready'
          : skill.status === 'disabled'
            ? 'legacy'
            : 'error',
      warning: skill.validationIssues[0]?.message
    }))
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

export function validateSkillDefinition(
  definition: RpaSkillDefinition,
  registry?: RpaModuleRegistry
): RpaValidationIssue[] {
  const issues: RpaValidationIssue[] = []
  const stateIds = new Set<string>()
  for (const [index, state] of definition.states.entries()) {
    if (stateIds.has(state.stateId)) issues.push({ path: `states.${index}.stateId`, message: 'Duplicate state ID' })
    stateIds.add(state.stateId)
  }
  for (const stateId of [...definition.entryStateIds, ...definition.successStateIds]) {
    if (!stateIds.has(stateId)) issues.push({ path: 'states', message: `Unknown referenced state: ${stateId}` })
  }
  const transitionIds = new Set<string>()
  for (const [index, transition] of definition.transitions.entries()) {
    if (transitionIds.has(transition.id)) {
      issues.push({ path: `transitions.${index}.id`, message: `Duplicate transition ID: ${transition.id}` })
    }
    transitionIds.add(transition.id)
    for (const stateId of [...transition.fromStateIds, transition.toStateId]) {
      if (stateId !== '*' && !stateIds.has(stateId)) {
        issues.push({ path: `transitions.${index}`, message: `Unknown transition state: ${stateId}` })
      }
    }
    validateSteps(transition.steps, `transitions.${index}.steps`, definition, registry, issues)
  }
  const locatorIds = new Set<string>()
  for (const [index, locator] of definition.locators.entries()) {
    if (locatorIds.has(locator.id)) issues.push({ path: `locators.${index}.id`, message: 'Duplicate locator ID' })
    locatorIds.add(locator.id)
    for (const stateId of locator.stateIds) {
      if (!stateIds.has(stateId)) {
        issues.push({ path: `locators.${index}.stateIds`, message: `Unknown locator state: ${stateId}` })
      }
    }
  }
  for (const [index, locator] of definition.locators.entries()) {
    for (const fallbackId of locator.fallbackLocatorIds) {
      if (!locatorIds.has(fallbackId)) {
        issues.push({
          path: `locators.${index}.fallbackLocatorIds`,
          message: `Unknown fallback locator: ${fallbackId}`
        })
      }
    }
  }
  for (const [index, fallback] of definition.fallbackRules.entries()) {
    if (!stateIds.has(fallback.stateId)) {
      issues.push({ path: `fallbackRules.${index}.stateId`, message: `Unknown fallback state: ${fallback.stateId}` })
    }
    if (fallback.resumeStateId && !stateIds.has(fallback.resumeStateId)) {
      issues.push({
        path: `fallbackRules.${index}.resumeStateId`,
        message: `Unknown resume state: ${fallback.resumeStateId}`
      })
    }
    validateSteps(fallback.steps, `fallbackRules.${index}.steps`, definition, registry, issues)
  }
  const parameterNames = new Set<string>()
  for (const [index, parameter] of definition.parameters.entries()) {
    if (parameterNames.has(parameter.name)) {
      issues.push({ path: `parameters.${index}.name`, message: `Duplicate parameter: ${parameter.name}` })
    }
    parameterNames.add(parameter.name)
    if (parameter.defaultValue !== undefined && !parameterValueMatches(parameter.type, parameter.defaultValue)) {
      issues.push({ path: `parameters.${index}.defaultValue`, message: `Default value must be ${parameter.type}` })
    }
  }
  return deduplicateIssues(issues)
}

function validateSteps(
  steps: RpaSkillStepTemplate[],
  path: string,
  definition: RpaSkillDefinition,
  registry: RpaModuleRegistry | undefined,
  issues: RpaValidationIssue[]
): void {
  const ids = new Set<string>()
  steps.forEach((step, index) => {
    if (ids.has(step.id)) issues.push({ path: `${path}.${index}.id`, message: `Duplicate step ID: ${step.id}` })
    ids.add(step.id)
    if (definition.prohibitedModuleIds.includes(step.moduleId)) {
      issues.push({ path: `${path}.${index}.moduleId`, message: `Prohibited module: ${step.moduleId}` })
    }
    if (registry && !registry.has(step.moduleId)) {
      issues.push({ path: `${path}.${index}.moduleId`, message: `Unknown module: ${step.moduleId}` })
    }
  })
}

function resolveVersion(
  requested: string,
  existing: RpaSkillRecord | undefined,
  saveMode: SaveRpaSkillInput['saveMode'],
  nextVersion?: string
): string {
  const candidate = nextVersion ?? requested
  if (!existing || saveMode === 'new') return candidate
  if (saveMode === 'overwrite') return existing.version
  const version = nextVersion ?? semver.inc(existing.version, 'patch')
  if (!version || !semver.gt(version, existing.version)) {
    throw new Error(`New Skill version must be greater than ${existing.version}`)
  }
  return version
}

function sanitizeSkillRecords(value: unknown): RpaSkillRecord[] {
  if (!Array.isArray(value)) return []
  return value
    .flatMap((candidate) => {
      if (!isRecord(candidate)) return []
      const parsed = RpaSkillDefinitionSchema.safeParse(candidate)
      if (!parsed.success) return []
      const createdAt = normalizeTimestamp(candidate.createdAt)
      return [
        {
          ...parsed.data,
          validationIssues: sanitizeIssues(candidate.validationIssues),
          revisions: sanitizeRevisions(candidate.revisions),
          createdAt,
          updatedAt: Math.max(createdAt, normalizeTimestamp(candidate.updatedAt))
        }
      ]
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

function sanitizeRevisions(value: unknown): RpaSkillRevision[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 20).flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const parsed = RpaSkillDefinitionSchema.safeParse(candidate.definition)
    const version = normalizeText(candidate.version)
    if (!parsed.success || !version) return []
    return [
      {
        version,
        definition: parsed.data,
        validationIssues: sanitizeIssues(candidate.validationIssues),
        updatedAt: normalizeTimestamp(candidate.updatedAt)
      }
    ]
  })
}

function sanitizeIssues(value: unknown): RpaValidationIssue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const path = normalizeText(candidate.path)
    const message = normalizeText(candidate.message)
    return message ? [{ path, message }] : []
  })
}

export function getRpaSkillDefinition(skill: RpaSkillRecord): RpaSkillDefinition {
  const definition = structuredClone(skill) as unknown as Record<string, unknown>
  delete definition.validationIssues
  delete definition.revisions
  delete definition.createdAt
  delete definition.updatedAt
  return definition as unknown as RpaSkillDefinition
}

function stateMatches(state: RpaSkillDefinition['states'][number], stateId: string): boolean {
  return state.stateId === stateId || state.aliases.includes(stateId)
}

function versionMatches(version: string, range: string): boolean {
  const validVersion = semver.valid(version)
  const validRange = semver.validRange(range)
  return Boolean(validVersion && validRange && semver.satisfies(validVersion, validRange))
}

function parameterValueMatches(type: RpaSkillDefinition['parameters'][number]['type'], value: unknown): boolean {
  return typeof value === type
}

function deduplicateIssues(issues: RpaValidationIssue[]): RpaValidationIssue[] {
  return [...new Map(issues.map((issue) => [`${issue.path}:${issue.message}`, issue])).values()]
}

function normalizeForMatch(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, '')
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const rpaSkillRepository = new RpaSkillRepository(undefined, createDefaultRpaModuleRegistry())
