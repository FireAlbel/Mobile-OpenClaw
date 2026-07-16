import { loggerService } from '@logger'
import type { Model } from '@renderer/types'

import { deviceServiceProxy } from './DeviceServiceProxy'
import { deviceVisionActionService, VisionActionNeedsHumanError } from './DeviceVisionActionService'
import { scrcpyFrameService } from './ScrcpyFrameService'

const logger = loggerService.withContext('DeviceActionRuntime')

export type DeviceActionType =
  | 'screenshot'
  | 'tap'
  | 'swipe'
  | 'double_tap'
  | 'long_press'
  | 'drag'
  | 'input_text'
  | 'key'
  | 'start_app'
  | 'stop_app'
  | 'restart_app'
  | 'permission'
  | 'vision_instruction'

export interface DeviceActionRequest {
  type: DeviceActionType
  params?: Record<string, unknown>
}

export interface DeviceActionResult {
  type: DeviceActionType
  success: boolean
  message: string
  data?: unknown
  startedAt: number
  finishedAt: number
}

function toNumber(value: unknown, fallback?: number): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (Number.isFinite(numeric)) return numeric
  if (fallback !== undefined) return fallback
  throw new Error(`Expected numeric action parameter, got ${String(value)}`)
}

function toString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw new Error(`Expected non-empty string action parameter: ${name}`)
}

function toPermissionAction(value: unknown): 'allow' | 'deny' | 'allow_once' {
  if (value === 'allow' || value === 'deny' || value === 'allow_once') return value
  return 'allow'
}

function toVisionAllowedActions(value: unknown): Array<'tap' | 'swipe'> {
  if (!Array.isArray(value)) return ['tap', 'swipe']
  const actions = value.filter((item): item is 'tap' | 'swipe' => item === 'tap' || item === 'swipe')
  return actions.length ? actions : ['tap', 'swipe']
}

function toVisionModel(value: unknown): Model | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object') throw new Error('Invalid vision model configuration')
  const model = value as Partial<Model>
  if (!model.id || !model.provider || !model.name || !model.group) {
    throw new Error('Vision model must include id, provider, name and group')
  }
  return value as Model
}

function toAbortSignal(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined
  if (value instanceof AbortSignal) return value
  throw new Error('Invalid abort signal')
}

function assertPackageName(packageName: string): void {
  if (!/^[a-zA-Z0-9_.]+$/.test(packageName)) {
    throw new Error(`Invalid Android package name: ${packageName}`)
  }
}

export class DeviceActionRuntime {
  async execute(deviceId: string, request: DeviceActionRequest): Promise<DeviceActionResult> {
    const startedAt = Date.now()
    try {
      const data = await this.executeUnsafe(deviceId, request)
      const finishedAt = Date.now()
      return {
        type: request.type,
        success: true,
        message: `Action ${request.type} completed`,
        data,
        startedAt,
        finishedAt
      }
    } catch (error) {
      logger.error('Device action failed', { error, deviceId, request })
      const finishedAt = Date.now()
      return {
        type: request.type,
        success: false,
        message: error instanceof Error ? error.message : String(error),
        data: error instanceof VisionActionNeedsHumanError ? error.intervention : undefined,
        startedAt,
        finishedAt
      }
    }
  }

  private async executeUnsafe(deviceId: string, request: DeviceActionRequest): Promise<unknown> {
    const params = request.params ?? {}

    switch (request.type) {
      case 'screenshot':
        return await this.captureScreenshot(deviceId)
      case 'tap':
        await deviceServiceProxy.sendTap(deviceId, toNumber(params.x), toNumber(params.y))
        return undefined
      case 'swipe':
        await deviceServiceProxy.sendSwipe(
          deviceId,
          toNumber(params.x1),
          toNumber(params.y1),
          toNumber(params.x2),
          toNumber(params.y2),
          toNumber(params.duration, 500)
        )
        return undefined
      case 'double_tap':
        await deviceServiceProxy.sendDoubleTap(
          deviceId,
          toNumber(params.x),
          toNumber(params.y),
          toNumber(params.interval, 120)
        )
        return undefined
      case 'long_press':
        await deviceServiceProxy.sendLongPress(
          deviceId,
          toNumber(params.x),
          toNumber(params.y),
          toNumber(params.duration, 800)
        )
        return undefined
      case 'drag':
        await deviceServiceProxy.sendDrag(
          deviceId,
          toNumber(params.x1),
          toNumber(params.y1),
          toNumber(params.x2),
          toNumber(params.y2),
          toNumber(params.duration, 700)
        )
        return undefined
      case 'input_text':
        await deviceServiceProxy.sendText(deviceId, toString(params.text, 'text'))
        return undefined
      case 'key':
        await deviceServiceProxy.sendKeyEvent(deviceId, toNumber(params.keyCode))
        return undefined
      case 'start_app': {
        const packageName = toString(params.packageName, 'packageName')
        assertPackageName(packageName)
        await deviceServiceProxy.startApp(deviceId, packageName)
        return { packageName }
      }
      case 'stop_app': {
        const packageName = toString(params.packageName, 'packageName')
        assertPackageName(packageName)
        await deviceServiceProxy.stopApp(deviceId, packageName)
        return undefined
      }
      case 'restart_app': {
        const packageName = toString(params.packageName, 'packageName')
        assertPackageName(packageName)
        await deviceServiceProxy.restartApp(deviceId, packageName)
        return undefined
      }
      case 'permission':
        return await deviceServiceProxy.handlePermissionDialog(deviceId, toPermissionAction(params.action))
      case 'vision_instruction':
        return await deviceVisionActionService.runVisionAction(
          deviceId,
          toString(params.instruction, 'instruction'),
          toVisionAllowedActions(params.allowedActions),
          toVisionModel(params.model),
          toAbortSignal(params.signal)
        )
      default:
        throw new Error(`Unsupported device action: ${(request as DeviceActionRequest).type}`)
    }
  }

  private async captureScreenshot(deviceId: string) {
    try {
      return await scrcpyFrameService.getLatestFrame(deviceId)
    } catch (error) {
      logger.warn('Scrcpy frame capture failed, falling back to ADB screenshot', { error, deviceId })
      return await deviceServiceProxy.getScreenshot(deviceId)
    }
  }
}

export const deviceActionRuntime = new DeviceActionRuntime()
