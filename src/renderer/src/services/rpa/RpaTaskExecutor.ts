import { loggerService } from '@logger'

import { type RpaModuleRegistry } from './RpaModuleRegistry'
import { RpaObservationService } from './RpaObservationService'
import { RpaReplanService } from './RpaReplanService'
import { RpaTaskValidator } from './RpaTaskValidator'
import type {
  RpaDeviceRuntime,
  RpaFailureContext,
  RpaModuleResult,
  RpaRetryPolicy,
  RpaRunResult,
  RpaRunStepEvent,
  RpaStep,
  RpaStepStatus,
  RpaTask,
  RpaVerificationResult
} from './RpaTypes'
import { RpaVerificationEngine } from './RpaVerificationEngine'

const logger = loggerService.withContext('RpaTaskExecutor')

interface RpaStepExecutionResult {
  result: RpaModuleResult
  verification: RpaVerificationResult
}

export interface RpaTaskExecutorOptions {
  registry: RpaModuleRegistry
  runtime: RpaDeviceRuntime
  verificationEngine?: RpaVerificationEngine
  observationService?: RpaObservationService
  replanService?: RpaReplanService
  maxRecoveryAttempts?: number
  onEvent?: (event: RpaRunStepEvent) => void
}

export class RpaTaskExecutor {
  private readonly validator: RpaTaskValidator
  private readonly verificationEngine: RpaVerificationEngine
  private readonly observationService: RpaObservationService
  private readonly replanService: RpaReplanService
  private readonly maxRecoveryAttempts: number

  constructor(private readonly options: RpaTaskExecutorOptions) {
    this.validator = new RpaTaskValidator(options.registry)
    this.verificationEngine = options.verificationEngine ?? new RpaVerificationEngine({ runtime: options.runtime })
    this.observationService = options.observationService ?? new RpaObservationService(options.runtime)
    this.replanService = options.replanService ?? new RpaReplanService({ registry: options.registry })
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 2
  }

  async run(input: unknown, deviceId: string): Promise<RpaRunResult> {
    const validation = this.validator.validate(input)
    if (!validation.success || !validation.task) {
      const message = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
      throw new Error(`Invalid RPA task: ${message}`)
    }

    const task = validation.task
    if (!task.deviceIds.includes(deviceId)) {
      throw new Error(`Task ${task.id} is not assigned to device ${deviceId}`)
    }

    return this.runValidatedTask(task, deviceId)
  }

