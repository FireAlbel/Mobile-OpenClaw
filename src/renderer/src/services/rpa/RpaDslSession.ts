import { loggerService } from '@logger'

import type { RpaRoleContextProvenance, RpaRoleVersionReference } from './RpaAppRole'
import { type RpaDslProvenance, sanitizeRpaDslProvenance } from './RpaRunContextSnapshot'
import { rpaSessionTelemetryService } from './RpaSessionTelemetryService'
import type {
  RpaTaskInteractionEvent,
  RpaTaskInteractionOutcome,
  RpaTaskInteractionPhase,
  RpaTaskSessionState
} from './RpaTaskSessionProtocol'
import {
  canTransitionRpaTaskSessionState,
  sanitizeRpaTaskInteractionEvent,
  sanitizeRpaTaskSessionState,
  taskStateFromLegacyStatus
} from './RpaTaskSessionProtocol'
import type { RpaValidationIssue } from './RpaTypes'

const logger = loggerService.withContext('RpaDslSession')

export type RpaDslSessionStatus =
  | 'draft'
  | 'clarification_required'
  | 'validated'
  | 'non_executable'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'ended'
export interface RpaDslClarification {
  id: string
  question: string
  required: boolean
  answer?: string
  answeredAt?: number
}
export interface RpaDslRevision {
  version: number
  dsl: unknown
  validationIssues: RpaValidationIssue[]
  executable: boolean
  humanReadableExplanation?: string
  roleContext: RpaRoleContextProvenance
  createdAt: number
  source: 'generated' | 'revised' | 'repair' | 'replay'
  requestContext?: RpaDslRevisionRequestContext
}
export interface RpaDslRevisionRequestContext {
  requestId: string
  sessionId: string
  baseRevision?: number
  expectedVersion: number
  supplementRevision: number
  contextSnapshotId?: string
  provenance: RpaDslProvenance
}
export type RpaPlanningRequestStatus = 'pending' | 'accepted' | 'stale' | 'cancelled' | 'timed_out' | 'failed'
export interface RpaPlanningRequestAudit {
  requestId: string
  baseRevision?: number
  expectedVersion: number
  supplementRevision: number
  contextSnapshotId?: string
  status: RpaPlanningRequestStatus
  reason?: string
  startedAt: number
  finishedAt?: number
}
export interface RpaDslPlanningFailure {
  requestId: string
  sourceRevision?: number
  candidate: string
  issues: RpaValidationIssue[]
  createdAt: number
}
export interface RpaDslSession {
  schemaVersion: 1
  id: string
  version: number
  primaryRole?: RpaRoleVersionReference
  supportingRoles: RpaRoleVersionReference[]
  goal: string
  attachments: string[]
  observations: string[]
  clarifications: RpaDslClarification[]
  revisions: RpaDslRevision[]
  activeRevisionVersion?: number
  status: RpaDslSessionStatus
  interactionState: RpaTaskSessionState
  interactionEvents: RpaTaskInteractionEvent[]
  planningFailures?: RpaDslPlanningFailure[]
  planningRequests?: RpaPlanningRequestAudit[]
  topicCompatibilityId?: string
  templateIds: string[]
  runIds: string[]
  replayRunIds: string[]
  improvementIds: string[]
  endedAt?: number
  createdAt: number
  updatedAt: number
}
export interface RpaDslSessionStorage {
  loadSessions(): Promise<RpaDslSession[]>
  saveSessions(sessions: RpaDslSession[]): Promise<void>
}
export interface RpaDslValidationResult {
  dsl?: unknown
  issues: RpaValidationIssue[]
  executable: boolean
}
export interface RpaDslSessionValidator {
  validate(dsl: unknown): RpaDslValidationResult
}
export interface CreateRpaDslSessionInput {
  goal: string
  primaryRole?: RpaRoleVersionReference
  supportingRoles?: RpaRoleVersionReference[]
  attachments?: string[]
  observations?: string[]
  topicCompatibilityId?: string
}

