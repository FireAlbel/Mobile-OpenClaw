import { loggerService } from '@logger'

import { RpaAppStateRecognizer } from './RpaAppStateRecognizer'
import { RpaDeterministicRecoveryService } from './RpaDeterministicRecoveryService'
import {
  type RpaKnowledgeRetrievalResult,
  type RpaKnowledgeRetrievalService,
  rpaKnowledgeRetrievalService
} from './RpaKnowledgeRetrievalService'
import { readEmbeddedRpaModelContext } from './RpaModelContextBuilder'
import { type RpaModuleRegistry } from './RpaModuleRegistry'
import { RpaObservationService } from './RpaObservationService'
import { type RpaReplanResult, RpaReplanService } from './RpaReplanService'
import { RpaSafetyPolicyEngine } from './RpaSafetyPolicyEngine'
import { RpaTaskValidator } from './RpaTaskValidator'
import type {
  RpaAppStateProfile,
  RpaCorrectionAction,
  RpaCorrectionDecision,
  RpaDeviceRuntime,
  RpaFailureContext,
  RpaModuleResult,
  RpaRetryPolicy,
  RpaRunResult,
  RpaRunStepEvent,
  RpaSafetyApproval,
  RpaSafetyDecision,
  RpaStep,
  RpaStepStatus,
  RpaTask,
  RpaVerificationResult
} from './RpaTypes'
import { RpaVerificationEngine } from './RpaVerificationEngine'
import { RpaVisualCorrectionService } from './RpaVisualCorrectionService'

const logger = loggerService.withContext('RpaTaskExecutor')

interface RpaStepExecutionResult {
  result: RpaModuleResult
  verification: RpaVerificationResult
  actionSucceeded?: boolean
}

type RpaEventDetails = Partial<
  Pick<RpaRunStepEvent, 'phase' | 'recoveryRound' | 'parentStepId' | 'temporary' | 'action' | 'verification' | 'safety'>
>

export interface RpaTaskExecutorOptions {
  registry: RpaModuleRegistry
  runtime: RpaDeviceRuntime
  verificationEngine?: RpaVerificationEngine
  observationService?: RpaObservationService
  appStateRecognizer?: RpaAppStateRecognizer
  deterministicRecoveryService?: RpaDeterministicRecoveryService
  replanService?: RpaReplanService
  visualCorrectionService?: RpaVisualCorrectionService
  knowledgeRetrievalService?: RpaKnowledgeRetrievalService
  maxRecoveryAttempts?: number
  recoveryTimeoutMs?: number
  verificationTimeoutMs?: number
  minimumVlmRecoveryBudgetMs?: number
  noProgressLimit?: number
  maxDeterministicRecoveryDepth?: number
  safetyPolicyEngine?: RpaSafetyPolicyEngine
  safetyApproval?: RpaSafetyApproval
  onEvent?: (event: RpaRunStepEvent) => void
}

export class RpaTaskExecutor {
  private readonly validator: RpaTaskValidator
  private readonly verificationEngine: RpaVerificationEngine
  private readonly observationService: RpaObservationService
  private readonly appStateRecognizer: RpaAppStateRecognizer
  private readonly deterministicRecoveryService: RpaDeterministicRecoveryService
  private readonly replanService: RpaReplanService
  private readonly visualCorrectionService: RpaVisualCorrectionService
  private readonly knowledgeRetrievalService: RpaKnowledgeRetrievalService
  private readonly maxRecoveryAttempts: number
  private readonly recoveryTimeoutMs: number
  private readonly verificationTimeoutMs: number
  private readonly minimumVlmRecoveryBudgetMs: number
  private readonly noProgressLimit: number
  private readonly maxDeterministicRecoveryDepth: number
  private readonly safetyPolicyEngine: RpaSafetyPolicyEngine
  private externalSignal?: AbortSignal

  constructor(private readonly options: RpaTaskExecutorOptions) {
    this.validator = new RpaTaskValidator(options.registry)
    this.verificationEngine = options.verificationEngine ?? new RpaVerificationEngine({ runtime: options.runtime })
    this.observationService = options.observationService ?? new RpaObservationService(options.runtime)
    this.appStateRecognizer = options.appStateRecognizer ?? new RpaAppStateRecognizer()
    this.deterministicRecoveryService =
      options.deterministicRecoveryService ?? new RpaDeterministicRecoveryService(options.registry)
    this.replanService = options.replanService ?? new RpaReplanService({ registry: options.registry })
    this.visualCorrectionService = options.visualCorrectionService ?? new RpaVisualCorrectionService()
    this.knowledgeRetrievalService = options.knowledgeRetrievalService ?? rpaKnowledgeRetrievalService
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 3
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 120_000
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? 90_000
    this.minimumVlmRecoveryBudgetMs = Math.min(
      options.minimumVlmRecoveryBudgetMs ?? 60_000,
      Math.floor(this.recoveryTimeoutMs / 2)
    )
    this.noProgressLimit = options.noProgressLimit ?? 2
    this.maxDeterministicRecoveryDepth = options.maxDeterministicRecoveryDepth ?? 3
    this.safetyPolicyEngine = options.safetyPolicyEngine ?? new RpaSafetyPolicyEngine()
  }

  async run(input: unknown, deviceId: string, signal?: AbortSignal): Promise<RpaRunResult> {
    const validation = this.validator.validate(input)
    if (!validation.success || !validation.task) {
      const message = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
      throw new Error(`Invalid RPA task: ${message}`)
    }

    const task = validation.task
    if (!task.deviceIds.includes(deviceId)) {
      throw new Error(`Task ${task.id} is not assigned to device ${deviceId}`)
    }

    this.externalSignal = signal
    try {
      return await this.runValidatedTask(task, deviceId)
    } finally {
      this.externalSignal = undefined
    }
  }