  private async runValidatedTask(task: RpaTask, deviceId: string): Promise<RpaRunResult> {
    const startedAt = Date.now()
    const events: RpaRunStepEvent[] = []

    const emit = (step: RpaStep, status: RpaStepStatus, attempt: number, message: string, data?: unknown): void => {
      const event: RpaRunStepEvent = {
        taskId: task.id,
        deviceId,
        stepId: step.id,
        stepName: step.name,
        status,
        attempt,
        message,
        timestamp: Date.now(),
        data
      }
      events.push(event)
      this.options.onEvent?.(event)
    }

    try {
      for (const step of task.steps) {
        const stepIndex = task.steps.findIndex((item) => item.id === step.id)
        let stepExecution = await this.runStep(task, deviceId, step, emit)
        const stepResult = stepExecution.result
        if (!stepResult.success && !step.continueOnFailure) {
          stepExecution = await this.recoverStep(task, deviceId, step, stepIndex, stepExecution, events, emit)
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
      logger.error('RPA task execution failed', { error, taskId: task.id, deviceId })
      return {
        taskId: task.id,
        deviceId,
        success: false,
        status: 'failed',
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
    emit: (step: RpaStep, status: RpaStepStatus, attempt: number, message: string, data?: unknown) => void
  ): Promise<RpaStepExecutionResult> {
    const module = this.options.registry.require(step.moduleId)
    const retry = this.resolveRetryPolicy(task.retry, step.retry, module.metadata.defaultRetry)
    let lastResult: RpaModuleResult | undefined

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      emit(step, 'running', attempt, `Running ${step.moduleId}`)
      const params = module.paramsSchema.parse(step.params)
      const timeoutMs = step.timeoutMs ?? module.metadata.defaultTimeoutMs
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

      const verification = await this.verificationEngine.verify(step.verify, result, deviceId)
      if (result.success && verification.status === 'passed') {
        emit(step, 'passed', attempt, result.message, { result, verification })
        return { result, verification }
      }

      const failureStatus =
        result.status === 'timeout' ? 'timeout' : result.status === 'needs_human' ? 'needs_human' : 'failed'
      emit(step, failureStatus, attempt, verification.message, { result, verification })

      if (!this.shouldRetry(result, verification, retry) || attempt >= retry.maxAttempts) {
        return {
          result: {
            ...result,
            success: false,
            status:
              result.status === 'needs_human' || verification.status === 'uncertain' ? 'needs_human' : failureStatus,
            message: verification.message
          },
          verification
        }
      }

      await delay(retry.backoffMs)
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
    emit: (step: RpaStep, status: RpaStepStatus, attempt: number, message: string, data?: unknown) => void
  ): Promise<RpaStepExecutionResult> {
    let failedStep = originalStep
    let failedStepIndex = originalStepIndex
    let failedExecution = initialExecution
    let latestObservation = await this.observationService.capture(deviceId)

    for (let correctionAttempt = 0; correctionAttempt < this.maxRecoveryAttempts; correctionAttempt += 1) {
      const failureContext = this.createFailureContext(
        task,
        deviceId,
        failedStep,
        failedStepIndex,
        failedExecution,
        events,
        failedExecution.result.message
      )
      emit(
        originalStep,
        'running',
        correctionAttempt + 1,
        `Analyzing failure with VLM (${correctionAttempt + 1}/${this.maxRecoveryAttempts})`,
        { phase: 'recovery_analysis', failureContext, observation: latestObservation }
      )

      let decision
      try {
        decision = await this.replanService.replan({
          failureContext,
          latestObservation,
          correctionAttempt,
          maxCorrectionAttempts: this.maxRecoveryAttempts
        })
      } catch (error) {
        const message = `VLM recovery analysis failed: ${error instanceof Error ? error.message : String(error)}`
        emit(originalStep, 'needs_human', correctionAttempt + 1, message, {
          phase: 'recovery_decision',
          observation: latestObservation
        })
        return this.needsHumanExecution(message, { observation: latestObservation })
      }

      emit(
        originalStep,
        decision.status === 'needs_human' ? 'needs_human' : 'running',
        correctionAttempt + 1,
        `Recovery decision: ${decision.status} - ${decision.message}`,
        { phase: 'recovery_decision', decision, observation: latestObservation }
      )

      if (decision.status === 'needs_human') {
        return this.needsHumanExecution(decision.message, { decision, observation: latestObservation })
      }

      let recoveryFailed = false
      if (decision.status === 'corrected') {
        for (const recoveryStep of decision.steps) {
          const recoveryExecution = await this.runStep(task, deviceId, recoveryStep, emit)
          if (!recoveryExecution.result.success) {
            failedStep = recoveryStep
            failedStepIndex = originalStepIndex
            failedExecution = recoveryExecution
            recoveryFailed = true
            break
          }
        }
      }

      if (!recoveryFailed) {
        const retriedOriginal = await this.runStep(task, deviceId, originalStep, emit)
        if (retriedOriginal.result.success) return retriedOriginal
        failedStep = originalStep
        failedStepIndex = originalStepIndex
        failedExecution = retriedOriginal
      }

      latestObservation = await this.observationService.capture(deviceId)
    }

    const message = `VLM recovery attempts exhausted after ${this.maxRecoveryAttempts} attempts`
    emit(originalStep, 'needs_human', this.maxRecoveryAttempts, message, {
      phase: 'recovery_exhausted',
      observation: latestObservation
    })
    return this.needsHumanExecution(message, { observation: latestObservation })
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

  private shouldRetry(result: RpaModuleResult, verification: RpaVerificationResult, retry: RpaRetryPolicy): boolean {
    if (result.status === 'needs_human') return false
    if (result.status === 'timeout') return retry.retryOn.includes('timeout')
    if (verification.status === 'uncertain') return retry.retryOn.includes('uncertain')
    return retry.retryOn.includes('failed')
  }

  private async withTimeout(
    operation: (signal: AbortSignal) => Promise<RpaModuleResult>,
    timeoutMs: number
  ): Promise<RpaModuleResult> {
    const startedAt = Date.now()
    const controller = new AbortController()
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
        })
      ])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }
}

function delay(durationMs: number): Promise<void> {
  if (durationMs <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}