class LocalStorageRpaDslSessionStorage implements RpaDslSessionStorage {
  private readonly key = 'rpa_dsl_sessions'
  async loadSessions(): Promise<RpaDslSession[]> {
    if (typeof localStorage === 'undefined') return []
    try {
      const raw = localStorage.getItem(this.key)
      return raw ? sanitizeSessions(JSON.parse(raw)) : []
    } catch (error) {
      logger.warn('Failed to load RPA DSL sessions', { error })
      return []
    }
  }
  async saveSessions(sessions: RpaDslSession[]): Promise<void> {
    if (typeof localStorage !== 'undefined') localStorage.setItem(this.key, JSON.stringify(sanitizeSessions(sessions)))
  }
}

class IpcRpaDslSessionStorage implements RpaDslSessionStorage {
  constructor(private readonly fallback: RpaDslSessionStorage = new LocalStorageRpaDslSessionStorage()) {}

  async loadSessions(): Promise<RpaDslSession[]> {
    if (!window.api?.rpa?.loadDslSessions) return this.fallback.loadSessions()
    try {
      return sanitizeSessions(await window.api.rpa.loadDslSessions())
    } catch (error) {
      logger.warn('Failed to load RPA DSL sessions through IPC', { error })
      return this.fallback.loadSessions()
    }
  }

  async saveSessions(sessions: RpaDslSession[]): Promise<void> {
    const sanitized = sanitizeSessions(sessions)
    if (!window.api?.rpa?.saveDslSessions) return this.fallback.saveSessions(sanitized)
    try {
      await window.api.rpa.saveDslSessions(sanitized)
    } catch (error) {
      logger.warn('Failed to save RPA DSL sessions through IPC', { error })
      await this.fallback.saveSessions(sanitized)
    }
  }
}

