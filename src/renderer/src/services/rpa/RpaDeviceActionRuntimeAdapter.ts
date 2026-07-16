import { loggerService } from '@logger'
import type { Model } from '@renderer/types'

import { type DeviceActionRequest, type DeviceActionResult, deviceActionRuntime } from '../DeviceActionRuntime'
import { deviceServiceProxy } from '../DeviceServiceProxy'
import type { RpaDeviceRuntime, RpaDeviceRuntimeResult } from './RpaTypes'

const logger = loggerService.withContext('RpaDeviceActionRuntimeAdapter')

export class RpaDeviceActionRuntimeAdapter implements RpaDeviceRuntime {
  private readonly locks = new Map<string, Promise<unknown>>()

  screenshot(deviceId: string): Promise<RpaDeviceRuntimeResult> {
    return this.runAction(deviceId, { type: 'screenshot' })
  }

  tap(deviceId: string, x: number, y: number): Promise<RpaDeviceRuntimeResult> {
    return this.runAction(deviceId, { type: 'tap', params: { x, y } })
  }

  swipe(
    deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number = 500
  ): Promise<RpaDeviceRuntimeResult> {
    return this.runAction(deviceId, { type: 'swipe', params: { x1, y1, x2, y2, duration } })
  }

  key(deviceId: string, keyCode: number): Promise<RpaDeviceRuntimeResult> {
    return this.runAction(deviceId, { type: 'key', params: { keyCode } })
  }

  startApp(deviceId: string, packageName: string): Promise<RpaDeviceRuntimeResult> {
    return this.runAction(deviceId, { type: 'start_app', params: { packageName } })
  }

  handlePermissionDialog(
    deviceId: string,
    action: 'allow' | 'deny' | 'allow_once'
  ): Promise<RpaDeviceRuntimeResult<boolean>> {
    return this.withDeviceLock(deviceId, async () => {
      const startedAt = Date.now()
      try {
        const data = await deviceServiceProxy.handlePermissionDialog(deviceId, action)
        return {
          success: true,
          message: data ? `Permission dialog handled: ${action}` : 'No matching permission dialog found',
          data,
          startedAt,
          finishedAt: Date.now()
        }
      } catch (error) {
        logger.error('Failed to handle permission dialog', { error, deviceId, action })
        return this.toFailureResult<boolean>(error, startedAt)
      }
    })
  }

  visionInstruction(
    deviceId: string,
    instruction: string,
    allowedActions: Array<'tap' | 'swipe'> = ['tap', 'swipe'],
    model?: Model,
    signal?: AbortSignal
  ): Promise<RpaDeviceRuntimeResult> {
    return this.runAction(deviceId, {
      type: 'vision_instruction',
      params: { instruction, allowedActions, model, signal }
    })
  }

  async getForegroundApp(deviceId: string): Promise<RpaDeviceRuntimeResult> {
    return this.withDeviceLock(deviceId, async () => {
      const startedAt = Date.now()
      try {
        const data = await deviceServiceProxy.getForegroundApp(deviceId)
        return {
          success: true,
          message: 'Foreground app resolved',
          data,
          startedAt,
          finishedAt: Date.now()
        }
      } catch (error) {
        logger.error('Failed to get foreground app', { error, deviceId })
        return this.toFailureResult(error, startedAt)
      }
    })
  }

  async getScreenSize(deviceId: string): Promise<RpaDeviceRuntimeResult<{ width: number; height: number }>> {
    return this.withDeviceLock(deviceId, async () => {
      const startedAt = Date.now()
      try {
        const data = await deviceServiceProxy.getScreenSize(deviceId)
        return {
          success: true,
          message: 'Screen size resolved',
          data,
          startedAt,
          finishedAt: Date.now()
        }
      } catch (error) {
        logger.error('Failed to get screen size', { error, deviceId })
        return this.toFailureResult(error, startedAt)
      }
    })
  }

  private async runAction(deviceId: string, action: DeviceActionRequest): Promise<RpaDeviceRuntimeResult> {
    return this.withDeviceLock(deviceId, async () =>
      this.fromDeviceActionResult(await deviceActionRuntime.execute(deviceId, action))
    )
  }

  private async withDeviceLock<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(deviceId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.locks.set(deviceId, current)
    try {
      return await current
    } finally {
      if (this.locks.get(deviceId) === current) {
        this.locks.delete(deviceId)
      }
    }
  }

  private fromDeviceActionResult(result: DeviceActionResult): RpaDeviceRuntimeResult {
    return {
      success: result.success,
      message: result.message,
      data: result.data,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt
    }
  }

  private toFailureResult<TData = unknown>(error: unknown, startedAt: number): RpaDeviceRuntimeResult<TData> {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt: Date.now()
    }
  }
}

export const rpaDeviceRuntime = new RpaDeviceActionRuntimeAdapter()
