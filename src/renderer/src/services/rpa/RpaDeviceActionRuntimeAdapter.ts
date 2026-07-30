import { loggerService } from '@logger'
import type { Model } from '@renderer/types'

import { type DeviceActionRequest, type DeviceActionResult, deviceActionRuntime } from '../DeviceActionRuntime'
import { deviceServiceProxy } from '../DeviceServiceProxy'
import { rpaHumanizedInputPolicy } from './RpaHumanizedInputPolicy'
import type {
  RpaCorrectionAction,
  RpaDeviceRuntime,
  RpaDeviceRuntimeResult,
  RpaHumanizedInputOptions,
  RpaHumanizedSwipeTrace,
  RpaHumanizedTapTrace
} from './RpaTypes'
import { RpaVisualCorrectionService } from './RpaVisualCorrectionService'

const logger = loggerService.withContext('RpaDeviceActionRuntimeAdapter')
const SWIPE_SETTLE_MS = 300

interface ScreenFingerprint {
  screenshot?: string
  uiTree?: string
}

export class RpaDeviceActionRuntimeAdapter implements RpaDeviceRuntime {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly visualCorrectionService = new RpaVisualCorrectionService()

  screenshot(deviceId: string): Promise<RpaDeviceRuntimeResult> {
    return this.runAction(deviceId, { type: 'screenshot', params: { requireScrcpy: false, maxAgeMs: 1_000 } })
  }

  tap(
    deviceId: string,
    x: number,
    y: number,
    options: RpaHumanizedInputOptions = {}
  ): Promise<RpaDeviceRuntimeResult<RpaHumanizedTapTrace | unknown>> {
    return this.withDeviceLock(deviceId, async () => {
      const trace = rpaHumanizedInputPolicy.createTap(deviceId, { x, y }, options)
      await delay(trace.delayBeforeMs)
      const result = this.fromDeviceActionResult(
        await deviceActionRuntime.execute(deviceId, { type: 'tap', params: { x: trace.actual.x, y: trace.actual.y } })
      )
      return { ...result, data: { result: result.data, humanization: trace } }
    })
  }

  swipe(
    deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration: number = 500,
    options: RpaHumanizedInputOptions = {}
  ): Promise<RpaDeviceRuntimeResult<RpaHumanizedSwipeTrace | unknown>> {
    return this.withDeviceLock(deviceId, async () => {
      const startedAt = Date.now()
      const trace = rpaHumanizedInputPolicy.createSwipe(deviceId, { x: x1, y: y1 }, { x: x2, y: y2 }, duration, options)
      await delay(trace.delayBeforeMs)
      const beforeFingerprint = await this.captureScreenFingerprint(deviceId)
      try {
        await deviceServiceProxy.executeAdbCommand(deviceId, buildBezierMotionEventCommand(trace))
        await delay(SWIPE_SETTLE_MS)
        const afterFingerprint = await this.captureScreenFingerprint(deviceId)
        if (screenChanged(beforeFingerprint, afterFingerprint)) {
          return {
            success: true,
            message: 'Humanized Bezier swipe completed and changed the screen',
            data: { transport: 'adb_motionevent_bezier', humanization: trace, screenChanged: true },
            startedAt,
            finishedAt: Date.now()
          }
        }
        logger.warn('Bezier motion events did not produce an observable screen change; falling back to ADB swipe', {
          deviceId
        })
      } catch (error) {
        logger.warn('Bezier motion events unavailable, falling back to ADB swipe', { error, deviceId })
      }

      const result = this.fromDeviceActionResult(
        await deviceActionRuntime.execute(deviceId, {
          type: 'swipe',
          params: { x1, y1, x2, y2, duration: trace.durationMs }
        })
      )
      if (!result.success) {
        return { ...result, data: { result: result.data, transport: 'adb_swipe_fallback', humanization: trace } }
      }

      await delay(SWIPE_SETTLE_MS)
      const fallbackFingerprint = await this.captureScreenFingerprint(deviceId)
      const changed = screenChanged(beforeFingerprint, fallbackFingerprint)
      return {
        ...result,
        success: changed !== false,
        message: changed === false ? 'ADB swipe completed without an observable screen change' : result.message,
        data: {
          result: result.data,
          transport: 'adb_swipe_fallback',
          humanization: trace,
          screenChanged: changed
        }
      }
    })
  }

