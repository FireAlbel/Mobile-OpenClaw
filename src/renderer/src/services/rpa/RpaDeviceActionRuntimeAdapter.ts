import { loggerService } from '@logger'
import type { Model } from '@renderer/types'

import { type DeviceActionRequest, type DeviceActionResult, deviceActionRuntime } from '../DeviceActionRuntime'
import { deviceServiceProxy } from '../DeviceServiceProxy'
import type { RpaCorrectionAction, RpaDeviceRuntime, RpaDeviceRuntimeResult } from './RpaTypes'
import { RpaVisualCorrectionService } from './RpaVisualCorrectionService'

const logger = loggerService.withContext('RpaDeviceActionRuntimeAdapter')

export class RpaDeviceActionRuntimeAdapter implements RpaDeviceRuntime {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly visualCorrectionService = new RpaVisualCorrectionService()

  screenshot(deviceId: string): Promise<RpaDeviceRuntimeResult> {
    return this.runAction(deviceId, { type: 'screenshot', params: { requireScrcpy: true, maxAgeMs: 1_000 } })
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

  async locateVisualTarget(
    deviceId: string,
    target: string,
    model?: Model,
    signal?: AbortSignal
  ): Promise<
    RpaDeviceRuntimeResult<{
      found: boolean
      confidence: number
      reason: string
      needsHuman?: boolean
      rawResponse?: string
    }>
  > {
    const startedAt = Date.now()
    try {
      const screenshot = await this.screenshot(deviceId)
      if (!screenshot.success || !screenshot.data) {
        return this.toFailureResult(new Error(screenshot.message), startedAt)
      }
      const screenshotData = screenshot.data as { width?: number; height?: number }
      const located = await this.visualCorrectionService.locate({
        deviceId,
        target,
        model,
        signal,
        observation: {
          deviceId,
          capturedAt: Date.now(),
          screenshot: screenshot.data,
          screenSize:
            typeof screenshotData.width === 'number' && typeof screenshotData.height === 'number'
              ? { width: screenshotData.width, height: screenshotData.height }
              : undefined,
          warnings: [],
          artifacts: { screenshot: screenshot.data }
        }
      })
      if (located.status === 'invalid' || located.status === 'low_confidence') {
        return {
          success: false,
          message: located.message,
          data: {
            found: false,
            confidence: located.response?.confidence ?? 0,
            reason: located.message,
            needsHuman: true,
            rawResponse: located.rawResponse
          },
          startedAt,
          finishedAt: Date.now()
        }
      }
      return {
        success: true,
        message: located.message,
        data: {
          found: located.status === 'found',
          confidence: located.response?.confidence ?? 0,
          reason: located.message
        },
        startedAt,
        finishedAt: Date.now()
      }
    } catch (error) {
      logger.error('Failed to locate RPA visual target', { error, deviceId, target })
      return this.toFailureResult(error, startedAt)
    }
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

  async executeCorrectionAction(
    deviceId: string,
    action: RpaCorrectionAction,
    signal?: AbortSignal
  ): Promise<RpaDeviceRuntimeResult<{ transport: string; action: RpaCorrectionAction; result?: unknown }>> {
    signal?.throwIfAborted()
    const startedAt = Date.now()
    let transport = 'device_action_runtime'
    let result: RpaDeviceRuntimeResult

    switch (action.type) {
      case 'tap':
        result = await this.tap(deviceId, action.x, action.y)
        break
      case 'swipe':
        result = await this.swipe(deviceId, action.x1, action.y1, action.x2, action.y2, action.durationMs)
        break
      case 'key':
        result = await this.key(deviceId, CORRECTION_KEY_CODES[action.key])
        break
      case 'start_app':
        result = await this.startApp(deviceId, action.packageName)
        break
      case 'permission_action':
        transport = 'android_permission_service'
        result = await this.handlePermissionDialog(deviceId, action.action)
        break
      case 'wait':
        transport = 'local_timer'
        result = await this.waitForCorrection(action.durationMs, signal)
        break
    }

    signal?.throwIfAborted()
    return {
      success: result.success,
      message: result.message,
      data: { transport, action, result: result.data },
      startedAt,
      finishedAt: Date.now()
    }
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

  private waitForCorrection(durationMs: number, signal?: AbortSignal): Promise<RpaDeviceRuntimeResult> {
    const startedAt = Date.now()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve({
          success: true,
          message: `Waited ${durationMs}ms`,
          startedAt,
          finishedAt: Date.now()
        })
      }, durationMs)
      const onAbort = () => {
        clearTimeout(timeout)
        reject(signal?.reason ?? new Error('Correction wait aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

const CORRECTION_KEY_CODES: Record<Extract<RpaCorrectionAction, { type: 'key' }>['key'], number> = {
  back: 4,
  home: 3,
  enter: 66,
  recent_apps: 187
}

export const rpaDeviceRuntime = new RpaDeviceActionRuntimeAdapter()
