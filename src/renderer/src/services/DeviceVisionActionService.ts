import { isVisionModel } from '@renderer/config/models'
import { fetchChatCompletion } from '@renderer/services/ApiService'
import { getDefaultAssistant, getDefaultModel } from '@renderer/services/AssistantService'
import type { Assistant, Model } from '@renderer/types'
import { type Chunk, ChunkType } from '@renderer/types/chunk'
import type { ModelMessage } from 'ai'

import { createAiCompletionError } from './AiCompletionError'
import { type DeviceScreenshot, deviceServiceProxy } from './DeviceServiceProxy'
import { parseFirstJsonValue } from './JsonExtraction'
import { scrcpyFrameService } from './ScrcpyFrameService'

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
  capture: Omit<DeviceScreenshot, 'imageBase64'>
  action: VisionAction
  deviceAction: VisionAction
  rawResponse: string
  repairResponse?: string
  takeoverResponse?: string
}

export interface VisionInterventionData {
  needsHuman: true
  code: 'vision_output_invalid'
  message: string
  rawResponse: string
  repairResponse?: string
  takeoverResponse?: string
  screenshot: DeviceScreenshot
}

export class VisionActionNeedsHumanError extends Error {
  constructor(readonly intervention: VisionInterventionData) {
    super(intervention.message)
    this.name = 'VisionActionNeedsHumanError'
  }
}

function asFiniteNumber(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(numeric) ? numeric : null
}

export function parseVisionAction(rawResponse: string, allowedActions: VisionActionKind[]): VisionAction {
  const parsed = parseFirstJsonValue<Record<string, unknown>>(rawResponse)
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
  capture: Pick<DeviceScreenshot, 'width' | 'height'>,
  screen: Pick<DeviceScreenshot, 'width' | 'height'>
) {
  return {
    x: clamp((point.x / capture.width) * screen.width, 0, screen.width - 1),
    y: clamp((point.y / capture.height) * screen.height, 0, screen.height - 1)
  }
}

function mapActionToDevice(
  action: VisionAction,
  capture: Pick<DeviceScreenshot, 'width' | 'height'>,
  screen: Pick<DeviceScreenshot, 'width' | 'height'>
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

async function executeDeviceAction(deviceId: string, action: VisionAction): Promise<void> {
  if (action.action === 'tap') {
    await deviceServiceProxy.sendTap(deviceId, action.x, action.y)
    return
  }

  await deviceServiceProxy.sendSwipe(deviceId, action.x1, action.y1, action.x2, action.y2, action.duration ?? 500)
}

async function captureVisionScreen(deviceId: string): Promise<DeviceScreenshot> {
  return await scrcpyFrameService.getLatestFrame(deviceId, { maxAgeMs: 1_000 })
}

async function requestModelText(
  messages: ModelMessage[],
  assistant: Assistant,
  model: Model,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  let response = ''
  let streamError: unknown
  try {
    await fetchChatCompletion({
      messages,
      assistant,
      requestOptions: { signal },
      onChunkReceived: (chunk: Chunk) => {
        if (chunk.type === ChunkType.TEXT_DELTA || chunk.type === ChunkType.TEXT_COMPLETE) {
          response += chunk.text
        } else if (chunk.type === ChunkType.ERROR) {
          streamError ??= chunk.error
        }
      },
      uiMessages: [],
      allowedTools: []
    })
  } catch (error) {
    throw createAiCompletionError(`VLM request (${model.name || model.id})`, streamError, error)
  }

  if (streamError) {
    throw createAiCompletionError(`VLM request (${model.name || model.id})`, streamError)
  }
  if (!response.trim()) {
    throw createAiCompletionError(`VLM request (${model.name || model.id})`, undefined)
  }
  return response
}

function createRepairMessages(rawResponse: string, error: unknown, allowedActions: VisionActionKind[]): ModelMessage[] {
  return [
    {
      role: 'system',
      content: [
        'Repair an Android vision action response.',
        'Return exactly one JSON object and no other text.',
        'Do not change the intended target or invent a different action.'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `Allowed actions: ${allowedActions.join(', ')}`,
        `Validation error: ${error instanceof Error ? error.message : String(error)}`,
        'Tap schema: {"action":"tap","x":number,"y":number,"reason":"short reason"}',
        'Swipe schema: {"action":"swipe","x1":number,"y1":number,"x2":number,"y2":number,"duration":number,"reason":"short reason"}',
        `Invalid response:\n${rawResponse}`
      ].join('\n')
    }
  ]
}

function createVisionMessages(capture: DeviceScreenshot, instruction: string, takeoverReason?: string): ModelMessage[] {
  const systemPrompt = [
    'You control one Android phone by looking at a fresh scrcpy video frame of its current screen.',
    'Return exactly one JSON object and no other text.',
    'Use screenshot pixel coordinates, with origin at the top-left of the screenshot.',
    'Allowed actions are tap and swipe.',
    takeoverReason ? `This is a correction attempt because: ${takeoverReason}` : undefined
  ]
    .filter(Boolean)
    .join('\n')
  const userPrompt = [
    `Instruction: ${instruction}`,
    `Screenshot size: ${capture.width}x${capture.height}`,
    'Return schema for tap: {"action":"tap","x":number,"y":number,"reason":"short reason"}',
    'Return schema for swipe: {"action":"swipe","x1":number,"y1":number,"x2":number,"y2":number,"duration":number,"reason":"short reason"}'
  ].join('\n')

  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: userPrompt },
        { type: 'image', image: capture.imageBase64, mediaType: capture.mime }
      ]
    }
  ]
}

