import { loggerService } from '@logger'
import semver from 'semver'
import * as z from 'zod'

import { type RpaAppStateProfile, type RpaAppStateRule, type RpaStep, RpaStepSchema } from './RpaTypes'

const logger = loggerService.withContext('RpaAppPlaybookRepository')
const identifierSchema = z.string().trim().min(1).max(160)
const packageNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/, 'Invalid Android package name')
const stringListSchema = z.array(z.string().trim().min(1).max(240)).max(40).default([])

export const RpaAppPlaybookStateSchema = z.object({
  stateId: identifierSchema,
  label: z.string().trim().min(1).max(240).optional(),
  priority: z.number().min(-100).max(100).default(0),
  activityIncludes: stringListSchema,
  requiredTexts: stringListSchema,
  anyTexts: stringListSchema,
  excludedTexts: stringListSchema,
  screenshotSignatures: stringListSchema,
  evidenceArtifactIds: stringListSchema,
  blockingCondition: z
    .enum([
      'none',
      'permission_dialog',
      'popup',
      'update_prompt',
      'promotional_overlay',
      'network_error',
      'loading_failure',
      'authentication',
      'captcha',
      'payment',
      'account_security',
      'unsupported_app_version',
      'unknown'
    ])
    .default('none'),
  recoveryScope: z.enum(['none', 'dismiss_overlay', 'navigate', 'restart_app', 'human']).default('none'),
  successCount: z.number().int().min(0).default(0),
  failureCount: z.number().int().min(0).default(0),
  lastVerifiedAt: z.number().int().min(0).optional()
})

export const RpaAppPlaybookEdgeSchema = z.object({
  id: identifierSchema,
  fromStateIds: z.array(identifierSchema).min(1).max(20),
  toStateId: identifierSchema,
  steps: z.array(RpaStepSchema).min(1).max(20),
  priority: z.number().min(-100).max(100).default(0),
  status: z.enum(['active', 'inactive', 'quarantined']).default('active'),
  successCount: z.number().int().min(0).default(0),
  failureCount: z.number().int().min(0).default(0),
  confidence: z.number().min(0).max(1).default(0.7),
  evidenceArtifactIds: stringListSchema,
  lastVerifiedAt: z.number().int().min(0).optional()
})

const playbookDefinitionSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: identifierSchema,
  packageName: packageNameSchema,
  appVersionRange: z.string().trim().max(120).default('*'),
  locale: z.string().trim().min(1).max(40).default('*'),
  compatibilityScope: z.enum(['exact', 'version_range', 'package']).default('package'),
  launchBehavior: z.object({
    homeStateId: identifierSchema.optional(),
    softRelaunchPreservesState: z.boolean().default(true),
    hardRestartExpectedStateId: identifierSchema.optional()
  }),
  states: z.array(RpaAppPlaybookStateSchema).min(1).max(200),
  edges: z.array(RpaAppPlaybookEdgeSchema).max(500).default([]),
  disabledHandlerIds: stringListSchema,
  provenance: z.object({
    sourceRunIds: stringListSchema,
    sourceDeviceRunIds: stringListSchema,
    evidenceArtifactIds: stringListSchema
  })
})

export const RpaAppPlaybookSchema = playbookDefinitionSchema.extend({
  version: z.number().int().min(1),
  revisions: z
    .array(
      z.object({
        version: z.number().int().min(1),
        definition: playbookDefinitionSchema,
        updatedAt: z.number().int().min(0)
      })
    )
    .max(20)
    .default([]),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0)
})

export type RpaAppPlaybookDefinition = z.infer<typeof playbookDefinitionSchema>
export type RpaAppPlaybook = z.infer<typeof RpaAppPlaybookSchema>
export type RpaAppPlaybookEdge = z.infer<typeof RpaAppPlaybookEdgeSchema>

export interface RpaAppPlaybookStorage {
  loadPlaybooks(): Promise<RpaAppPlaybook[]>
  savePlaybooks(playbooks: RpaAppPlaybook[]): Promise<void>
}

export interface SaveRpaAppPlaybookInput {
  definition: unknown
  expectedVersion?: number
  sourceRunId?: string
}

class LocalStorageRpaAppPlaybookStorage implements RpaAppPlaybookStorage {
  private readonly key = 'rpa_app_playbooks'

  async loadPlaybooks(): Promise<RpaAppPlaybook[]> {
    if (typeof localStorage === 'undefined') return []
    try {
      return sanitizePlaybooks(JSON.parse(localStorage.getItem(this.key) ?? '[]'))
    } catch (error) {
      logger.warn('Failed to load local App Playbooks', { error })
      return []
    }
  }

  async savePlaybooks(playbooks: RpaAppPlaybook[]): Promise<void> {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(this.key, JSON.stringify(sanitizePlaybooks(playbooks)))
  }
}

