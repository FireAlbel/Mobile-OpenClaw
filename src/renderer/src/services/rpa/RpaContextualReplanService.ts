import type { EffectiveRpaContext } from './EffectiveRpaContextResolver'
import { defaultRpaModuleRegistry } from './RpaDefaultRegistry'
import type { RpaDslSession, RpaDslSessionRepository } from './RpaDslSession'
import { rpaDslSessionRepository } from './RpaDslSession'
import { rpaFailureFingerprintRepository } from './RpaFailureFingerprint'
import type { RpaKnowledgeRetrievalResult } from './RpaKnowledgeRetrievalService'
import { RpaPlannerService } from './RpaPlannerService'
import { resolveRpaPlanningRequestError, rpaPlanningRequestCoordinator } from './RpaPlanningRequestCoordinator'
import { createRpaDslProvenance } from './RpaRunContextSnapshot'
import type { RpaBatchRunRecord } from './RpaRunStorage'
import { RpaSkillCompiler } from './RpaSkillCompiler'
import { rpaSkillRepository } from './RpaSkillRepository'
import { RpaTaskValidator } from './RpaTaskValidator'
import type { RpaTask, RpaValidationIssue } from './RpaTypes'

export interface RpaContextualReplanInput {
  session: RpaDslSession
  objective: string
  effectiveContext: EffectiveRpaContext
  knowledgeContext?: RpaKnowledgeRetrievalResult
  validationIssues?: RpaValidationIssue[]
  run?: RpaBatchRunRecord
  signal?: AbortSignal
  requestId?: string
}

export interface RpaContextualReplanResult {
  session: RpaDslSession
  task: RpaTask
  sourceRevision: number
  evidenceKind: 'validation' | 'execution'
  repaired: boolean
}

const defaultPlanner = new RpaPlannerService({
  registry: defaultRpaModuleRegistry,
  skillRepository: rpaSkillRepository,
  skillCompiler: new RpaSkillCompiler(defaultRpaModuleRegistry),
  failureFingerprintRepository: rpaFailureFingerprintRepository
})

export class RpaContextualReplanService {
  private readonly validator = new RpaTaskValidator(defaultRpaModuleRegistry, { requireDeviceIds: false })

  constructor(
    private readonly planner: Pick<RpaPlannerService, 'plan'> = defaultPlanner,
    private readonly repository: RpaDslSessionRepository = rpaDslSessionRepository
  ) {}

