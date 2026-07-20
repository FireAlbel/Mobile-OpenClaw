import { loggerService } from '@logger'
import type { Model } from '@renderer/types'
import type { ModelMessage } from 'ai'

import { parseJsonFromText } from './RpaJsonUtils'
import { DefaultRpaModelClient, type RpaModelClient } from './RpaModelClient'
import type { RpaModuleRegistry } from './RpaModuleRegistry'
import { RpaTaskValidator } from './RpaTaskValidator'
import type { RpaDeviceObservation, RpaTask, RpaValidationIssue } from './RpaTypes'

const logger = loggerService.withContext('RpaPlannerService')

export interface RpaPlannerInput {
  goal: string
  deviceIds: string[]
  observations?: RpaDeviceObservation[]
  taskId?: string
  taskName?: string
  model?: Model
  signal?: AbortSignal
}

export interface RpaPlannerResult {
  success: boolean
  task?: RpaTask
  rawResponse: string
  repaired: boolean
  issues: RpaValidationIssue[]
}

export interface RpaPlannerServiceOptions {
  registry: RpaModuleRegistry
  modelClient?: RpaModelClient
}

export class RpaPlannerService {
  private readonly modelClient: RpaModelClient
  private readonly validator: RpaTaskValidator

  constructor(private readonly options: RpaPlannerServiceOptions) {
    this.modelClient = options.modelClient ?? new DefaultRpaModelClient()
    this.validator = new RpaTaskValidator(options.registry, { requireDeviceIds: false })
  }

  async plan(input: RpaPlannerInput): Promise<RpaPlannerResult> {
    const rawResponse = await this.modelClient.complete({
      messages: this.buildPlanMessages(input),
      model: input.model,
      signal: input.signal
    })
    const initialParse = this.tryParseTask(rawResponse)
    const validation = initialParse.task
      ? this.validator.validate(initialParse.task)
      : { success: false, issues: [initialParse.issue] }
    if (validation.success && validation.task) {
      return {
        success: true,
        task: validation.task,
        rawResponse,
        repaired: false,
        issues: []
      }
    }

    const repairResponse = await this.modelClient.complete({
      messages: this.buildRepairMessages(input, rawResponse, validation.issues),
      model: input.model,
      signal: input.signal
    })
    const repairedParse = this.tryParseTask(repairResponse)
    const repairedValidation = repairedParse.task
      ? this.validator.validate(repairedParse.task)
      : { success: false, issues: [repairedParse.issue] }

    return {
      success: repairedValidation.success,
      task: repairedValidation.task,
      rawResponse: repairResponse,
      repaired: true,
      issues: repairedValidation.issues
    }
  }

  private buildPlanMessages(input: RpaPlannerInput): ModelMessage[] {
    return [
      {
        role: 'system',
        content: [
          'You are an RPA planner for Android phone automation.',
          'Return only one JSON object that matches the RpaTask schema.',
          'Do not return markdown. Do not include comments. Do not invent module ids.',
          'Every step must use one of the available modules and valid params.',
          'launch_app must verify the expected foreground_app package or use vlm_assert.',
          'tap_by_vlm_target and swipe_until_vlm_target must include verify: {"type":"vlm_assert","expectation":"observable state after this action","minConfidence":0.7,"settleMs":1200}.',
          'For visual workflows, the final step must use vlm_assert to verify the complete business goal, not merely that an action ran.',
          'Use bounded retries. A failed or uncertain visual assertion must be allowed to enter recovery or human intervention.',
          'Every task must include id, name, goal, deviceIds, steps, and metadata.',
          'deviceIds may be an empty array when no device is currently connected; devices will be assigned before execution.'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            goal: input.goal,
            taskId: input.taskId,
            taskName: input.taskName,
            deviceIds: input.deviceIds,
            observations: input.observations ?? [],
            availableModules: this.options.registry.listForPlanner()
          },
          null,
          2
        )
      }
    ]
  }

  private buildRepairMessages(
    input: RpaPlannerInput,
    invalidResponse: string,
    issues: RpaValidationIssue[]
  ): ModelMessage[] {
    return [
      {
        role: 'system',
        content: [
          'Repair the invalid RPA task JSON.',
          'Return only one corrected JSON object. Do not return markdown.',
          'Use only available module ids and valid params.',
          'Add required foreground_app and vlm_assert verification rules reported by validation.',
          'The final step of a visual workflow must verify the complete business outcome with vlm_assert.'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            originalGoal: input.goal,
            deviceIds: input.deviceIds,
            invalidResponse,
            validationIssues: issues,
            availableModules: this.options.registry.listForPlanner()
          },
          null,
          2
        )
      }
    ]
  }

  private tryParseTask(rawResponse: string): { task?: unknown; issue: RpaValidationIssue } {
    try {
      return {
        task: parseJsonFromText<unknown>(rawResponse),
        issue: { path: '$', message: '' }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('RPA model returned malformed JSON', {
        errorMessage: message,
        responseLength: rawResponse.length,
        responsePreview: rawResponse.slice(0, 500)
      })
      return {
        issue: { path: '$', message: `Invalid JSON: ${message}` }
      }
    }
  }
}
