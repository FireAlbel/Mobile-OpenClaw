import { loggerService } from '@logger'

import { deviceServiceProxy } from './DeviceServiceProxy'
import { deviceVisionActionService } from './DeviceVisionActionService'

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
        return undefined
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
        return await deviceVisionActionService.runVisionAction(deviceId, toString(params.instruction, 'instruction'))
      default:
        throw new Error(`Unsupported device action: ${(request as DeviceActionRequest).type}`)
    }
  }

  private async captureScreenshot(deviceId: string) {
    try {
      return await deviceServiceProxy.captureScrcpyWindow(deviceId)
    } catch {
      return await deviceServiceProxy.getScreenshot(deviceId)
    }
  }
}

export const deviceActionRuntime = new DeviceActionRuntime()