  key(deviceId: string, keyCode: number): Promise<RpaDeviceRuntimeResult> {
    return this.runAction(deviceId, { type: 'key', params: { keyCode } })
  }

  startApp(deviceId: string, packageName: string): Promise<RpaDeviceRuntimeResult> {
    return this.runAction(deviceId, { type: 'start_app', params: { packageName } })
  }

  restartApp(deviceId: string, packageName: string): Promise<RpaDeviceRuntimeResult> {
    return this.runAction(deviceId, { type: 'restart_app', params: { packageName } })
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

  async getUiTree(deviceId: string): Promise<RpaDeviceRuntimeResult<string>> {
    return this.withDeviceLock(deviceId, async () => {
      const startedAt = Date.now()
      try {
        const remotePath = `/sdcard/mobile_openclaw_rpa_${sanitizeDeviceId(deviceId)}.xml`
        await deviceServiceProxy.executeAdbCommand(deviceId, `shell uiautomator dump ${remotePath}`)
        const data = await deviceServiceProxy.executeAdbCommand(deviceId, `shell cat ${remotePath}`)
        return {
          success: true,
          message: 'UI tree captured',
          data,
          startedAt,
          finishedAt: Date.now()
        }
      } catch (error) {
        logger.error('Failed to capture UI tree', { error, deviceId })
        return this.toFailureResult<string>(error, startedAt)
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

  private async captureScreenFingerprint(deviceId: string): Promise<ScreenFingerprint> {
    const [screenshot, uiTree] = await Promise.all([
      deviceActionRuntime.execute(deviceId, {
        type: 'screenshot',
        params: { requireScrcpy: false, maxAgeMs: 1_000 }
      }),
      this.captureUiTreeFingerprint(deviceId)
    ])
    return {
      screenshot: screenshot.success ? screenshotFingerprint(screenshot.data) : undefined,
      uiTree
    }
  }

  private async captureUiTreeFingerprint(deviceId: string): Promise<string | undefined> {
    try {
      const remotePath = `/sdcard/mobile_openclaw_swipe_${sanitizeDeviceId(deviceId)}.xml`
      await deviceServiceProxy.executeAdbCommand(deviceId, `shell uiautomator dump ${remotePath}`)
      const xml = await deviceServiceProxy.executeAdbCommand(deviceId, `shell cat ${remotePath}`)
      return normalizeUiTreeFingerprint(xml)
    } catch {
      return undefined
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

function buildBezierMotionEventCommand(trace: RpaHumanizedSwipeTrace): string {
  const segmentDurationSeconds = Math.max(0.005, trace.durationMs / Math.max(1, trace.path.length - 1) / 1_000)
  const commands = trace.path.map((point, index) => {
    const action = index === 0 ? 'DOWN' : index === trace.path.length - 1 ? 'UP' : 'MOVE'
    return `input touchscreen motionevent ${action} ${point.x} ${point.y}`
  })
  const script = commands.join(`; sleep ${segmentDurationSeconds.toFixed(3)}; `)
  return `shell sh -c "${script}"`
}

function screenshotFingerprint(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('imageBase64' in value)) return undefined
  const imageBase64 = String(value.imageBase64)
  if (!imageBase64) return undefined
  return `${imageBase64.length}:${imageBase64.slice(0, 256)}:${imageBase64.slice(-256)}`
}

function screenChanged(before: ScreenFingerprint, after: ScreenFingerprint): boolean | undefined {
  if (before.uiTree && after.uiTree) return before.uiTree !== after.uiTree
  if (!before.screenshot || !after.screenshot) return undefined
  return before.screenshot !== after.screenshot
}

function normalizeUiTreeFingerprint(xml: string): string | undefined {
  const normalized = xml
    .replace(/\s+(?:focused|selected|checked)="(?:true|false)"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized || undefined
}

function sanitizeDeviceId(deviceId: string): string {
  return deviceId.replace(/[^A-Za-z0-9_.-]/g, '_')
}

function delay(durationMs: number): Promise<void> {
  return durationMs > 0 ? new Promise((resolve) => setTimeout(resolve, durationMs)) : Promise.resolve()
}

export const rpaDeviceRuntime = new RpaDeviceActionRuntimeAdapter()
