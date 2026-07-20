import type { ModelMessage } from 'ai'
import * as z from 'zod'

import { parseJsonFromText } from './RpaJsonUtils'
import { DefaultRpaModelClient, type RpaModelClient } from './RpaModelClient'
import type { RpaModuleRegistry } from './RpaModuleRegistry'
import type {
  RpaCorrectionAction,
  RpaCorrectionDecision,
  RpaDeviceObservation,
  RpaFailureContext,
  RpaStep,
  RpaValidationIssue
} from './RpaTypes'
import { RpaStepSchema } from './RpaTypes'

export interface RpaReplanInput {
  failureContext: RpaFailureContext
  decision: RpaCorrectionDecision
  latestObservation?: RpaDeviceObservation
  correctionRound: number
  signal?: AbortSignal
}

export interface RpaReplanResult {
  status: 'actions' | 'steps' | 'human_required' | 'goal_achieved'
  steps: RpaStep[]
  actions: RpaCorrectionAction[]
  expectedOutcome?: string
  rawResponse?: string
  issues: RpaValidationIssue[]
  message: string
  confidence: number
}

export interface RpaReplanServiceOptions {
  registry: RpaModuleRegistry
  modelClient?: RpaModelClient
}

const ReplannedStepsSchema = z.object({
  steps: z.array(z.unknown()).min(1).max(3),
  expectedOutcome: z.string().min(1)
})

export class RpaReplanService {
  private readonly modelClient: RpaModelClient

  constructor(private readonly options: RpaReplanServiceOptions) {
    this.modelClient = options.modelClient ?? new DefaultRpaModelClient()
  }

  async replan(input: RpaReplanInput): Promise<RpaReplanResult> {
    const decision = input.decision
    if (decision.decision === 'human_required') {
      return {
        status: 'human_required',
        steps: [],
        actions: [],
        issues: [],
        message: decision.reason,
        confidence: decision.confidence
      }
    }

    if (decision.decision === 'goal_achieved') {
      return {
        status: 'goal_achieved',
        steps: [],
        actions: [],
        expectedOutcome: input.failureContext.task.goal,
        issues: [],
        message: decision.reason,
        confidence: decision.confidence
      }
    }

    if (decision.decision === 'execute_actions') {
      return {
        status: 'actions',
        steps: decision.actions.map((action, index) =>
          this.createTemporaryActionStep(action, input.correctionRound, index)
        ),
        actions: decision.actions,
        expectedOutcome: decision.expectedOutcome,
        issues: [],
        message: decision.reason,
        confidence: decision.confidence
      }
    }

    const rawResponse = await this.modelClient.complete({
      messages: this.buildMessages(input),
      model: input.failureContext.task.visionModel,
      signal: input.signal
    })
    const parsedPlan = ReplannedStepsSchema.safeParse(parseJsonFromText<unknown>(rawResponse))
    if (!parsedPlan.success) {
      return {
        status: 'human_required',
        steps: [],
        actions: [],
        rawResponse,
        issues: parsedPlan.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        })),
        message: 'Temporary RPA plan failed validation',
        confidence: decision.confidence
      }
    }

    const validation = this.validateSteps(parsedPlan.data.steps)
    return {
      status: validation.issues.length ? 'human_required' : 'steps',
      steps: validation.steps,
      actions: [],
      expectedOutcome: parsedPlan.data.expectedOutcome,
      rawResponse,
      issues: validation.issues,
      message: validation.issues.length ? 'Temporary RPA steps failed validation' : decision.reason,
      confidence: decision.confidence
    }
  }

  private buildMessages(input: RpaReplanInput): ModelMessage[] {
    const screenshot = input.latestObservation?.screenshot
    const screenshotContent =
      typeof screenshot === 'object' && screenshot && 'imageBase64' in screenshot && 'mime' in screenshot
        ? [
            {
              type: 'image' as const,
              image: String(screenshot.imageBase64),
              mediaType: String(screenshot.mime)
            }
          ]
        : []

    return [
      {
        role: 'system',
        content: [
          'You convert a validated VLM replan decision into temporary Android RPA steps.',
          'Return only JSON: {"steps":[RpaStep...],"expectedOutcome":"observable state after all steps"}.',
          'Return between 1 and 3 temporary steps.',
          'Use only available module ids. Do not return markdown.'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                failureContext: input.failureContext,
                decision: input.decision,
                latestObservation: input.latestObservation
                  ? {
                      ...input.latestObservation,
                      screenshot: input.latestObservation.screenshot ? '[attached image]' : undefined,
                      artifacts: undefined
                    }
                  : undefined,
                correctionRound: input.correctionRound,
                availableModules: this.options.registry.listForPlanner()
              },
              null,
              2
            )
          },
          ...screenshotContent
        ]
      }
    ]
  }

  private createTemporaryActionStep(action: RpaCorrectionAction, round: number, index: number): RpaStep {
    return {
      id: `correction-${round}-action-${index + 1}-${action.id}`,
      name: `Correction action: ${action.type}`,
      moduleId: '__correction_action__',
      params: { ...action },
      timeoutMs: action.type === 'wait' ? Math.max(1_000, action.durationMs + 1_000) : 30_000,
      retry: { maxAttempts: 1, backoffMs: 0, retryOn: ['failed', 'timeout'] },
      verify: { type: 'module_result_success' },
      continueOnFailure: false
    }
  }

  private validateSteps(stepsInput: unknown[]): { steps: RpaStep[]; issues: RpaValidationIssue[] } {
    const steps: RpaStep[] = []
    const issues: RpaValidationIssue[] = []
    const stepIds = new Set<string>()

    stepsInput.forEach((stepInput, index) => {
      const parsed = RpaStepSchema.safeParse(stepInput)
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          issues.push({ path: `steps.${index}.${issue.path.join('.')}`, message: issue.message })
        }
        return
      }

      const step = parsed.data
      if (stepIds.has(step.id)) {
        issues.push({ path: `steps.${index}.id`, message: `Duplicate correction step id: ${step.id}` })
      }
      stepIds.add(step.id)

      if (!this.options.registry.has(step.moduleId)) {
        issues.push({ path: `steps.${index}.moduleId`, message: `Unknown module: ${step.moduleId}` })
        return
      }

      const module = this.options.registry.require(step.moduleId)
      if (module.metadata.riskLevel === 'high') {
        issues.push({
          path: `steps.${index}.moduleId`,
          message: `High-risk recovery module is not allowed: ${step.moduleId}`
        })
        return
      }

      const paramsResult = this.options.registry.validateParams(step.moduleId, step.params)
      for (const issue of paramsResult.issues) {
        issues.push({ path: `steps.${index}.params`, message: issue })
      }

      steps.push(step)
    })

    return { steps: issues.length ? [] : steps, issues }
  }
}
