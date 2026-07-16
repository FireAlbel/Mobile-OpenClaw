import type { ModelMessage } from 'ai'

import { parseJsonFromText } from './RpaJsonUtils'
import { DefaultRpaModelClient, type RpaModelClient } from './RpaModelClient'
import type { RpaModuleRegistry } from './RpaModuleRegistry'
import { RpaTaskValidator } from './RpaTaskValidator'
import type { RpaDeviceObservation, RpaTask, RpaValidationIssue } from './RpaTypes'

export interface RpaPlannerInput {
  goal: string
  deviceIds: string[]
  observations?: RpaDeviceObservation[]
  taskId?: string
  taskName?: string
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
    this.validator = new RpaTaskValidator(options.registry)
  }

  async plan(input: RpaPlannerInput): Promise<RpaPlannerResult> {
    const rawResponse = await this.modelClient.complete({
      messages: this.buildPlanMessages(input)
    })
    const parsed = this.parseTask(rawResponse)
    const validation = this.validator.validate(parsed)
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
      messages: this.buildRepairMessages(input, rawResponse, validation.issues)
    })
    const repairedTask = this.parseTask(repairResponse)
    const repairedValidation = this.validator.validate(repairedTask)

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
          'Every task must include id, name, goal, deviceIds, steps, and metadata.'
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
          'Use only available module ids and valid params.'
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

  private parseTask(rawResponse: string): unknown {
    return parseJsonFromText<unknown>(rawResponse)
  }
}
