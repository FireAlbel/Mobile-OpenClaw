import type { ModelMessage } from 'ai'
import * as z from 'zod'

import { parseJsonFromText } from './RpaJsonUtils'
import { DefaultRpaModelClient, type RpaModelClient } from './RpaModelClient'
import type { RpaDeviceObservation } from './RpaTypes'

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

export class RpaVisualCorrectionService {
  private readonly modelClient: RpaModelClient

  constructor(options: RpaVisualCorrectionServiceOptions = {}) {
    this.modelClient = options.modelClient ?? new DefaultRpaModelClient()
  }

  async locate(input: RpaVisualCorrectionInput): Promise<RpaVisualCorrectionResult> {
    const rawResponse = await this.modelClient.complete({
      messages: this.buildMessages(input)
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
}