class IpcRpaAppPlaybookStorage implements RpaAppPlaybookStorage {
  constructor(private readonly fallback: RpaAppPlaybookStorage = new LocalStorageRpaAppPlaybookStorage()) {}

  async loadPlaybooks(): Promise<RpaAppPlaybook[]> {
    if (!window.api?.rpa?.loadAppPlaybooks) return this.fallback.loadPlaybooks()
    try {
      return sanitizePlaybooks(await window.api.rpa.loadAppPlaybooks())
    } catch (error) {
      logger.warn('Failed to load App Playbooks through IPC', { error })
      return this.fallback.loadPlaybooks()
    }
  }

  async savePlaybooks(playbooks: RpaAppPlaybook[]): Promise<void> {
    const sanitized = sanitizePlaybooks(playbooks)
    if (!window.api?.rpa?.saveAppPlaybooks) return this.fallback.savePlaybooks(sanitized)
    try {
      await window.api.rpa.saveAppPlaybooks(sanitized)
    } catch (error) {
      logger.warn('Failed to save App Playbooks through IPC', { error })
      await this.fallback.savePlaybooks(sanitized)
    }
  }
}

export class RpaAppPlaybookRepository {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: RpaAppPlaybookStorage = new IpcRpaAppPlaybookStorage(),
    private readonly now: () => number = Date.now
  ) {}

  async getAll(): Promise<RpaAppPlaybook[]> {
    await this.writeQueue
    return sanitizePlaybooks(await this.storage.loadPlaybooks())
  }

  async getById(id: string, version?: number): Promise<RpaAppPlaybook | undefined> {
    const current = (await this.getAll()).find((playbook) => playbook.id === id)
    if (!current || version === undefined || current.version === version) return current
    const revision = current.revisions.find((candidate) => candidate.version === version)
    return revision
      ? {
          ...revision.definition,
          version: revision.version,
          revisions: [],
          createdAt: current.createdAt,
          updatedAt: revision.updatedAt
        }
      : undefined
  }

  async resolve(packageName: string, appVersion?: string, locale?: string): Promise<RpaAppPlaybook | undefined> {
    const candidates = (await this.getAll())
      .filter((playbook) => playbook.packageName === packageName)
      .filter((playbook) => matchesLocale(playbook.locale, locale))
      .filter((playbook) => matchesVersion(playbook.appVersionRange, appVersion))
      .sort(
        (left, right) => compatibilityScore(right, appVersion, locale) - compatibilityScore(left, appVersion, locale)
      )
    return candidates[0]
  }

  async save(input: SaveRpaAppPlaybookInput): Promise<RpaAppPlaybook> {
    return this.enqueue(async () => {
      const parsed = playbookDefinitionSchema.safeParse(input.definition)
      if (!parsed.success) throw new Error(formatIssues(parsed.error))
      assertSafePlaybook(parsed.data)
      const playbooks = sanitizePlaybooks(await this.storage.loadPlaybooks())
      const existing = playbooks.find((candidate) => candidate.id === parsed.data.id)
      if (existing && input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
        throw new Error(`App Playbook version conflict: expected ${input.expectedVersion}, current ${existing.version}`)
      }
      const timestamp = this.now()
      const definition = deduplicateDefinition({
        ...parsed.data,
        provenance: {
          ...parsed.data.provenance,
          sourceRunIds: uniqueStrings([
            ...parsed.data.provenance.sourceRunIds,
            ...(input.sourceRunId ? [input.sourceRunId] : [])
          ])
        }
      })
      const next: RpaAppPlaybook = {
        ...definition,
        version: existing ? existing.version + 1 : 1,
        revisions: existing
          ? [
              {
                version: existing.version,
                definition: definitionFromRecord(existing),
                updatedAt: existing.updatedAt
              },
              ...existing.revisions
            ].slice(0, 20)
          : [],
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      }
      await this.storage.savePlaybooks([next, ...playbooks.filter((candidate) => candidate.id !== next.id)])
      return next
    })
  }

  async rollback(id: string, targetVersion: number, expectedVersion: number): Promise<RpaAppPlaybook> {
    const current = (await this.getAll()).find((playbook) => playbook.id === id)
    if (!current) throw new Error(`App Playbook not found: ${id}`)
    const target = await this.getById(id, targetVersion)
    if (!target) throw new Error(`App Playbook version not found: ${id}@${targetVersion}`)
    return this.save({ definition: definitionFromRecord(target), expectedVersion })
  }

  toProfile(playbook: RpaAppPlaybook): RpaAppStateProfile {
    return {
      appPackage: playbook.packageName,
      states: playbook.states.map(
        (state): RpaAppStateRule => ({
          stateId: state.stateId,
          label: state.label,
          priority: state.priority,
          packageNames: [playbook.packageName],
          activityIncludes: state.activityIncludes,
          requiredTexts: state.requiredTexts,
          anyTexts: state.anyTexts,
          excludedTexts: state.excludedTexts,
          blockingCondition: state.blockingCondition,
          recoveryScope: state.recoveryScope
        })
      )
    }
  }

  findPath(playbook: RpaAppPlaybook, fromStateId: string, targetStateId: string): RpaAppPlaybookEdge[] | undefined {
    if (fromStateId === targetStateId) return []
    const queue: Array<{ stateId: string; path: RpaAppPlaybookEdge[] }> = [{ stateId: fromStateId, path: [] }]
    const visited = new Set([fromStateId])
    while (queue.length) {
      const current = queue.shift()!
      const edges = playbook.edges
        .filter(
          (edge) =>
            edge.status === 'active' &&
            edge.confidence >= 0.7 &&
            (edge.fromStateIds.includes(current.stateId) || edge.fromStateIds.includes('*'))
        )
        .sort((left, right) => right.priority - left.priority || right.confidence - left.confidence)
      for (const edge of edges) {
        const path = [...current.path, edge]
        if (edge.toStateId === targetStateId) return path
        if (!visited.has(edge.toStateId)) {
          visited.add(edge.toStateId)
          queue.push({ stateId: edge.toStateId, path })
        }
      }
    }
    return undefined
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.writeQueue.then(operation, operation)
    this.writeQueue = queued.then(
      () => undefined,
      () => undefined
    )
    return queued
  }
}