export class RpaDslSessionRepository {
  private writeQueue: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly storage: RpaDslSessionStorage = new IpcRpaDslSessionStorage(),
    private readonly now: () => number = Date.now
  ) {}
  async getAll(): Promise<RpaDslSession[]> {
    await this.writeQueue
    return sanitizeSessions(await this.storage.loadSessions())
  }
  async getById(id: string): Promise<RpaDslSession | undefined> {
    return (await this.getAll()).find((session) => session.id === id)
  }
  async create(input: CreateRpaDslSessionInput): Promise<RpaDslSession> {
    const goal = text(input.goal, 4_000)
    if (!goal) throw new Error('RPA DSL session goal is required')
    const now = this.now()
    const primaryRole = sanitizeRoleRef(input.primaryRole)
    const session: RpaDslSession = {
      schemaVersion: 1,
      id: createId(now),
      version: 1,
      primaryRole,
      supportingRoles: uniqueRoleRefs(input.supportingRoles ?? [], primaryRole?.id),
      goal,
      attachments: strings(input.attachments),
      observations: strings(input.observations),
      clarifications: [],
      revisions: [],
      status: primaryRole ? 'draft' : 'non_executable',
      interactionState: primaryRole ? 'empty' : 'non_executable',
      interactionEvents: [],
      planningFailures: [],
      planningRequests: [],
      topicCompatibilityId: text(input.topicCompatibilityId, 256) || undefined,
      templateIds: [],
      runIds: [],
      replayRunIds: [],
      improvementIds: [],
      createdAt: now,
      updatedAt: now
    }
    return this.enqueue(async () => {
      const sessions = await this.storage.loadSessions()
      await this.storage.saveSessions([session, ...sessions])
      return session
    })
  }
  async appendRevision(
    id: string,
    dsl: unknown,
    context: RpaRoleContextProvenance,
    validator: RpaDslSessionValidator,
    options: {
      expectedSessionVersion: number
      source?: RpaDslRevision['source']
      humanReadableExplanation?: string
      requestContext?: RpaDslRevisionRequestContext
    }
  ): Promise<RpaDslSession> {
    const updated = await this.update(id, options.expectedSessionVersion, (session) => {
      if (session.status === 'ended') throw new Error('Ended RPA tasks are read-only')
      if (options.requestContext) {
        if (options.requestContext.sessionId !== session.id) throw new Error('Revision request Session does not match')
        if (options.requestContext.expectedVersion !== options.expectedSessionVersion) {
          throw new Error('Revision request expectedVersion does not match the repository write')
        }
        if (options.requestContext.baseRevision !== session.activeRevisionVersion) {
          throw new Error('Revision request baseRevision is stale')
        }
      }
      if (!session.primaryRole) throw new Error('Executable DSL requires a selected Role')
      if (
        context.primaryRole.id !== session.primaryRole.id ||
        context.primaryRole.version !== session.primaryRole.version
      )
        throw new Error('Revision Role context does not match the immutable session Role')
      const validation = validator.validate(dsl)
      const revisionVersion = (session.revisions.at(-1)?.version ?? 0) + 1
      const revision: RpaDslRevision = {
        version: revisionVersion,
        dsl: clone(validation.dsl ?? dsl),
        validationIssues: validation.issues,
        executable: validation.executable,
        humanReadableExplanation: text(options.humanReadableExplanation, 4_000) || undefined,
        roleContext: clone(context),
        createdAt: this.now(),
        source: options.source ?? 'generated',
        requestContext: options.requestContext ? sanitizeRevisionRequestContext(options.requestContext) : undefined
      }
      return {
        ...session,
        revisions: [...session.revisions, revision],
        activeRevisionVersion: revisionVersion,
        status: validation.executable ? 'validated' : 'draft',
        interactionState: validation.executable ? 'ready' : 'draft'
      }
    })
    rpaSessionTelemetryService.record('successful_dsl_revision', {
      sessionId: updated.id,
      requestId: options.requestContext?.requestId,
      reason: `revision:${updated.activeRevisionVersion ?? 'unknown'}`
    })
    return updated
  }
  async requestClarification(
    id: string,
    expectedVersion: number,
    questions: Array<Pick<RpaDslClarification, 'id' | 'question' | 'required'>>
  ): Promise<RpaDslSession> {
    const updated = await this.update(id, expectedVersion, (session) => ({
      ...session,
      clarifications: questions
        .map((item) => ({ id: text(item.id, 160), question: text(item.question, 1_000), required: item.required }))
        .filter((item) => item.id && item.question),
      status: 'clarification_required',
      interactionState: 'needs_clarification'
    }))
    if (updated.clarifications.length) {
      rpaSessionTelemetryService.record('clarification_loop', { sessionId: updated.id })
    }
    return updated
  }
  async answerClarification(
    id: string,
    expectedVersion: number,
    clarificationId: string,
    answer: string
  ): Promise<RpaDslSession> {
    return this.update(id, expectedVersion, (session) => {
      const clarifications = session.clarifications.map((item) =>
        item.id === clarificationId ? { ...item, answer: text(answer, 4_000), answeredAt: this.now() } : item
      )
      const unresolved = clarifications.some((item) => item.required && !item.answer)
      return {
        ...session,
        clarifications,
        status: unresolved ? 'clarification_required' : 'draft',
        interactionState: unresolved ? 'needs_clarification' : 'planning'
      }
    })
  }
  async markNonExecutable(id: string, expectedVersion: number, explanation: string): Promise<RpaDslSession> {
    const updated = await this.update(id, expectedVersion, (session) => ({
      ...session,
      status: 'non_executable',
      interactionState: 'non_executable',
      observations: [...session.observations, text(explanation, 4_000)]
    }))
    rpaSessionTelemetryService.record('non_executable_result', { sessionId: updated.id, reason: explanation })
    return updated
  }
  async link(
    id: string,
    expectedVersion: number,
    kind: 'template' | 'run' | 'replay' | 'improvement',
    targetId: string
  ): Promise<RpaDslSession> {
    const key = (
      { template: 'templateIds', run: 'runIds', replay: 'replayRunIds', improvement: 'improvementIds' } as const
    )[kind]
    return this.update(id, expectedVersion, (session) => ({
      ...session,
      [key]: [...new Set([...session[key], targetId.trim()])].filter(Boolean)
    }))
  }
  async setExecutionStatus(
    id: string,
    expectedVersion: number,
    status: Extract<RpaDslSessionStatus, 'executing' | 'paused' | 'completed' | 'failed'>
  ): Promise<RpaDslSession> {
    return this.update(id, expectedVersion, (session) => {
      if (status === 'executing' && session.status !== 'validated' && session.status !== 'paused')
        throw new Error('Only a validated DSL revision can execute')
      return { ...session, status, interactionState: status }
    })
  }
  async recordInteraction(
    id: string,
    expectedVersion: number,
    input: {
      requestId: string
      outcome: RpaTaskInteractionOutcome
      phase: RpaTaskInteractionPhase
      text: string
      stateAfter: RpaTaskSessionState
      sourceRevision?: number
      reason?: string
    }
  ): Promise<RpaDslSession> {
    return this.update(id, expectedVersion, (session) => {
      if (!canTransitionRpaTaskSessionState(session.interactionState, input.stateAfter)) {
        throw new Error(`Invalid RPA task-session transition: ${session.interactionState} -> ${input.stateAfter}`)
      }
      const now = this.now()
      const event: RpaTaskInteractionEvent = {
        id: `${text(input.requestId, 256)}:${input.phase}:${now}`,
        requestId: text(input.requestId, 256),
        outcome: input.outcome,
        phase: input.phase,
        input: text(input.text, 4_000),
        stateBefore: session.interactionState,
        stateAfter: input.stateAfter,
        sourceRevision: input.sourceRevision,
        reason: text(input.reason, 4_000) || undefined,
        createdAt: now
      }
      if (!event.requestId || !event.input) throw new Error('RPA interaction requestId and input are required')
      return {
        ...session,
        interactionState: input.stateAfter,
        interactionEvents: [...session.interactionEvents, event]
      }
    })
  }
  async recordPlanningFailure(
    id: string,
    expectedVersion: number,
    input: Omit<RpaDslPlanningFailure, 'createdAt'>
  ): Promise<RpaDslSession> {
    return this.update(id, expectedVersion, (session) => ({
      ...session,
      planningFailures: [
        ...(session.planningFailures ?? []),
        {
          requestId: text(input.requestId, 256),
          sourceRevision: input.sourceRevision,
          candidate: text(input.candidate, 12_000),
          issues: clone(input.issues),
          createdAt: this.now()
        }
      ].slice(-20)
    }))
  }
  async recordPlanningRequest(
    id: string,
    input: Omit<RpaPlanningRequestAudit, 'startedAt' | 'finishedAt'> & { startedAt?: number; finishedAt?: number }
  ): Promise<RpaDslSession> {
    return this.enqueue(async () => {
      const sessions = sanitizeSessions(await this.storage.loadSessions())
      const existing = sessions.find((session) => session.id === id)
      if (!existing) throw new Error(`RPA DSL session not found: ${id}`)
      const previous = existing.planningRequests?.find((request) => request.requestId === input.requestId)
      const now = this.now()
      const request: RpaPlanningRequestAudit = {
        requestId: text(input.requestId, 256),
        baseRevision: positiveOptional(input.baseRevision),
        expectedVersion: positive(input.expectedVersion),
        supplementRevision: nonNegative(input.supplementRevision),
        contextSnapshotId: text(input.contextSnapshotId, 256) || undefined,
        status: input.status,
        reason: text(input.reason, 4_000) || undefined,
        startedAt: previous?.startedAt ?? time(input.startedAt ?? now),
        finishedAt: input.status === 'pending' ? undefined : time(input.finishedAt ?? now)
      }
      if (!request.requestId) throw new Error('Planning requestId is required')
      const updated = {
        ...existing,
        planningRequests: [
          ...(existing.planningRequests ?? []).filter((candidate) => candidate.requestId !== request.requestId),
          request
        ].slice(-50),
        updatedAt: now
      }
      await this.storage.saveSessions([updated, ...sessions.filter((session) => session.id !== id)])
      if (request.status === 'stale') {
        rpaSessionTelemetryService.record('stale_revision', {
          sessionId: id,
          requestId: request.requestId,
          reason: request.reason
        })
      }
      return updated
    })
  }
  async duplicate(id: string, expectedVersion: number, topicCompatibilityId?: string): Promise<RpaDslSession> {
    return this.enqueue(async () => {
      const sessions = sanitizeSessions(await this.storage.loadSessions())
      const source = sessions.find((session) => session.id === id)
      if (!source) throw new Error(`RPA DSL session not found: ${id}`)
      if (source.version !== expectedVersion) {
        throw new Error(`RPA DSL session revision conflict: expected ${expectedVersion}, current ${source.version}`)
      }
      if (!source.primaryRole) throw new Error('A Role is required to duplicate an RPA task')
      const activeRevision = source.revisions.find((revision) => revision.version === source.activeRevisionVersion)
      const now = this.now()
      const duplicateId = createId(now)
      const duplicatedRevision = activeRevision
        ? {
            ...clone(activeRevision),
            version: 1,
            source: 'replay' as const,
            createdAt: now,
            requestContext: activeRevision.requestContext
              ? {
                  ...clone(activeRevision.requestContext),
                  requestId: `duplicate-${now}`,
                  sessionId: duplicateId,
                  baseRevision: undefined,
                  expectedVersion: 1,
                  supplementRevision: 0,
                  contextSnapshotId: undefined
                }
              : undefined
          }
        : undefined
      const duplicate: RpaDslSession = {
        schemaVersion: 1,
        id: duplicateId,
        version: 1,
        primaryRole: clone(source.primaryRole),
        supportingRoles: clone(source.supportingRoles),
        goal: source.goal,
        attachments: clone(source.attachments),
        observations: [],
        clarifications: [],
        revisions: duplicatedRevision ? [duplicatedRevision] : [],
        activeRevisionVersion: duplicatedRevision?.version,
        status: duplicatedRevision?.executable ? 'validated' : 'draft',
        interactionState: duplicatedRevision?.executable ? 'ready' : 'draft',
        interactionEvents: [],
        planningFailures: [],
        planningRequests: [],
        topicCompatibilityId: text(topicCompatibilityId, 256) || undefined,
        templateIds: clone(source.templateIds),
        runIds: [],
        replayRunIds: [],
        improvementIds: [],
        createdAt: now,
        updatedAt: now
      }
      await this.storage.saveSessions([duplicate, ...sessions])
      return duplicate
    })
  }
  async end(id: string, expectedVersion: number): Promise<RpaDslSession> {
    return this.update(id, expectedVersion, (session) => {
      if (session.status === 'executing') throw new Error('Stop the active run before ending this RPA task')
      return { ...session, status: 'ended', interactionState: 'completed', endedAt: this.now() }
    })
  }
  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      const sessions = await this.storage.loadSessions()
      const next = sessions.filter((session) => session.id !== id)
      if (next.length === sessions.length) return false
      await this.storage.saveSessions(next)
      return true
    })
  }
  private async update(
    id: string,
    expectedVersion: number,
    mutate: (session: RpaDslSession) => RpaDslSession
  ): Promise<RpaDslSession> {
    return this.enqueue(async () => {
      const sessions = sanitizeSessions(await this.storage.loadSessions())
      const existing = sessions.find((session) => session.id === id)
      if (!existing) throw new Error(`RPA DSL session not found: ${id}`)
      if (existing.version !== expectedVersion)
        throw new Error(`RPA DSL session revision conflict: expected ${expectedVersion}, current ${existing.version}`)
      const updated = sanitizeSession({
        ...mutate(existing),
        version: existing.version + 1,
        createdAt: existing.createdAt,
        updatedAt: this.now()
      })!
      await this.storage.saveSessions([updated, ...sessions.filter((session) => session.id !== id)])
      return updated
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

export function sanitizeSession(value: unknown): RpaDslSession | undefined {
  if (!record(value) || value.schemaVersion !== 1) return undefined
  const id = text(value.id, 256)
  const goal = text(value.goal, 4_000)
  if (!id || !goal) return undefined
  const primaryRole = sanitizeRoleRef(value.primaryRole)
  const createdAt = time(value.createdAt)
  const revisions = Array.isArray(value.revisions)
    ? value.revisions.flatMap((candidate) => {
        if (!record(candidate) || !record(candidate.roleContext)) return []
        const primary = sanitizeRoleRef(candidate.roleContext.primaryRole)
        if (!primary) return []
        const roleContext: RpaRoleContextProvenance = {
          primaryRole: primary,
          supportingRoles: uniqueRoleRefs(
            Array.isArray(candidate.roleContext.supportingRoles) ? candidate.roleContext.supportingRoles : [],
            primary.id
          ),
          systemCapabilities: strings(candidate.roleContext.systemCapabilities)
        }
        return [
          {
            version: positive(candidate.version),
            dsl: clone(candidate.dsl),
            validationIssues: Array.isArray(candidate.validationIssues)
              ? (candidate.validationIssues as RpaValidationIssue[])
              : [],
            executable: candidate.executable === true,
            humanReadableExplanation: text(candidate.humanReadableExplanation, 4_000) || undefined,
            roleContext,
            createdAt: time(candidate.createdAt),
            source: ['generated', 'revised', 'repair', 'replay'].includes(String(candidate.source))
              ? (candidate.source as RpaDslRevision['source'])
              : 'generated',
            requestContext: sanitizeRevisionRequestContext(candidate.requestContext)
          }
        ]
      })
    : []
  const status = [
    'draft',
    'clarification_required',
    'validated',
    'non_executable',
    'executing',
    'paused',
    'completed',
    'failed',
    'ended'
  ].includes(String(value.status))
    ? (value.status as RpaDslSessionStatus)
    : 'draft'
  const interactionState = sanitizeRpaTaskSessionState(
    value.interactionState,
    taskStateFromLegacyStatus(status, revisions.length > 0)
  )
  return {
    schemaVersion: 1,
    id,
    version: positive(value.version),
    primaryRole,
    supportingRoles: uniqueRoleRefs(Array.isArray(value.supportingRoles) ? value.supportingRoles : [], primaryRole?.id),
    goal,
    attachments: strings(value.attachments),
    observations: strings(value.observations),
    clarifications: Array.isArray(value.clarifications)
      ? value.clarifications.flatMap((item) =>
          record(item) && text(item.id, 160) && text(item.question, 1_000)
            ? [
                {
                  id: text(item.id, 160),
                  question: text(item.question, 1_000),
                  required: item.required === true,
                  answer: text(item.answer, 4_000) || undefined,
                  answeredAt: item.answeredAt === undefined ? undefined : time(item.answeredAt)
                }
              ]
            : []
        )
      : [],
    revisions,
    activeRevisionVersion:
      value.activeRevisionVersion === undefined ? undefined : positive(value.activeRevisionVersion),
    status,
    interactionState,
    interactionEvents: Array.isArray(value.interactionEvents)
      ? value.interactionEvents.flatMap((item) => {
          const event = sanitizeRpaTaskInteractionEvent(item)
          return event ? [event] : []
        })
      : [],
    planningFailures: Array.isArray(value.planningFailures)
      ? value.planningFailures.flatMap((item) => {
          if (!record(item) || !text(item.requestId, 256)) return []
          return [
            {
              requestId: text(item.requestId, 256),
              sourceRevision: item.sourceRevision === undefined ? undefined : positive(item.sourceRevision),
              candidate: text(item.candidate, 12_000),
              issues: Array.isArray(item.issues) ? (clone(item.issues) as RpaValidationIssue[]) : [],
              createdAt: time(item.createdAt)
            }
          ]
        })
      : [],
    planningRequests: Array.isArray(value.planningRequests)
      ? value.planningRequests.flatMap((item) => {
          if (!record(item) || !text(item.requestId, 256)) return []
          const status = ['pending', 'accepted', 'stale', 'cancelled', 'timed_out', 'failed'].includes(
            String(item.status)
          )
            ? (item.status as RpaPlanningRequestStatus)
            : undefined
          if (!status) return []
          return [
            {
              requestId: text(item.requestId, 256),
              baseRevision: positiveOptional(item.baseRevision),
              expectedVersion: positive(item.expectedVersion),
              supplementRevision: nonNegative(item.supplementRevision),
              contextSnapshotId: text(item.contextSnapshotId, 256) || undefined,
              status,
              reason: text(item.reason, 4_000) || undefined,
              startedAt: time(item.startedAt),
              finishedAt: item.finishedAt === undefined ? undefined : time(item.finishedAt)
            }
          ]
        })
      : [],
    topicCompatibilityId: text(value.topicCompatibilityId, 256) || undefined,
    templateIds: strings(value.templateIds),
    runIds: strings(value.runIds),
    replayRunIds: strings(value.replayRunIds),
    improvementIds: strings(value.improvementIds),
    endedAt: value.endedAt === undefined ? undefined : time(value.endedAt),
    createdAt,
    updatedAt: Math.max(createdAt, time(value.updatedAt))
  }
}

function sanitizeRevisionRequestContext(value: unknown): RpaDslRevisionRequestContext | undefined {
  if (!record(value) || !record(value.provenance)) return undefined
  const requestId = text(value.requestId, 256)
  const sessionId = text(value.sessionId, 256)
  if (!requestId || !sessionId) return undefined
  try {
    return {
      requestId,
      sessionId,
      baseRevision: positiveOptional(value.baseRevision),
      expectedVersion: positive(value.expectedVersion),
      supplementRevision: nonNegative(value.supplementRevision),
      contextSnapshotId: text(value.contextSnapshotId, 256) || undefined,
      provenance: sanitizeRpaDslProvenance(value.provenance as unknown as RpaDslProvenance)
    }
  } catch {
    return undefined
  }
}
function sanitizeSessions(value: unknown): RpaDslSession[] {
  if (!Array.isArray(value)) return []
  const map = new Map<string, RpaDslSession>()
  for (const candidate of value) {
    const session = sanitizeSession(candidate)
    if (session && (!map.has(session.id) || map.get(session.id)!.version < session.version))
      map.set(session.id, session)
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}
function sanitizeRoleRef(value: unknown): RpaRoleVersionReference | undefined {
  if (!record(value)) return undefined
  const id = text(value.id, 256)
  return id ? { id, version: positive(value.version) } : undefined
}
function uniqueRoleRefs(value: unknown[], excluded?: string): RpaRoleVersionReference[] {
  const map = new Map<string, RpaRoleVersionReference>()
  for (const item of value) {
    const ref = sanitizeRoleRef(item)
    if (ref && ref.id !== excluded) map.set(ref.id, ref)
  }
  return [...map.values()]
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map((item) => text(item, 4_000)).filter(Boolean))] : []
}
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
function positive(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1
}
function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}
function positiveOptional(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}
function time(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}
function createId(now: number): string {
  return `rpa-session-${now}-${Math.random().toString(36).slice(2, 8)}`
}
export const rpaDslSessionRepository = new RpaDslSessionRepository()
