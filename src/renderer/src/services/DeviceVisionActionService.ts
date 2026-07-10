import { loggerService } from '@logger'
import { fetchChatCompletion } from '@renderer/services/ApiService'
import { getDefaultAssistant, getDefaultModel } from '@renderer/services/AssistantService'
import { type Chunk, ChunkType } from '@renderer/types/chunk'
import type { ModelMessage } from 'ai'

import { deviceServiceProxy, type ScrcpyWindowCapture } from './DeviceServiceProxy'

const logger = loggerService.withContext('DeviceVisionActionService')

type VisionActionKind = 'tap' | 'swipe'

export interface VisionTapAction {
  action: 'tap'
  x: number
  y: number
  reason?: string
}

export interface VisionSwipeAction {
  action: 'swipe'
  x1: number
  y1: number
  x2: number
  y2: number
  duration?: number
  reason?: string
}

export type VisionAction = VisionTapAction | VisionSwipeAction

export interface DeviceVisionActionResult {
  deviceId: string
  capture: Omit<ScrcpyWindowCapture, 'imageBase64'>
  action: VisionAction
  deviceAction: VisionAction
  rawResponse: string
}

interface DeviceScreenSize {
  width: number
  height: number
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1)
  }

  return text.trim()
}

function asFiniteNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(numeric) ? numeric : null
}

function parseVisionAction(rawResponse: string, allowedActions: VisionActionKind[]): VisionAction {
  const parsed = JSON.parse(extractJsonObject(rawResponse)) as Record<string, unknown>
  const action = parsed.action

  if (action !== 'tap' && action !== 'swipe') {
    throw new Error('VLM response does not contain a supported action')
  }

  if (!allowedActions.includes(action)) {
    throw new Error(`VLM returned disallowed action: ${action}`)
  }

  if (action === 'tap') {
    const x = asFiniteNumber(parsed.x)
    const y = asFiniteNumber(parsed.y)
    if (x === null || y === null) {
      throw new Error('VLM tap response must include numeric x and y')
    }
    return {
      action,
      x,
      y,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined
    }
  }

  const x1 = asFiniteNumber(parsed.x1)
  const y1 = asFiniteNumber(parsed.y1)
  const x2 = asFiniteNumber(parsed.x2)
  const y2 = asFiniteNumber(parsed.y2)
  const duration = asFiniteNumber(parsed.duration)

  if (x1 === null || y1 === null || x2 === null || y2 === null) {
    throw new Error('VLM swipe response must include numeric x1, y1, x2 and y2')
  }

  return {
    action,
    x1,
    y1,
    x2,
    y2,
    duration: duration ?? 500,
    reason: typeof parsed.reason === 'string' ? parsed.reason : undefined
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max)
}

function mapPointToDevice(
  point: { x: number; y: number },
  capture: Pick<ScrcpyWindowCapture, 'width' | 'height'>,
  screen: DeviceScreenSize
) {
  return {
    x: clamp((point.x / capture.width) * screen.width, 0, screen.width - 1),
    y: clamp((point.y / capture.height) * screen.height, 0, screen.height - 1)
  }
}

function mapActionToDevice(
  action: VisionAction,
  capture: Pick<ScrcpyWindowCapture, 'width' | 'height'>,
  screen: DeviceScreenSize
): VisionAction {
  if (action.action === 'tap') {
    const point = mapPointToDevice(action, capture, screen)
    return {
      ...action,
      ...point
    }
  }

  const start = mapPointToDevice({ x: action.x1, y: action.y1 }, capture, screen)
  const end = mapPointToDevice({ x: action.x2, y: action.y2 }, capture, screen)
  return {
    ...action,
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    duration: clamp(action.duration ?? 500, 50, 5000)
  }
}

async function getDeviceScreenSize(deviceId: string, fallback: Pick<ScrcpyWindowCapture, 'width' | 'height'>) {
  try {
    const output = await deviceServiceProxy.executeAdbCommand(deviceId, 'shell wm size')
    const matches = output.match(/(\d+)\s*x\s*(\d+)/i)
    if (matches) {
      return {
        width: Number(matches[1]),
        height: Number(matches[2])
      }
    }
  } catch (error) {
    logger.warn('Failed to read device screen size, using capture size fallback', { error, deviceId })
  }

  return {
    width: fallback.width,
    height: fallback.height
  }
}

async function executeDeviceAction(deviceId: string, action: VisionAction): Promise<void> {
  if (action.action === 'tap') {
    await deviceServiceProxy.sendTap(deviceId, action.x, action.y)
    return
  }

  await deviceServiceProxy.sendSwipe(deviceId, action.x1, action.y1, action.x2, action.y2, action.duration ?? 500)
}

class DeviceVisionActionService {
  async runVisionAction(
    deviceId: string,
    instruction: string,
    allowedActions: VisionActionKind[] = ['tap', 'swipe']
  ): Promise<DeviceVisionActionResult> {
    const capture = await deviceServiceProxy.captureScrcpyWindow(deviceId)
    if (capture.width <= 0 || capture.height <= 0) {
      throw new Error('Captured scrcpy window has invalid size')
    }

    const model = getDefaultModel()
    const defaultAssistant = getDefaultAssistant()
    const assistant = {
      ...defaultAssistant,
      model,
      settings: {
        ...defaultAssistant.settings,
        streamOutput: false,
        reasoning_effort: undefined,
        qwenThinkMode: false
      }
    }

    const systemPrompt =
      'You control one Android phone by looking at a scrcpy window screenshot. Return only one JSON object. Use screenshot pixel coordinates, with origin at the top-left of the screenshot. Allowed actions are tap and swipe. Do not include markdown.'
    const userPrompt = [
      `Instruction: ${instruction}`,
      `Screenshot size: ${capture.width}x${capture.height}`,
      'Return schema for tap: {"action":"tap","x":number,"y":number,"reason":"short reason"}',
      'Return schema for swipe: {"action":"swipe","x1":number,"y1":number,"x2":number,"y2":number,"duration":number,"reason":"short reason"}'
    ].join('\n')

    const messages: ModelMessage[] = [
      {
        role: 'system',
        content: systemPrompt
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image', image: capture.imageBase64, mediaType: capture.mime }
        ]
      }
    ]

    let rawResponse = ''
    await fetchChatCompletion({
      messages,
      assistant,
      requestOptions: {},
      onChunkReceived: (chunk: Chunk) => {
        if (chunk.type === ChunkType.TEXT_DELTA || chunk.type === ChunkType.TEXT_COMPLETE) {
          rawResponse += chunk.text
        }
      },
      uiMessages: [],
      allowedTools: []
    })

    if (!rawResponse.trim()) {
      throw new Error('VLM returned an empty response')
    }

    const action = parseVisionAction(rawResponse, allowedActions)
    const screen = await getDeviceScreenSize(deviceId, capture)
    const deviceAction = mapActionToDevice(action, capture, screen)
    await executeDeviceAction(deviceId, deviceAction)

    return {
      deviceId,
      capture: {
        deviceId: capture.deviceId,
        hwnd: capture.hwnd,
        title: capture.title,
        width: capture.width,
        height: capture.height,
        x: capture.x,
        y: capture.y,
        mime: capture.mime
      },
      action,
      deviceAction,
      rawResponse
    }
  }
}

export const deviceVisionActionService = new DeviceVisionActionService()
