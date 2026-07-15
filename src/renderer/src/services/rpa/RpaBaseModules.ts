import * as z from 'zod'

import type { RpaActionModule, RpaModuleExecutionContext, RpaModuleResult, RpaRetryPolicy } from './RpaTypes'

const defaultRetry: RpaRetryPolicy = {
  maxAttempts: 1,
  backoffMs: 0,
  retryOn: ['failed', 'timeout']
}

function now(): number {
  return Date.now()
}

function resultFromRuntime(
  startedAt: number,
  runtimeResult: { success: boolean; message: string; data?: unknown }
): RpaModuleResult {
  return {
    success: runtimeResult.success,
    status: runtimeResult.success ? 'passed' : 'failed',
    message: runtimeResult.message,
    data: runtimeResult.data,
    startedAt,
    finishedAt: now()
  }
}

function failedResult(startedAt: number, message: string): RpaModuleResult {
  return {
    success: false,
    status: 'failed',
    message,
    startedAt,
    finishedAt: now()
  }
}

function baseMetadata(id: string, name: string, description: string, defaultTimeoutMs = 30_000) {
  return {
    id,
    name,
    description,
    riskLevel: 'low' as const,
    defaultTimeoutMs,
    defaultRetry,
    plannerHints: [description]
  }
}

const packageNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_.]+$/, 'Invalid Android package name')
const percentSchema = z.number().min(0).max(1)

export const launchAppModule: RpaActionModule<{ packageName: string }> = {
  metadata: baseMetadata('launch_app', 'Launch app', 'Start an Android app by package name.'),
  paramsSchema: z.object({
    packageName: packageNameSchema
  }),
  async execute(context, params) {
    const startedAt = now()
    const runtimeResult = await context.runtime.startApp(context.deviceId, params.packageName)
    return resultFromRuntime(startedAt, runtimeResult)
  }
}

export const waitModule: RpaActionModule<{ durationMs: number }> = {
  metadata: baseMetadata('wait', 'Wait', 'Wait for a fixed duration before continuing.', 10_000),
  paramsSchema: z.object({
    durationMs: z.number().int().min(0).max(60_000)
  }),
  async execute(_context, params) {
    const startedAt = now()
    await new Promise((resolve) => setTimeout(resolve, params.durationMs))
    return {
      success: true,
      status: 'passed',
      message: `Waited ${params.durationMs}ms`,
      startedAt,
      finishedAt: now()
    }
  }
}

export const screenshotModule: RpaActionModule = {
  metadata: baseMetadata('screenshot', 'Screenshot', 'Capture the current device screen.'),
  paramsSchema: z.object({}).default({}),
  async execute(context) {
    const startedAt = now()
    const runtimeResult = await context.runtime.screenshot(context.deviceId)
    return resultFromRuntime(startedAt, runtimeResult)
  }
}

export const tapAbsoluteModule: RpaActionModule<{ x: number; y: number }> = {
  metadata: baseMetadata('tap_absolute', 'Tap absolute coordinate', 'Tap a fixed device coordinate.'),
  paramsSchema: z.object({
    x: z.number().min(0),
    y: z.number().min(0)
  }),
  async execute(context, params) {
    const startedAt = now()
    const runtimeResult = await context.runtime.tap(context.deviceId, Math.round(params.x), Math.round(params.y))
    return resultFromRuntime(startedAt, runtimeResult)
  }
}

export const tapPercentModule: RpaActionModule<{ x: number; y: number }> = {
  metadata: baseMetadata('tap_percent', 'Tap percent coordinate', 'Tap a normalized coordinate from 0 to 1.'),
  paramsSchema: z.object({
    x: percentSchema,
    y: percentSchema
  }),
  async execute(context, params) {
    const startedAt = now()
    const size = await context.runtime.getScreenSize(context.deviceId)
    if (!size.success || !size.data) {
      return failedResult(startedAt, `Unable to resolve screen size: ${size.message}`)
    }
    const x = Math.round(size.data.width * params.x)
    const y = Math.round(size.data.height * params.y)
    const runtimeResult = await context.runtime.tap(context.deviceId, x, y)
    return resultFromRuntime(startedAt, {
      ...runtimeResult,
      data: { ...(runtimeResult.data as Record<string, unknown> | undefined), x, y, screenSize: size.data }
    })
  }
}

export const swipePercentModule: RpaActionModule<{
  x1: number
  y1: number
  x2: number
  y2: number
  durationMs?: number
}> = {
  metadata: baseMetadata(
    'swipe_percent',
    'Swipe percent coordinates',
    'Swipe between normalized coordinates from 0 to 1.'
  ),
  paramsSchema: z.object({
    x1: percentSchema,
    y1: percentSchema,
    x2: percentSchema,
    y2: percentSchema,
    durationMs: z.number().int().min(50).max(10_000).optional()
  }),
  async execute(context, params) {
    const startedAt = now()
    const size = await context.runtime.getScreenSize(context.deviceId)
    if (!size.success || !size.data) {
      return failedResult(startedAt, `Unable to resolve screen size: ${size.message}`)
    }
    const x1 = Math.round(size.data.width * params.x1)
    const y1 = Math.round(size.data.height * params.y1)
    const x2 = Math.round(size.data.width * params.x2)
    const y2 = Math.round(size.data.height * params.y2)
    const runtimeResult = await context.runtime.swipe(context.deviceId, x1, y1, x2, y2, params.durationMs)
    return resultFromRuntime(startedAt, {
      ...runtimeResult,
      data: { ...(runtimeResult.data as Record<string, unknown> | undefined), x1, y1, x2, y2, screenSize: size.data }
    })
  }
}

function keyModule(id: string, name: string, description: string, keyCode: number): RpaActionModule {
  return {
    metadata: baseMetadata(id, name, description),
    paramsSchema: z.object({}).default({}),
    async execute(context: RpaModuleExecutionContext) {
      const startedAt = now()
      const runtimeResult = await context.runtime.key(context.deviceId, keyCode)
      return resultFromRuntime(startedAt, runtimeResult)
    }
  }
}

export const pressBackModule = keyModule('press_back', 'Press back', 'Send Android Back key event.', 4)
export const pressHomeModule = keyModule('press_home', 'Press home', 'Send Android Home key event.', 3)

export const getForegroundAppModule: RpaActionModule = {
  metadata: baseMetadata(
    'get_foreground_app',
    'Get foreground app',
    'Read the current foreground Android package and activity.'
  ),
  paramsSchema: z.object({}).default({}),
  async execute(context) {
    const startedAt = now()
    const runtimeResult = await context.runtime.getForegroundApp(context.deviceId)
    return resultFromRuntime(startedAt, runtimeResult)
  }
}

export const baseRpaModules = [
  launchAppModule,
  waitModule,
  screenshotModule,
  tapAbsoluteModule,
  tapPercentModule,
  swipePercentModule,
  pressBackModule,
  pressHomeModule,
  getForegroundAppModule
]