  private async runValidatedTask(task: RpaTask, deviceId: string): Promise<RpaRunResult> {
    const startedAt = Date.now()
    const taskDeadline = task.timeout?.taskTimeoutMs ? startedAt + task.timeout.taskTimeoutMs : Number.POSITIVE_INFINITY
    const events: RpaRunStepEvent[] = []

    const emit = (
      step: RpaStep,
      status: RpaStepStatus,
      attempt: number,
      message: string,
      data?: unknown,
      details: RpaEventDetails = {}
    ): void => {
      const event: RpaRunStepEvent = {
        taskId: task.id,
        deviceId,
        stepId: step.id,
        stepName: step.name,
        status,
        attempt,
        message,
        timestamp: Date.now(),
        ...details,
        data
      }
      events.push(event)
      this.options.onEvent?.(event)
    }

    try {
      for (const step of task.steps) {
        this.throwIfAborted()
        if (Date.now() >= taskDeadline) {
          emit(step, 'timeout', 1, 'Task execution timed out', undefined, { phase: 'original_failure' })
          return {
            taskId: task.id,
            deviceId,
            success: false,
            status: 'failed',
            events,
            error: 'Task execution timed out',
            startedAt,
            finishedAt: Date.now()
          }
        }
        const stepIndex = task.steps.findIndex((item) => item.id === step.id)
        let stepExecution = await this.runStep(task, deviceId, step, emit, taskDeadline)
        const stepResult = stepExecution.result
        if (stepResult.status === 'cancelled') {
          return {
            taskId: task.id,
            deviceId,
            success: false,
            status: 'cancelled',
            events,
            error: stepResult.message,
            startedAt,
            finishedAt: Date.now()
          }
        }
        if (stepResult.status === 'needs_human' || isBlockedBySafety(stepResult)) {
          return {
            taskId: task.id,
            deviceId,
            success: false,
            status: stepResult.status === 'needs_human' ? 'needs_human' : 'failed',
            events,
            error: stepResult.message,
            failureContext: this.createFailureContext(
              task,
              deviceId,
              step,
              stepIndex,
              stepExecution,
              events,
              stepResult.message
            ),
            startedAt,
            finishedAt: Date.now()
          }
        }
        if (!stepResult.success && !step.continueOnFailure) {
          stepExecution = await this.recoverStep(
            task,
            deviceId,
            step,
            stepIndex,
            stepExecution,
            events,
            emit,
            taskDeadline
          )
          if (stepExecution.result.success) continue
          const finalResult = stepExecution.result

          const failureContext = this.createFailureContext(
            task,
            deviceId,
            step,
            stepIndex,
            stepExecution,
            events,
            finalResult.message
          )
          return {
            taskId: task.id,
            deviceId,
            success: false,
            status: finalResult.status === 'needs_human' ? 'needs_human' : 'failed',
            events,
            error: finalResult.message,
            failureContext,
            startedAt,
            finishedAt: Date.now()
          }
        }
      }

      return {
        taskId: task.id,
        deviceId,
        success: true,
        status: 'completed',
        events,
        startedAt,
        finishedAt: Date.now()
      }
    } catch (error) {
      const cancelled = this.externalSignal?.aborted === true
      if (cancelled) logger.info('RPA task execution cancelled', { taskId: task.id, deviceId })
      else logger.error('RPA task execution failed', { error, taskId: task.id, deviceId })
      return {
        taskId: task.id,
        deviceId,
        success: false,
        status: cancelled ? 'cancelled' : 'failed',
        events,
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt: Date.now()
      }
    }
  }

  private async runStep(
    task: RpaTask,
    deviceId: string,
    step: RpaStep,
    emit: (
      step: RpaStep,
      status: RpaStepStatus,
      attempt: number,
      message: string,
      data?: unknown,
      details?: RpaEventDetails
    ) => void,
    deadline: number = Number.POSITIVE_INFINITY,
    eventDetails: RpaEventDetails = {
      phase: 'original_step'
    }
  ): Promise<RpaStepExecutionResult> {
    const module = this.options.registry.require(step.moduleId)
    const retry = this.resolveRetryPolicy(task.retry, step.retry, module.metadata.defaultRetry)
    let lastResult: RpaModuleResult | undefined

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        const result: RpaModuleResult = {
          success: false,
          status: 'timeout',
          message: 'Task or recovery deadline exceeded',
          startedAt: Date.now(),
          finishedAt: Date.now()
        }
        return {
          result,
          verification: { status: 'uncertain', confidence: 0, message: result.message }
        }
      }
      const params = module.paramsSchema.parse(step.params)
      const safety = await this.authorizeModule(
        task,
        deviceId,
        step,
        module,
        params,
        attempt,
        deadline,
        emit,
        eventDetails
      )
      if (safety.decision !== 'allow') return this.safetyFailure(safety)

      emit(step, 'running', attempt, `Running ${step.moduleId}`, undefined, eventDetails)
      const timeoutMs = Math.max(1, Math.min(step.timeoutMs ?? module.metadata.defaultTimeoutMs, remainingMs))
      const result = await this.withTimeout(
        (signal) =>
          module.execute(
            {
              deviceId,
              task,
              step,
              attempt,
              runtime: this.options.runtime,
              signal
            },
            params
          ),
        timeoutMs
      )
      lastResult = result

      const verification = await this.verifyWithTimeout(
        task,
        step,
        result,
        deviceId,
        Math.max(1, Math.min(this.resolveVerificationTimeoutMs(step), deadline - Date.now()))
      )
      if (result.success && verification.status === 'passed') {
        emit(step, 'passed', attempt, result.message, { result, verification }, { ...eventDetails, verification })
        return { result, verification, actionSucceeded: true }
      }

