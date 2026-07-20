import type { Model } from '@renderer/types'
import type { ModelMessage } from 'ai'
import * as z from 'zod'

import { parseJsonFromText } from './RpaJsonUtils'
import { DefaultRpaModelClient, type RpaModelClient } from './RpaModelClient'
import {
  type RpaCorrectionDecision,
  RpaCorrectionDecisionSchema,
  type RpaDeviceObservation,
  type RpaFailureContext
} from './RpaTypes'

export const RpaVisualCorrectionResponseSchema = z.object({
  found: z.boolean(),
  action: z.enum(['tap', 'swipe', 'none']).default('none'),
  bbox: z
    .object({
      x: z.number().min(0),
      y: z.number().min(0),
      width: z.number().min(0),
      height: z.number().min(0)
    })
    .optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional()
})

export type RpaVisualCorrectionResponse = z.infer<typeof RpaVisualCorrectionResponseSchema>

export interface RpaVisualCorrectionInput {
  deviceId: string
  target: string
  observation: RpaDeviceObservation
  minConfidence?: number
  model?: Model
  signal?: AbortSignal
}

export interface RpaVisualCorrectionResult {
  status: 'found' | 'not_found' | 'low_confidence' | 'invalid'
  response?: RpaVisualCorrectionResponse
  point?: { x: number; y: number }
  rawResponse: string
  message: string
}

export interface RpaVisualCorrectionServiceOptions {
  modelClient?: RpaModelClient
}

export interface RpaCorrectionDecisionInput {
  failureContext: RpaFailureContext
  observation: RpaDeviceObservation
  correctionRound: number
  previousDecisions?: RpaCorrectionDecision[]
  minConfidence?: number
  signal?: AbortSignal
}

export interface RpaCorrectionDecisionResult {
  status: 'valid' | 'invalid' | 'low_confidence'
  decision?: RpaCorrectionDecision
  rawResponse: string
  message: string
  issues: string[]
}

export class RpaVisualCorrectionService {
  private readonly modelClient: RpaModelClient

  constructor(options: RpaVisualCorrectionServiceOptions = {}) {
    this.modelClient = options.modelClient ?? new DefaultRpaModelClient()
  }

  async decideRecovery(input: RpaCorrectionDecisionInput): Promise<RpaCorrectionDecisionResult> {
    const rawResponse = await this.modelClient.complete({
      messages: this.buildRecoveryMessages(input),
      model: input.failureContext.task.visionModel,
      signal: input.signal
    })

    let parsedJson: unknown
    try {
      parsedJson = parseJsonFromText<unknown>(rawResponse)
    } catch (error) {
      return {
        status: 'invalid',
        rawResponse,
        message: 'VLM correction response is not valid JSON',
        issues: [error instanceof Error ? error.message : String(error)]
      }
    }

    const parsed = RpaCorrectionDecisionSchema.safeParse(parsedJson)
    if (!parsed.success) {
      return {
        status: 'invalid',
        rawResponse,
        message: 'VLM correction response contains no executable decision',
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      }
    }

    const minConfidence = input.minConfidence ?? 0.65
    if (parsed.data.confidence < minConfidence) {
      return {
        status: 'low_confidence',
        decision: parsed.data,
        rawResponse,
        message: `VLM correction confidence ${parsed.data.confidence} is below ${minConfidence}`,
        issues: []
      }
    }

    return {
      status: 'valid',
      decision: parsed.data,
      rawResponse,
      message: parsed.data.reason,
      issues: []
    }
  }

  async locate(input: RpaVisualCorrectionInput): Promise<RpaVisualCorrectionResult> {
    const rawResponse = await this.modelClient.complete({
      messages: this.buildMessages(input),
      model: input.model,
      signal: input.signal
    })
    const parsed = RpaVisualCorrectionResponseSchema.safeParse(parseJsonFromText<unknown>(rawResponse))

    if (!parsed.success) {
      return {
        status: 'invalid',
        rawResponse,
        message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      }
    }

    const response = parsed.data
    if (!response.found || !response.bbox) {
      return {
        status: 'not_found',
        response,
        rawResponse,
        message: response.reason || 'Target not found'
      }
    }

    const minConfidence = input.minConfidence ?? 0.7
    if (response.confidence < minConfidence) {
      return {
        status: 'low_confidence',
        response,
        rawResponse,
        message: `Visual target confidence ${response.confidence} is below ${minConfidence}`
      }
    }

    return {
      status: 'found',
      response,
      point: {
        x: Math.round(response.bbox.x + response.bbox.width / 2),
        y: Math.round(response.bbox.y + response.bbox.height / 2)
      },
      rawResponse,
      message: response.reason || `Visual target found: ${input.target}`
    }
  }

  private buildMessages(input: RpaVisualCorrectionInput): ModelMessage[] {
    const screenshot = input.observation.screenshot
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
          'You locate visual targets on Android screenshots for an RPA system.',
          'Return only JSON. Do not execute actions.',
          'Schema: {"found":boolean,"action":"tap|swipe|none","bbox":{"x":number,"y":number,"width":number,"height":number},"confidence":number,"reason":"short reason"}.',
          'Coordinates must be screenshot pixel coordinates.'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                deviceId: input.deviceId,
                target: input.target,
                observation: {
                  capturedAt: input.observation.capturedAt,
                  screenSize: input.observation.screenSize,
                  foregroundApp: input.observation.foregroundApp,
                  warnings: input.observation.warnings
                }
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

  private buildRecoveryMessages(input: RpaCorrectionDecisionInput): ModelMessage[] {
    const screenshot = input.observation.screenshot
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
          'You are the visual recovery controller for Android RPA execution.',
          'Return exactly one JSON decision. Descriptive text without a decision is invalid.',
          'Allowed decisions are execute_actions, replan, human_required, and goal_achieved.',
          'execute_actions schema: {"decision":"execute_actions","reason":"audit reason","confidence":0.0,"expectedOutcome":"observable state after actions","actions":[whitelisted actions]}.',
          'replan schema: {"decision":"replan","reason":"audit reason","confidence":0.0,"objective":"temporary workflow objective"}.',
          'human_required schema: {"decision":"human_required","reason":"audit reason","confidence":0.0,"interventionCode":"short_code"}.',
          'goal_achieved schema: {"decision":"goal_achieved","reason":"audit reason","confidence":0.0,"evidence":"specific visual evidence"}.',
          'Whitelisted actions: tap{id,x,y}, swipe{id,x1,y1,x2,y2,durationMs}, key{id,key:back|home|enter|recent_apps}, start_app{id,packageName}, wait{id,durationMs}, permission_action{id,action:allow|deny|allow_once}.',
          'Never return shell commands, ADB command strings, scripts, comments, markdown, or an action outside the whitelist.',
          'Use execute_actions when the next physical interaction is clear.',
          'Use replan only when multiple registered RPA modules are needed.',
          'Use goal_achieved only when the screenshot already proves the failed step goal.',
          'Use human_required for authentication, CAPTCHA, unsafe, ambiguous, or unsupported states.',
          'Coordinates must use screenshot pixels. The system will execute and independently verify the result.'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                taskGoal: input.failureContext.task.goal,
                failedStep: input.failureContext.failedStep,
                failureReason: input.failureContext.reason,
                verification: input.failureContext.verification,
                correctionRound: input.correctionRound,
                previousDecisions: input.previousDecisions ?? [],
                observation: {
                  capturedAt: input.observation.capturedAt,
                  foregroundApp: input.observation.foregroundApp,
                  screenSize: input.observation.screenSize,
                  warnings: input.observation.warnings
                }
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
}