  async replan(input: RpaContextualReplanInput): Promise<RpaContextualReplanResult> {
    const objective = input.objective.trim()
    if (!objective) throw new Error('A contextual Replan objective is required')
    if (
      input.session.status === 'executing' &&
      (!input.run ||
        input.run.deviceRuns.some((deviceRun) => deviceRun.status === 'pending' || deviceRun.status === 'running'))
    ) {
      throw new Error('Pause or stop the active run before Replan')
    }
    const revision = input.session.revisions.find(
      (candidate) => candidate.version === input.session.activeRevisionVersion
    )
    if (!revision) throw new Error('Contextual Replan requires an active DSL revision')
    const roleContext = input.effectiveContext.roleContext
    if (!roleContext) throw new Error('Contextual Replan requires an effective Role context')
    if (
      revision.roleContext.primaryRole.id !== roleContext.primaryRole.id ||
      revision.roleContext.primaryRole.version !== roleContext.primaryRole.version
    ) {
      throw new Error('Contextual Replan Role context does not match the immutable source revision')
    }

    const validationIssues = input.validationIssues?.filter((issue) => issue.message.trim()) ?? []
    const executionEvidence = readExecutionEvidence(input.run)
    if (!validationIssues.length && !executionEvidence.length) {
      throw new Error('Contextual Replan requires validation, execution failure, or manual-intervention evidence')
    }
    const evidenceKind = validationIssues.length ? 'validation' : 'execution'
    const requestId = input.requestId?.trim() || `contextual-replan-${Date.now()}`
    const planningRequest = rpaPlanningRequestCoordinator.start({
      requestId,
      sessionId: input.session.id,
      baseRevision: revision.version,
      expectedVersion: input.session.version,
      supplementRevision: revision.requestContext?.supplementRevision ?? 0,
      requestedAt: Date.now(),
      timeoutMs: 120_000
    })
    await this.repository.recordPlanningRequest(input.session.id, {
      requestId,
      baseRevision: revision.version,
      expectedVersion: input.session.version,
      supplementRevision: revision.requestContext?.supplementRevision ?? 0,
      status: 'pending'
    })
    try {
      const result = await this.planner.plan({
        goal: input.session.goal,
        baseTask: revision.dsl,
        revisionInstruction: objective,
        deviceIds: [],
        taskId: `${readTaskId(revision.dsl)}-replan-${Date.now()}`,
        taskName: `${readTaskName(revision.dsl, input.session.goal)} Replan`,
        effectiveContext: input.effectiveContext,
        knowledgeContext: input.knowledgeContext,
        executionHistory: [
          {
            sourceRevision: revision.version,
            validationIssues,
            executionEvidence
          }
        ],
        signal: input.signal ? AbortSignal.any([input.signal, planningRequest.signal]) : planningRequest.signal
      })
      const currentSession = await this.repository.getById(input.session.id)
      if (!currentSession) throw new Error(`RPA DSL session not found: ${input.session.id}`)
      planningRequest.assertCurrent(currentSession, planningRequest.input.supplementRevision)
      if (result.clarifications?.length) {
        throw new Error(result.clarifications.map((item) => item.question).join('; '))
      }
      if (!result.success || !result.task) {
        await this.repository.recordPlanningFailure(input.session.id, currentSession.version, {
          requestId,
          sourceRevision: revision.version,
          candidate: result.rawResponse,
          issues: result.issues
        })
        throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ') || 'Replan failed')
      }

      const nextSession = await this.repository.appendRevision(
        input.session.id,
        { ...result.task, deviceIds: [] },
        revision.roleContext,
        {
          validate: (dsl) => {
            const validation = this.validator.validate(dsl)
            return { dsl: validation.task ?? dsl, issues: validation.issues, executable: validation.success }
          }
        },
        {
          expectedSessionVersion: currentSession.version,
          source: 'repair',
          humanReadableExplanation: `Contextual Replan from revision ${revision.version}: ${objective}`,
          requestContext: {
            requestId,
            sessionId: input.session.id,
            baseRevision: revision.version,
            expectedVersion: currentSession.version,
            supplementRevision: revision.requestContext?.supplementRevision ?? 0,
            provenance: createRpaDslProvenance(input.effectiveContext, result.task.metadata)
          }
        }
      )
      planningRequest.release()
      await this.repository.recordPlanningRequest(nextSession.id, {
        requestId,
        baseRevision: revision.version,
        expectedVersion: currentSession.version,
        supplementRevision: revision.requestContext?.supplementRevision ?? 0,
        status: 'accepted'
      })
      const task = nextSession.revisions.find((candidate) => candidate.version === nextSession.activeRevisionVersion)
        ?.dsl as RpaTask
      return { session: nextSession, task, sourceRevision: revision.version, evidenceKind, repaired: result.repaired }
    } catch (error) {
      const planningError = resolveRpaPlanningRequestError(error, planningRequest.signal)
      await this.repository.recordPlanningRequest(input.session.id, {
        requestId,
        baseRevision: revision.version,
        expectedVersion: input.session.version,
        supplementRevision: revision.requestContext?.supplementRevision ?? 0,
        status: planningError?.status ?? 'failed',
        reason: error instanceof Error ? error.message : String(error)
      })
      planningRequest.release()
      throw error
    }
  }
}

function readExecutionEvidence(run: RpaBatchRunRecord | undefined): unknown[] {
  if (!run) return []
  return run.deviceRuns.flatMap((deviceRun) => {
    if (deviceRun.status !== 'failed' && deviceRun.status !== 'needs_human') return []
    return [
      {
        runId: run.id,
        deviceRunId: deviceRun.id,
        deviceId: deviceRun.deviceId,
        status: deviceRun.status,
        error: deviceRun.error,
        events: deviceRun.events.slice(-20)
      }
    ]
  })
}

function readTaskId(value: unknown): string {
  return isRecord(value) && typeof value.id === 'string' && value.id.trim() ? value.id.trim() : 'rpa-task'
}

function readTaskName(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.name === 'string' && value.name.trim() ? value.name.trim() : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const rpaContextualReplanService = new RpaContextualReplanService()