      const failureStatus =
        result.status === 'timeout' ? 'timeout' : result.status === 'needs_human' ? 'needs_human' : 'failed'
      emit(
        step,
        failureStatus,
        attempt,
        verification.message,
        { result, verification },
        {
          ...eventDetails,
          verification
        }
      )

      if (!this.shouldRetry(result, verification, retry) || attempt >= retry.maxAttempts) {
        return {
          result: {
            ...result,
            success: false,
            status: result.status === 'needs_human' ? 'needs_human' : failureStatus,
            message: verification.message
          },
          verification,
          actionSucceeded: result.success
        }
      }

      await delay(retry.backoffMs, this.externalSignal)
    }

    const result = lastResult ?? {
      success: false,
      status: 'failed',
      message: 'Step did not execute',
      startedAt: Date.now(),
      finishedAt: Date.now()
    }
    return {
      result,
      verification: {
        status: 'failed',
        confidence: 1,
        message: result.message,
        evidence: result.data
      }
    }
  }

  private async recoverStep(
    task: RpaTask,
    deviceId: string,
    originalStep: RpaStep,
    originalStepIndex: number,
    initialExecution: RpaStepExecutionResult,
    events: RpaRunStepEvent[],
    emit: (
      step: RpaStep,
      status: RpaStepStatus,
      attempt: number,
      message: string,
      data?: unknown,
      details?: RpaEventDetails
    ) => void,
    taskDeadline: number
  ): Promise<RpaStepExecutionResult> {
    let failedExecution = initialExecution
    this.throwIfAborted()
    let latestObservation = await this.captureRecognizedObservation(task, deviceId, originalStep, events)
    this.throwIfAborted()
    const recoveryDeadline = Math.min(taskDeadline, Date.now() + this.recoveryTimeoutMs)
    const preVlmDeadline = recoveryDeadline - this.minimumVlmRecoveryBudgetMs
    const previousDecisions: RpaCorrectionDecision[] = []
    let previousDecisionSignature = ''
    let noProgressCount = 0
    let recoveryKnowledge: RpaKnowledgeRetrievalResult = { summaries: [], conflicts: [], warnings: [] }

    try {
      recoveryKnowledge = await this.knowledgeRetrievalService.retrieve({
        knowledgeBaseIds: readTaskKnowledgeIds(task),
        appPackage: readForegroundPackage(latestObservation.foregroundApp),
        taskGoal: task.goal,
        errorClass: initialExecution.result.status,
        categories: ['failure_case', 'recovery_guidance', 'page_state_explanation', 'locator_guidance']
      })
    } catch (error) {
      logger.warn('Failed to retrieve RPA recovery knowledge', {
        error,
        taskId: task.id,
        deviceId,
        stepId: originalStep.id
      })
    }

    emit(originalStep, 'failed', 1, `Original step failed: ${initialExecution.result.message}`, initialExecution, {
      phase: 'original_failure',
      parentStepId: originalStep.id
    })
    emit(
      originalStep,
      'running',
      1,
      `Recognized app state: ${latestObservation.recognizedState?.stateId ?? 'UNKNOWN'}`,
      { recognizedState: latestObservation.recognizedState, observation: latestObservation },
      { phase: 'state_recognition', parentStepId: originalStep.id }
    )

    const deterministicRecovery = initialExecution.actionSucceeded
      ? {
          status: 'continue' as const,
          observation: latestObservation,
          depth: 0,
          message: 'Action completed; defer failed verification to VLM before changing device state'
        }
      : preVlmDeadline <= Date.now()
        ? {
            status: 'continue' as const,
            observation: latestObservation,
            depth: 0,
            message: 'Deterministic recovery skipped to preserve the VLM recovery budget'
          }
        : await this.attemptDeterministicRecovery(
            task,
            deviceId,
            originalStep,
            latestObservation,
            events,
            emit,
            preVlmDeadline
          )
    latestObservation = deterministicRecovery.observation
    if (deterministicRecovery.status === 'human_required') {
      return this.finishRecoveryAsHuman(
        originalStep,
        deterministicRecovery.depth,
        deterministicRecovery.message,
        { observation: latestObservation, deterministicRecovery },
        emit,
        'deterministic_recovery_terminal'
      )
    }
    if (deterministicRecovery.status === 'recovered') {
      if (preVlmDeadline > Date.now()) {
        const retriedOriginal = await this.runStep(task, deviceId, originalStep, emit, preVlmDeadline, {
          phase: 'original_step',
          recoveryRound: deterministicRecovery.depth,
          parentStepId: originalStep.id
        })
        if (retriedOriginal.result.success) return retriedOriginal
        failedExecution = retriedOriginal
      }
    }

    for (let correctionRound = 1; correctionRound <= this.maxRecoveryAttempts; correctionRound += 1) {
      this.throwIfAborted()
      const remainingMs = recoveryDeadline - Date.now()
      if (remainingMs <= 0) {
        return this.finishRecoveryAsHuman(
          originalStep,
          correctionRound,
          'Correction timeout exceeded',
          { observation: latestObservation },
          emit
        )
      }

      const failureContext = this.createFailureContext(
        task,
        deviceId,
        originalStep,
        originalStepIndex,
        failedExecution,
        events,
        failedExecution.result.message
      )
      const beforeFingerprint = observationFingerprint(latestObservation)
      emit(
        originalStep,
        'running',
        correctionRound,
        `Correction round ${correctionRound}: observing current state`,
        {
          failureContext,
          observation: latestObservation
        },
        {
          phase: 'correction_observation',
          recoveryRound: correctionRound,
          parentStepId: originalStep.id
        }
      )

      let decisionResult
      try {
        decisionResult = await this.visualCorrectionService.decideRecovery({
          failureContext,
          observation: latestObservation,
          correctionRound,
          previousDecisions,
          knowledgeContext: recoveryKnowledge,
          modelContext: readEmbeddedRpaModelContext(task.metadata.rpaModelContext),
          signal: this.operationSignal(Math.max(1, remainingMs))
        })
      } catch (error) {
        const message = `VLM recovery analysis failed: ${error instanceof Error ? error.message : String(error)}`
        return this.finishRecoveryAsHuman(
          originalStep,
          correctionRound,
          message,
          { observation: latestObservation },
          emit
        )
      }

      if (decisionResult.status !== 'valid' || !decisionResult.decision) {
        return this.finishRecoveryAsHuman(
          originalStep,
          correctionRound,
          decisionResult.message,
          { decisionResult, observation: latestObservation },
          emit
        )
      }

      const decision = decisionResult.decision
      previousDecisions.push(decision)
      emit(
        originalStep,
        decision.decision === 'human_required' ? 'needs_human' : 'running',
        correctionRound,
        `Correction decision: ${decision.decision} - ${decision.reason}`,
        {
          decision,
          rawResponse: decisionResult.rawResponse,
          originalRawResponse: decisionResult.originalRawResponse,
          repaired: decisionResult.repaired,
          observation: latestObservation,
          knowledgeReferences: recoveryKnowledge.summaries.map((summary) => ({
            id: summary.id,
            knowledgeBaseId: summary.knowledgeBaseId,
            category: summary.category
          }))
        },
        {
          phase: 'correction_decision',
          recoveryRound: correctionRound,
          parentStepId: originalStep.id
        }
      )

      let plan: RpaReplanResult
      try {
        plan = await this.replanService.replan({
          failureContext,
          decision,
          latestObservation,
          correctionRound,
          signal: this.operationSignal(Math.max(1, recoveryDeadline - Date.now()))
        })
      } catch (error) {
        return this.finishRecoveryAsHuman(
          originalStep,
          correctionRound,
          `Temporary RPA planning failed: ${error instanceof Error ? error.message : String(error)}`,
          { decision, observation: latestObservation },
          emit
        )
      }
      if (plan.status === 'human_required') {
        return this.finishRecoveryAsHuman(
          originalStep,
          correctionRound,
          plan.message,
          { decision, plan, observation: latestObservation },
          emit
        )
      }

      const actionResults: RpaModuleResult[] = []
      let temporaryFailure: RpaStepExecutionResult | undefined
      if (plan.status === 'actions') {
        for (let index = 0; index < plan.actions.length; index += 1) {
          const action = plan.actions[index]
          const temporaryStep = plan.steps[index]
          const execution = await this.executeCorrectionAction(
            task,
            deviceId,
            originalStep,
            temporaryStep,
            action,
            correctionRound,
            recoveryDeadline,
            emit
          )
          actionResults.push(execution.result)
          if (!execution.result.success) {
            temporaryFailure = execution
            break
          }
        }
      } else if (plan.status === 'steps') {
        for (const temporaryStep of plan.steps) {
          const execution = await this.runStep(task, deviceId, temporaryStep, emit, recoveryDeadline, {
            phase: 'temporary_step',
            recoveryRound: correctionRound,
            parentStepId: originalStep.id,
            temporary: true
          })
          actionResults.push(execution.result)
          if (!execution.result.success) {
            temporaryFailure = execution
            break
          }
        }
      }

      if (temporaryFailure?.result.status === 'needs_human') return temporaryFailure

      const expectation = plan.expectedOutcome ?? task.goal
      const correctionVerification = await this.verifyCorrectionWithTimeout(
        task,
        deviceId,
        expectation,
        actionResults,
        recoveryDeadline
      )
      emit(
        originalStep,
        correctionVerification.status === 'passed' ? 'passed' : 'failed',
        correctionRound,
        `Correction verification: ${correctionVerification.message}`,
        { decision, plan, verification: correctionVerification },
        {
          phase: 'correction_verification',
          recoveryRound: correctionRound,
          parentStepId: originalStep.id,
          verification: correctionVerification
        }
      )

      if (plan.status === 'goal_achieved' && correctionVerification.status === 'passed') {
        return this.successfulRecoveryExecution('VLM goal decision independently verified', correctionVerification)
      }

      if (!temporaryFailure && correctionVerification.status === 'passed') {
        const retriedOriginal = await this.runStep(task, deviceId, originalStep, emit, recoveryDeadline, {
          phase: 'original_step',
          recoveryRound: correctionRound,
          parentStepId: originalStep.id
        })
        if (retriedOriginal.result.success) return retriedOriginal
        failedExecution = retriedOriginal
      } else if (temporaryFailure) {
        failedExecution = temporaryFailure
      } else {
        failedExecution = {
          result: {
            success: false,
            status: correctionVerification.status === 'uncertain' ? 'needs_human' : 'failed',
            message: correctionVerification.message,
            data: correctionVerification.evidence,
            startedAt: Date.now(),
            finishedAt: Date.now()
          },
          verification: correctionVerification
        }
      }

      const nextObservation = await this.captureRecognizedObservation(task, deviceId, originalStep, events)
      this.throwIfAborted()
      emit(
        originalStep,
        'running',
        correctionRound,
        `Recognized app state after correction: ${nextObservation.recognizedState?.stateId ?? 'UNKNOWN'}`,
        { recognizedState: nextObservation.recognizedState, observation: nextObservation },
        {
          phase: 'state_recognition',
          recoveryRound: correctionRound,
          parentStepId: originalStep.id
        }
      )
      const decisionSignature = correctionDecisionSignature(decision)
      const madeNoProgress =
        observationFingerprint(nextObservation) === beforeFingerprint ||
        (decisionSignature === previousDecisionSignature && correctionVerification.status !== 'passed')
      noProgressCount = madeNoProgress ? noProgressCount + 1 : 0
      previousDecisionSignature = decisionSignature
      latestObservation = nextObservation

      if (noProgressCount >= this.noProgressLimit) {
        return this.finishRecoveryAsHuman(
          originalStep,
          correctionRound,
          `Correction stopped after ${noProgressCount} round(s) without progress`,
          { decision, verification: correctionVerification, observation: latestObservation },
          emit
        )
      }
    }

    return this.finishRecoveryAsHuman(
      originalStep,
      this.maxRecoveryAttempts,
      `Correction attempts exhausted after ${this.maxRecoveryAttempts} rounds`,
      { observation: latestObservation, previousDecisions },
      emit
    )
  }

  private async attemptDeterministicRecovery(
    task: RpaTask,
    deviceId: string,
    originalStep: RpaStep,
    initialObservation: Awaited<ReturnType<RpaObservationService['capture']>>,
    events: RpaRunStepEvent[],
    emit: (
      step: RpaStep,
      status: RpaStepStatus,
      attempt: number,
      message: string,
      data?: unknown,
      details?: RpaEventDetails
    ) => void,
    recoveryDeadline: number
  ): Promise<
    | {
        status: 'recovered' | 'continue'
        observation: Awaited<ReturnType<RpaObservationService['capture']>>
        depth: number
        message: string
      }
    | {
        status: 'human_required'
        observation: Awaited<ReturnType<RpaObservationService['capture']>>
        depth: number
        message: string
      }
  > {
    let observation = initialObservation
    const attemptedPolicyIds: string[] = []
    let noProgressCount = 0

    for (let depth = 0; depth < this.maxDeterministicRecoveryDepth; depth += 1) {
      this.throwIfAborted()
      if (Date.now() >= recoveryDeadline) {
        return { status: 'continue', observation, depth: depth + 1, message: 'Deterministic recovery timed out' }
      }
      const plan = await this.deterministicRecoveryService.plan({
        task,
        observation,
        expectedStateId: readExpectedStateId(task, originalStep),
        depth,
        attemptedPolicyIds
      })
      if (plan.status === 'human_required') {
        return { status: 'human_required', observation, depth: depth + 1, message: plan.reason }
      }
      if (plan.status !== 'steps') {
        return {
          status: 'continue',
          observation,
          depth,
          message: plan.reason
        }
      }

      attemptedPolicyIds.push(plan.policyId)
      emit(
        originalStep,
        'running',
        depth + 1,
        `Deterministic recovery: ${plan.reason}`,
        { plan, observation },
        {
          phase: 'deterministic_recovery_plan',
          recoveryRound: depth + 1,
          parentStepId: originalStep.id
        }
      )
      const beforeFingerprint = observationFingerprint(observation)
      let failedExecution: RpaStepExecutionResult | undefined
      for (const step of plan.steps) {
        const execution = await this.runStep(task, deviceId, step, emit, recoveryDeadline, {
          phase: 'deterministic_recovery_action',
          recoveryRound: depth + 1,
          parentStepId: originalStep.id,
          temporary: true
        })
        if (!execution.result.success) {
          failedExecution = execution
          break
        }
      }
      if (failedExecution?.result.status === 'needs_human') {
        return {
          status: 'human_required',
          observation,
          depth: depth + 1,
          message: failedExecution.result.message
        }
      }

      const nextObservation = await this.captureRecognizedObservation(task, deviceId, originalStep, events)
      const recovered = !failedExecution && this.deterministicRecoveryService.isRecovered(plan, nextObservation)
      emit(
        originalStep,
        recovered ? 'passed' : 'failed',
        depth + 1,
        recovered
          ? `Deterministic recovery reached ${nextObservation.recognizedState?.stateId ?? 'a known state'}`
          : `Deterministic recovery did not reach a target state; current state is ${nextObservation.recognizedState?.stateId ?? 'UNKNOWN'}`,
        { plan, before: observation.recognizedState, after: nextObservation.recognizedState, failedExecution },
        {
          phase: 'deterministic_recovery_verification',
          recoveryRound: depth + 1,
          parentStepId: originalStep.id
        }
      )
      if (recovered) {
        return {
          status: 'recovered',
          observation: nextObservation,
          depth: depth + 1,
          message: `Deterministic recovery completed with policy ${plan.policyId}`
        }
      }

      const madeNoProgress = observationFingerprint(nextObservation) === beforeFingerprint
      noProgressCount = madeNoProgress ? noProgressCount + 1 : 0
      observation = nextObservation
      if (noProgressCount >= this.noProgressLimit) {
        return {
          status: 'continue',
          observation,
          depth: depth + 1,
          message: `Deterministic recovery yielded to VLM after ${noProgressCount} action group(s) without progress`
        }
      }
    }

    return {
      status: 'continue',
      observation,
      depth: this.maxDeterministicRecoveryDepth,
      message: `Deterministic recovery depth ${this.maxDeterministicRecoveryDepth} exhausted`
    }
  }

  private async captureRecognizedObservation(
    task: RpaTask,
    deviceId: string,
    step: RpaStep,
    events: RpaRunStepEvent[]
  ) {
    const profile = readAppStateProfile(task)
    const observation = await this.observationService.capture(deviceId, {
      includeScreenshot: true,
      includeForegroundApp: true,
      includeScreenSize: true,
      includeUiTree: true,
      includeOcr: true,
      targetTexts: profile?.states.flatMap((state) => [...(state.requiredTexts ?? []), ...(state.anyTexts ?? [])]),
      persistEvidence: true,
      artifactContext: {
        targetType: 'device_run',
        targetId: `${task.id}:${deviceId}`,
        relation: 'state_recognition_observation'
      }
    })
    try {
      await this.appStateRecognizer.recognize({
        observation,
        profile,
        expectedStateId: readExpectedStateId(task, step),
        recentEvents: events,
        persistEvidence: true,
        artifactContext: { targetType: 'device_run', targetId: `${task.id}:${deviceId}` }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      observation.warnings.push({ source: 'state_recognition', message })
      logger.warn('Failed to recognize app state', { error, taskId: task.id, deviceId, stepId: step.id })
    }
    return observation
  }

  private async executeCorrectionAction(
    task: RpaTask,
    deviceId: string,
    originalStep: RpaStep,
    temporaryStep: RpaStep,
    action: RpaCorrectionAction,
    recoveryRound: number,
    deadline: number,
    emit: (
      step: RpaStep,
      status: RpaStepStatus,
      attempt: number,
      message: string,
      data?: unknown,
      details?: RpaEventDetails
    ) => void
  ): Promise<RpaStepExecutionResult> {
    const timeoutMs = Math.max(1, Math.min(temporaryStep.timeoutMs ?? 30_000, deadline - Date.now()))
    const safety = await this.authorizeCorrectionAction(
      task,
      deviceId,
      originalStep,
      temporaryStep,
      action,
      recoveryRound,
      deadline,
      emit
    )
    if (safety.decision !== 'allow') return this.safetyFailure(safety)

    emit(
      temporaryStep,
      'running',
      1,
      `Executing correction action: ${action.type}`,
      { action },
      {
        phase: 'temporary_action',
        recoveryRound,
        parentStepId: originalStep.id,
        temporary: true,
        action
      }
    )
    const startedAt = Date.now()
    const controller = new AbortController()
    const unlinkAbort = linkAbortSignal(this.externalSignal, controller)
    const externalAbort = abortRejection(this.externalSignal)
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let runtimeResult: Awaited<ReturnType<RpaDeviceRuntime['executeCorrectionAction']>>
    try {
      runtimeResult = await Promise.race([
        this.options.runtime.executeCorrectionAction(deviceId, action, controller.signal),
        new Promise<Awaited<ReturnType<RpaDeviceRuntime['executeCorrectionAction']>>>((resolve) => {
          timeoutHandle = setTimeout(() => {
            controller.abort(new Error(`Correction action timed out after ${timeoutMs}ms`))
            resolve({
              success: false,
              message: `Correction action timed out after ${timeoutMs}ms`,
              startedAt,
              finishedAt: Date.now()
            })
          }, timeoutMs)
        }),
        externalAbort.promise
      ])
      this.throwIfAborted()
    } catch (error) {
      runtimeResult = {
        success: false,
        message: error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt: Date.now()
      }
    } finally {
      unlinkAbort()
      externalAbort.dispose()
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
    this.throwIfAborted()
    const result: RpaModuleResult = {
      success: runtimeResult.success,
      status: runtimeResult.success ? 'passed' : 'failed',
      message: runtimeResult.message,
      data: runtimeResult.data,
      startedAt,
      finishedAt: Date.now()
    }
    const verification: RpaVerificationResult = {
      status: result.success ? 'passed' : 'failed',
      confidence: 1,
      message: result.message,
      evidence: runtimeResult.data
    }
    emit(
      temporaryStep,
      result.status,
      1,
      result.message,
      { result, verification, action },
      {
        phase: 'temporary_action',
        recoveryRound,
        parentStepId: originalStep.id,
        temporary: true,
        action,
        verification
      }
    )
    return { result, verification }
  }

  private async verifyCorrectionWithTimeout(
    task: RpaTask,
    deviceId: string,
    expectation: string,
    actionResults: RpaModuleResult[],
    deadline: number
  ): Promise<RpaVerificationResult> {
    const timeoutMs = Math.max(1, deadline - Date.now())
    const controller = new AbortController()
    const unlinkAbort = linkAbortSignal(this.externalSignal, controller)
    const externalAbort = abortRejection(this.externalSignal)
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.verificationEngine.verifyCorrection({
          deviceId,
          expectation,
          actionResults,
          model: task.visionModel,
          modelContext: readEmbeddedRpaModelContext(task.metadata.rpaModelContext),
          signal: controller.signal
        }),
        new Promise<RpaVerificationResult>((resolve) => {
          timeoutHandle = setTimeout(() => {
            controller.abort(new Error(`Correction verification timed out after ${timeoutMs}ms`))
            resolve({
              status: 'uncertain',
              confidence: 0,
              message: `Correction verification timed out after ${timeoutMs}ms`
            })
          }, timeoutMs)
        }),
        externalAbort.promise
      ])
    } finally {
      unlinkAbort()
      externalAbort.dispose()
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private finishRecoveryAsHuman(
    originalStep: RpaStep,
    recoveryRound: number,
    message: string,
    data: unknown,
    emit: (
      step: RpaStep,
      status: RpaStepStatus,
      attempt: number,
      message: string,
      data?: unknown,
      details?: RpaEventDetails
    ) => void,
    phase: RpaRunStepEvent['phase'] = 'correction_terminal'
  ): RpaStepExecutionResult {
    emit(originalStep, 'needs_human', recoveryRound, message, data, {
      phase,
      recoveryRound,
      parentStepId: originalStep.id
    })
    return this.needsHumanExecution(message, data)
  }

  private successfulRecoveryExecution(message: string, verification: RpaVerificationResult): RpaStepExecutionResult {
    const now = Date.now()
    return {
      result: {
        success: true,
        status: 'passed',
        message,
        startedAt: now,
        finishedAt: now
      },
      verification
    }
  }

  private async authorizeModule(
    task: RpaTask,
    deviceId: string,
    step: RpaStep,
    module: ReturnType<RpaModuleRegistry['require']>,
    params: unknown,
    attempt: number,
    deadline: number,
    emit: (
      step: RpaStep,
      status: RpaStepStatus,
      attempt: number,
      message: string,
      data?: unknown,
      details?: RpaEventDetails
    ) => void,
    eventDetails: RpaEventDetails
  ): Promise<RpaSafetyDecision> {
    while (true) {
      let safety = await this.safetyPolicyEngine.evaluateModule({
        task,
        deviceId,
        step,
        module,
        params,
        approval: this.options.safetyApproval
      })
      if (safety.decision === 'delay' && Date.now() + (safety.delayMs ?? 0) >= deadline) {
        safety = { ...safety, decision: 'blocked', reason: 'Rate limit delay exceeds the execution deadline' }
      }
      emit(
        step,
        safetyStatus(safety),
        attempt,
        safety.reason,
        { safety },
        { ...eventDetails, phase: 'safety_policy', safety }
      )
      if (safety.decision !== 'delay') return safety
      await delay(safety.delayMs ?? 0, this.externalSignal)
    }
  }

  private async authorizeCorrectionAction(
    task: RpaTask,
    deviceId: string,
    originalStep: RpaStep,
    temporaryStep: RpaStep,
    action: RpaCorrectionAction,
    recoveryRound: number,
    deadline: number,
    emit: (
      step: RpaStep,
      status: RpaStepStatus,
      attempt: number,
      message: string,
      data?: unknown,
      details?: RpaEventDetails
    ) => void
  ): Promise<RpaSafetyDecision> {
    while (true) {
      let safety = await this.safetyPolicyEngine.evaluateCorrectionAction({
        task,
        deviceId,
        action,
        approval: this.options.safetyApproval
      })
      if (safety.decision === 'delay' && Date.now() + (safety.delayMs ?? 0) >= deadline) {
        safety = { ...safety, decision: 'blocked', reason: 'Rate limit delay exceeds the recovery deadline' }
      }
      emit(
        temporaryStep,
        safetyStatus(safety),
        1,
        safety.reason,
        { safety, action },
        {
          phase: 'safety_policy',
          recoveryRound,
          parentStepId: originalStep.id,
          temporary: true,
          action,
          safety
        }
      )
      if (safety.decision !== 'delay') return safety
      await delay(safety.delayMs ?? 0, this.externalSignal)
    }
  }

  private safetyFailure(safety: RpaSafetyDecision): RpaStepExecutionResult {
    const now = Date.now()
    const needsHuman = safety.decision === 'confirmation_required'
    const result: RpaModuleResult = {
      success: false,
      status: needsHuman ? 'needs_human' : 'failed',
      message: safety.reason,
      data: { safety },
      startedAt: now,
      finishedAt: now
    }
    return {
      result,
      verification: {
        status: needsHuman ? 'uncertain' : 'failed',
        confidence: 1,
        message: safety.reason,
        evidence: { safety }
      }
    }
  }

  private needsHumanExecution(message: string, data: unknown): RpaStepExecutionResult {
    const now = Date.now()
    const result: RpaModuleResult = {
      success: false,
      status: 'needs_human',
      message,
      data,
      startedAt: now,
      finishedAt: now
    }
    return {
      result,
      verification: { status: 'uncertain', confidence: 0, message, evidence: data }
    }
  }

  private createFailureContext(
    task: RpaTask,
    deviceId: string,
    failedStep: RpaStep,
    failedStepIndex: number,
    stepExecution: RpaStepExecutionResult,
    events: RpaRunStepEvent[],
    reason: string
  ): RpaFailureContext {
    return {
      task,
      deviceId,
      failedStep,
      failedStepIndex,
      result: stepExecution.result,
      verification: stepExecution.verification,
      events: [...events],
      reason,
      occurredAt: Date.now()
    }
  }

  private resolveRetryPolicy(
    taskRetry: RpaRetryPolicy | undefined,
    stepRetry: RpaRetryPolicy | undefined,
    moduleRetry: RpaRetryPolicy
  ): RpaRetryPolicy {
    return stepRetry ?? taskRetry ?? moduleRetry
  }

  private resolveVerificationTimeoutMs(step: RpaStep): number {
    return step.verify?.type === 'vlm_assert' ? (step.verify.timeoutMs ?? this.verificationTimeoutMs) : 30_000
  }

  private shouldRetry(result: RpaModuleResult, verification: RpaVerificationResult, retry: RpaRetryPolicy): boolean {
    if (result.status === 'needs_human') return false
    if (result.status === 'timeout') return retry.retryOn.includes('timeout')
    if (verification.status === 'uncertain') return retry.retryOn.includes('uncertain')
    return retry.retryOn.includes('failed')
  }

  private async verifyWithTimeout(
    task: RpaTask,
    step: RpaStep,
    result: RpaModuleResult,
    deviceId: string,
    timeoutMs: number
  ): Promise<RpaVerificationResult> {
    const controller = new AbortController()
    const unlinkAbort = linkAbortSignal(this.externalSignal, controller)
    const externalAbort = abortRejection(this.externalSignal)
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.verificationEngine.verify(
          step.verify,
          result,
          deviceId,
          task.visionModel,
          controller.signal,
          readEmbeddedRpaModelContext(task.metadata.rpaModelContext)
        ),
        new Promise<RpaVerificationResult>((resolve) => {
          timeoutHandle = setTimeout(() => {
            controller.abort(new Error(`Verification timed out after ${timeoutMs}ms`))
            resolve({
              status: 'uncertain',
              confidence: 0,
              message: `Verification timed out after ${timeoutMs}ms`
            })
          }, timeoutMs)
        }),
        externalAbort.promise
      ])
    } finally {
      unlinkAbort()
      externalAbort.dispose()
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private async withTimeout(
    operation: (signal: AbortSignal) => Promise<RpaModuleResult>,
    timeoutMs: number
  ): Promise<RpaModuleResult> {
    const startedAt = Date.now()
    const controller = new AbortController()
    const unlinkAbort = linkAbortSignal(this.externalSignal, controller)
    const externalAbort = abortRejection(this.externalSignal)
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<RpaModuleResult>((resolve) => {
          timeoutHandle = setTimeout(() => {
            controller.abort(new Error(`Step timed out after ${timeoutMs}ms`))
            resolve({
              success: false,
              status: 'timeout',
              message: `Step timed out after ${timeoutMs}ms`,
              startedAt,
              finishedAt: Date.now()
            })
          }, timeoutMs)
        }),
        externalAbort.promise
      ])
    } finally {
      unlinkAbort()
      externalAbort.dispose()
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private operationSignal(timeoutMs: number): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    return this.externalSignal ? AbortSignal.any([this.externalSignal, timeoutSignal]) : timeoutSignal
  }

  private throwIfAborted(): void {
    this.externalSignal?.throwIfAborted()
  }
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (durationMs <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, durationMs)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(signal?.reason ?? new Error('RPA operation aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function linkAbortSignal(source: AbortSignal | undefined, controller: AbortController): () => void {
  if (!source) return () => undefined
  const onAbort = () => controller.abort(source.reason)
  if (source.aborted) onAbort()
  else source.addEventListener('abort', onAbort, { once: true })
  return () => source.removeEventListener('abort', onAbort)
}

function abortRejection(signal: AbortSignal | undefined): { promise: Promise<never>; dispose: () => void } {
  if (!signal) return { promise: new Promise<never>(() => undefined), dispose: () => undefined }
  let onAbort: (() => void) | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('RPA operation aborted'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}

function safetyStatus(decision: RpaSafetyDecision): RpaStepStatus {
  if (decision.decision === 'confirmation_required') return 'needs_human'
  if (decision.decision === 'blocked') return 'failed'
  return 'running'
}

function isBlockedBySafety(result: RpaModuleResult): boolean {
  const data = result.data
  if (!data || typeof data !== 'object' || !('safety' in data)) return false
  const safety = data.safety
  return Boolean(safety && typeof safety === 'object' && 'decision' in safety && safety.decision === 'blocked')
}

function readTaskKnowledgeIds(task: RpaTask): string[] {
  const assets = task.metadata.rpaAssets
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return []
  const knowledgeIds = (assets as Record<string, unknown>).knowledgeIds
  if (!Array.isArray(knowledgeIds)) return []
  return [...new Set(knowledgeIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())))]
}

