import type { ModelMessage } from 'ai'
import * as z from 'zod'

import { parseJsonFromText } from './RpaJsonUtils'
import { DefaultRpaModelClient, type RpaModelClient } from './RpaModelClient'
import type { RpaModuleRegistry } from './RpaModuleRegistry'
import type { RpaDeviceObservation, RpaFailureContext, RpaStep, RpaValidationIssue } from './RpaTypes'
import { RpaStepSchema } from './RpaTypes'

export interface RpaReplanInput {
  failureContext: RpaFailureContext
  latestObservation?: RpaDeviceObservation
  correctionAttempt: number
  maxCorrectionAttempts?: number
  signal?: AbortSignal
}

export interface RpaReplanResult {
  status: 'retry' | 'corrected' | 'needs_human'
  steps: RpaStep[]
  rawResponse?: string
  issues: RpaValidationIssue[]
  message: string
  confidence: number
}

export interface RpaReplanServiceOptions {
  registry: RpaModuleRegistry
  modelClient?: RpaModelClient
}

const RecoveryDecisionSchema = z.object({
  decision: z.enum(['retry', 'insert_steps', 'needs_human']),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  steps: z.array(z.unknown()).max(3).default([])
})

export class RpaReplanService {
  private readonly modelClient: RpaModelClient

  constructor(private readonly options: RpaReplanServiceOptions) {
    this.modelClient = options.modelClient ?? new DefaultRpaModelClient()
  }

  async replan(input: RpaReplanInput): Promise<RpaReplanResult> {
    const maxAttempts = input.maxCorrectionAttempts ?? 2
    if (input.correctionAttempt >= maxAttempts) {
      return {
        status: 'needs_human',
        steps: [],
        issues: [],
        message: `Correction attempts exceeded: ${input.correctionAttempt}/${maxAttempts}`,
        confidence: 1
      }
    }

    const rawResponse = await this.modelClient.complete({
      messages: this.buildMessages(input),
      model: input.failureContext.task.visionModel,
      signal: input.signal
    })
    const parsedDecision = RecoveryDecisionSchema.safeParse(parseJsonFromText<unknown>(rawResponse))
    if (!parsedDecision.success) {
      return {
        status: 'needs_human',
        steps: [],
        rawResponse,
        issues: parsedDecision.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        })),
        message: 'VLM recovery decision failed validation',
        confidence: 0
      }
    }

    const response = parsedDecision.data
    if (response.decision === 'needs_human' || response.confidence < 0.65) {
      return {
        status: 'needs_human',
        steps: [],
        rawResponse,
        issues: [],
        message:
          response.confidence < 0.65
            ? `Recovery confidence ${response.confidence} is below 0.65: ${response.reason}`
            : response.reason,
        confidence: response.confidence
      }
    }

    if (response.decision === 'retry') {
      return {
        status: 'retry',
        steps: [],
        rawResponse,
        issues: [],
        message: response.reason,
        confidence: response.confidence
      }
    }

    const validation = this.validateSteps(response.steps)
    return {
      status: validation.issues.length ? 'needs_human' : 'corrected',
      steps: validation.steps,
      rawResponse,
      issues: validation.issues,
      message: validation.issues.length ? 'Correction steps failed validation' : response.reason,
      confidence: response.confidence
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
          'You diagnose Android RPA task execution failures from the failure context and current screenshot.',
          'Choose exactly one decision: retry, insert_steps, or needs_human.',
          'Return only JSON: {"decision":"retry|insert_steps|needs_human","reason":"...","confidence":0.0,"steps":[RpaStep...]}.',
          'Use retry when the original step is likely to succeed without another action.',
          'Use insert_steps for at most 3 temporary recovery actions, then the system retries the original step.',
          'Use needs_human when the state is ambiguous, unsafe, authentication-related, or not recoverable.',
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
                latestObservation: input.latestObservation
                  ? {
                      ...input.latestObservation,
                      screenshot: input.latestObservation.screenshot ? '[attached image]' : undefined,
                      artifacts: undefined
                    }
                  : undefined,
                correctionAttempt: input.correctionAttempt,
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