export class DeviceVisionActionService {
  async runVisionAction(
    deviceId: string,
    instruction: string,
    allowedActions: VisionActionKind[] = ['tap', 'swipe'],
    selectedModel?: Model,
    signal?: AbortSignal
  ): Promise<DeviceVisionActionResult> {
    signal?.throwIfAborted()
    const capture = await captureVisionScreen(deviceId)
    if (capture.width <= 0 || capture.height <= 0) {
      throw new Error('Captured Android screen has invalid size')
    }

    const model = selectedModel ?? getDefaultModel()
    if (!model) {
      throw new Error('No vision model is configured. Select a vision-capable model in the RPA runner.')
    }
    if (!isVisionModel(model)) {
      throw new Error(
        `Model ${model.name || model.id} does not support image input. Select a vision-capable model in the RPA runner.`
      )
    }
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

    const messages = createVisionMessages(capture, instruction)

    const rawResponse = await requestModelText(messages, assistant, model, signal)
    let action: VisionAction
    let repairResponse: string | undefined
    let takeoverResponse: string | undefined
    let actionCapture = capture
    try {
      action = parseVisionAction(rawResponse, allowedActions)
    } catch (initialError) {
      try {
        repairResponse = await requestModelText(
          createRepairMessages(rawResponse, initialError, allowedActions),
          assistant,
          model,
          signal
        )
        action = parseVisionAction(repairResponse, allowedActions)
      } catch (repairError) {
        signal?.throwIfAborted()
        try {
          actionCapture = await captureVisionScreen(deviceId)
          signal?.throwIfAborted()
          takeoverResponse = await requestModelText(
            createVisionMessages(
              actionCapture,
              instruction,
              repairError instanceof Error ? repairError.message : String(repairError)
            ),
            assistant,
            model,
            signal
          )
          action = parseVisionAction(takeoverResponse, allowedActions)
        } catch (takeoverError) {
          throw new VisionActionNeedsHumanError({
            needsHuman: true,
            code: 'vision_output_invalid',
            message: `VLM takeover could not determine a valid action: ${takeoverError instanceof Error ? takeoverError.message : String(takeoverError)}`,
            rawResponse,
            repairResponse,
            takeoverResponse,
            screenshot: actionCapture
          })
        }
      }
    }
    signal?.throwIfAborted()
    const deviceAction = mapActionToDevice(action, actionCapture, actionCapture)
    await executeDeviceAction(deviceId, deviceAction)

    return {
      deviceId,
      capture: {
        deviceId: capture.deviceId,
        source: capture.source,
        width: capture.width,
        height: capture.height,
        mime: capture.mime
      },
      action,
      deviceAction,
      rawResponse,
      repairResponse,
      takeoverResponse
    }
  }
}

export const deviceVisionActionService = new DeviceVisionActionService()