function assertSafePlaybook(definition: RpaAppPlaybookDefinition): void {
  const forbidden = new Set(['execute_adb', 'shell', 'uninstall_package', 'clear_app_data'])
  for (const edge of definition.edges) {
    for (const step of edge.steps) {
      if (forbidden.has(step.moduleId) || /(?:pm\s+clear|uninstall|rm\s+-rf)/i.test(JSON.stringify(step.params))) {
        throw new Error(`Unsafe App Playbook step rejected: ${step.moduleId}`)
      }
    }
  }
}

function deduplicateDefinition(definition: RpaAppPlaybookDefinition): RpaAppPlaybookDefinition {
  const states = new Map<string, (typeof definition.states)[number]>()
  for (const state of definition.states) states.set(state.stateId, state)
  const edges = new Map<string, RpaAppPlaybookEdge>()
  for (const edge of definition.edges) {
    const signature = `${[...edge.fromStateIds].sort().join(',')}->${edge.toStateId}:${stepSignature(edge.steps)}`
    const existing = edges.get(signature)
    edges.set(
      signature,
      existing
        ? {
            ...existing,
            successCount: existing.successCount + edge.successCount,
            failureCount: existing.failureCount + edge.failureCount,
            confidence: Math.max(existing.confidence, edge.confidence),
            evidenceArtifactIds: uniqueStrings([...existing.evidenceArtifactIds, ...edge.evidenceArtifactIds])
          }
        : edge
    )
  }
  return { ...definition, states: [...states.values()], edges: [...edges.values()] }
}

function definitionFromRecord(playbook: RpaAppPlaybook): RpaAppPlaybookDefinition {
  return {
    schemaVersion: playbook.schemaVersion,
    id: playbook.id,
    packageName: playbook.packageName,
    appVersionRange: playbook.appVersionRange,
    locale: playbook.locale,
    compatibilityScope: playbook.compatibilityScope,
    launchBehavior: playbook.launchBehavior,
    states: playbook.states,
    edges: playbook.edges,
    disabledHandlerIds: playbook.disabledHandlerIds,
    provenance: playbook.provenance
  }
}

function sanitizePlaybooks(value: unknown): RpaAppPlaybook[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    const parsed = RpaAppPlaybookSchema.safeParse(candidate)
    return parsed.success ? [parsed.data] : []
  })
}

function stepSignature(steps: RpaStep[]): string {
  return JSON.stringify(steps.map((step) => ({ moduleId: step.moduleId, params: step.params, verify: step.verify })))
}

function matchesLocale(scope: string, locale?: string): boolean {
  return scope === '*' || !locale || scope.toLocaleLowerCase() === locale.toLocaleLowerCase()
}

function matchesVersion(range: string, version?: string): boolean {
  if (range === '*' || !version) return true
  const normalized = semver.coerce(version)?.version
  return Boolean(normalized && semver.validRange(range) && semver.satisfies(normalized, range))
}

function compatibilityScore(playbook: RpaAppPlaybook, appVersion?: string, locale?: string): number {
  return (
    (playbook.locale === locale ? 4 : 0) +
    (playbook.appVersionRange !== '*' && appVersion ? 2 : 0) +
    playbook.version / 10_000
  )
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
}

export const rpaAppPlaybookRepository = new RpaAppPlaybookRepository()