function readAppStateProfile(task: RpaTask): RpaAppStateProfile | undefined {
  const value = task.metadata.appStateProfile
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (!Array.isArray(source.states)) return undefined
  const states = source.states.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const state = candidate as Record<string, unknown>
    if (typeof state.stateId !== 'string' || !state.stateId.trim()) return []
    const blockingConditions = new Set([
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
    const recoveryScopes = new Set(['none', 'dismiss_overlay', 'navigate', 'restart_app', 'human'])
    return [
      {
        stateId: state.stateId.trim(),
        label: readOptionalString(state.label),
        priority: typeof state.priority === 'number' && Number.isFinite(state.priority) ? state.priority : undefined,
        packageNames: readStringArray(state.packageNames),
        activityIncludes: readStringArray(state.activityIncludes),
        requiredTexts: readStringArray(state.requiredTexts),
        anyTexts: readStringArray(state.anyTexts),
        excludedTexts: readStringArray(state.excludedTexts),
        requireScreenshot: typeof state.requireScreenshot === 'boolean' ? state.requireScreenshot : undefined,
        blockingCondition:
          typeof state.blockingCondition === 'string' && blockingConditions.has(state.blockingCondition)
            ? (state.blockingCondition as RpaAppStateProfile['states'][number]['blockingCondition'])
            : undefined,
        recoveryScope:
          typeof state.recoveryScope === 'string' && recoveryScopes.has(state.recoveryScope)
            ? (state.recoveryScope as RpaAppStateProfile['states'][number]['recoveryScope'])
            : undefined,
        suggestedTransitions: readStringArray(state.suggestedTransitions)
      }
    ]
  })
  if (!states.length) return undefined
  return {
    appPackage: readOptionalString(source.appPackage),
    appVersion: readOptionalString(source.appVersion),
    states
  }
}

