import { loggerService } from '@logger'

import { type RpaModuleRegistry } from './RpaModuleRegistry'
import { RpaTaskValidator } from './RpaTaskValidator'
import type {
  RpaDeviceRuntime,
  RpaModuleResult,
  RpaRetryPolicy,
  RpaRunResult,
  RpaRunStepEvent,
  RpaStep,
  RpaStepStatus,
  RpaTask,
  RpaVerification,
  RpaVerificationResult
} from './RpaTypes'

const logger = loggerService.withContext('RpaTaskExecutor')

export interface RpaTaskExecutorOptions {
  registry: RpaModuleRegistry
  runtime: RpaDeviceRuntime
  onEvent?: (event: RpaRunStepEvent) => void
}

export class RpaTaskExecutor {
  private readonly validator: RpaTaskValidator

  constructor(private readonly options: RpaTaskExecutorOptions) {
    this.validator = new RpaTaskValidator(options.registry)
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
        const stepResult = await this.runStep(task, deviceId, step, emit)
        if (!stepResult.success && !step.continueOnFailure) {
          return {
            taskId: task.id,
            deviceId,
            success: false,
            status: stepResult.status === 'needs_human' ? 'needs_human' : 'failed',
            events,
            error: stepResult.message,
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
  ): Promise<RpaModuleResult> {
    const module = this.options.registry.require(step.moduleId)
    const retry = this.resolveRetryPolicy(task.retry, step.retry, module.metadata.defaultRetry)
    let lastResult: RpaModuleResult | undefined

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
      emit(step, 'running', attempt, `Running ${step.moduleId}`)
      const params = module.paramsSchema.parse(step.params)
      const timeoutMs = step.timeoutMs ?? module.metadata.defaultTimeoutMs
      const result = await this.withTimeout(
        module.execute(
          {
            deviceId,
            task,
            step,
            attempt,
            runtime: this.options.runtime
          },
          params
        ),
        timeoutMs
      )
      lastResult = result

      const verification = await this.verify(step.verify, result, deviceId)
      if (result.success && verification.status === 'passed') {
        emit(step, 'passed', attempt, result.message, { result, verification })
        return result
      }

      const failureStatus = result.status === 'timeout' ? 'timeout' : 'failed'
      emit(step, failureStatus, attempt, verification.message, { result, verification })

      if (!this.shouldRetry(result, verification, retry) || attempt >= retry.maxAttempts) {
        return {
          ...result,
          success: false,
          status: verification.status === 'uncertain' ? 'needs_human' : failureStatus,
          message: verification.message
        }
      }

      await delay(retry.backoffMs)
    }

    return (
      lastResult ?? {
        success: false,
        status: 'failed',
        message: 'Step did not execute',
        startedAt: Date.now(),
        finishedAt: Date.now()
      }
    )
  }

  private async verify(
    verification: RpaVerification | undefined,
    result: RpaModuleResult,
    deviceId: string
  ): Promise<RpaVerificationResult> {
    if (!verification || verification.type === 'module_result_success') {
      return result.success
        ? { status: 'passed', confidence: 1, message: result.message, evidence: result.data }
        : { status: 'failed', confidence: 1, message: result.message, evidence: result.data }
    }

    if (verification.type === 'none') {
      return { status: 'passed', confidence: 1, message: 'Verification skipped' }
    }

    if (verification.type === 'screenshot_exists') {
      const screenshot = result.success && result.data ? result : await this.options.runtime.screenshot(deviceId)
      return screenshot.success && screenshot.data
        ? { status: 'passed', confidence: 1, message: 'Screenshot captured', evidence: screenshot.data }
        : { status: 'failed', confidence: 1, message: screenshot.message }
    }

    if (verification.type === 'foreground_app') {
      const foreground = await this.options.runtime.getForegroundApp(deviceId)
      const packageName =
        typeof foreground.data === 'object' && foreground.data && 'packageName' in foreground.data
          ? String(foreground.data.packageName)
          : ''
      return foreground.success && packageName === verification.packageName
        ? {
            status: 'passed',
            confidence: 1,
            message: `Foreground app matched ${verification.packageName}`,
            evidence: foreground.data
          }
        : {
            status: foreground.success ? 'failed' : 'uncertain',
            confidence: foreground.success ? 1 : 0,
            message: foreground.success
              ? `Foreground app mismatch, expected ${verification.packageName}, got ${packageName || 'unknown'}`
              : foreground.message,
            evidence: foreground.data
          }
    }

    return { status: 'uncertain', confidence: 0, message: 'Unsupported verification rule' }
  }

  private resolveRetryPolicy(
    taskRetry: RpaRetryPolicy | undefined,
    stepRetry: RpaRetryPolicy | undefined,
    moduleRetry: RpaRetryPolicy
  ): RpaRetryPolicy {
    return stepRetry ?? taskRetry ?? moduleRetry
  }

  private shouldRetry(result: RpaModuleResult, verification: RpaVerificationResult, retry: RpaRetryPolicy): boolean {
    if (result.status === 'timeout') return retry.retryOn.includes('timeout')
    if (verification.status === 'uncertain') return retry.retryOn.includes('uncertain')
    return retry.retryOn.includes('failed')
  }

  private async withTimeout(operation: Promise<RpaModuleResult>, timeoutMs: number): Promise<RpaModuleResult> {
    const startedAt = Date.now()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<RpaModuleResult>((resolve) => {
          timeoutHandle = setTimeout(() => {
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