function readExpectedStateId(task: RpaTask, step: RpaStep): string | undefined {
  for (const value of [step.params.expectedStateId, task.metadata.expectedStateId]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = [
    ...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()))
  ].filter(Boolean)
  return values.length ? values : undefined
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readForegroundPackage(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  for (const key of ['packageName', 'package', 'appPackage']) {
    const candidate = source[key]
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return undefined
}

function correctionDecisionSignature(decision: RpaCorrectionDecision): string {
  if (decision.decision === 'execute_actions') return JSON.stringify(decision.actions)
  if (decision.decision === 'replan') return `${decision.decision}:${decision.objective}`
  return `${decision.decision}:${decision.reason}`
}

function observationFingerprint(observation: Awaited<ReturnType<RpaObservationService['capture']>>): string {
  const screenshot = observation.screenshot
  const imageBase64 =
    screenshot && typeof screenshot === 'object' && 'imageBase64' in screenshot ? String(screenshot.imageBase64) : ''
  const sample = imageBase64
    ? `${imageBase64.length}:${imageBase64.slice(0, 128)}:${imageBase64.slice(-128)}`
    : 'no-screenshot'
  return `${simpleHash(sample)}:${simpleHash(JSON.stringify(observation.foregroundApp ?? null))}`
}

function simpleHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}
