import * as z from 'zod'

import type { RpaActionModule, RpaModuleResult, RpaRetryPolicy } from './RpaTypes'

const defaultRetry: RpaRetryPolicy = {
  maxAttempts: 1,
  backoffMs: 0,
  retryOn: ['failed', 'timeout', 'uncertain']
}

function now(): number {
  return Date.now()
}

function moduleResult(
  startedAt: number,
  runtimeResult: { success: boolean; message: string; data?: unknown },
  successMessage?: string
): RpaModuleResult {
  const requiresHuman =
    !runtimeResult.success &&
    typeof runtimeResult.data === 'object' &&
    runtimeResult.data !== null &&
    'needsHuman' in runtimeResult.data &&
    runtimeResult.data.needsHuman === true
  return {
    success: runtimeResult.success,
    status: runtimeResult.success ? 'passed' : requiresHuman ? 'needs_human' : 'failed',
    message: runtimeResult.success && successMessage ? successMessage : runtimeResult.message,
    data: runtimeResult.data,
    startedAt,
    finishedAt: now()
  }
}

function needsHuman(startedAt: number, message: string, data?: unknown): RpaModuleResult {
  return {
    success: false,
    status: 'needs_human',
    message,
    data,
    startedAt,
    finishedAt: now()
  }
}

function metadata(id: string, name: string, description: string, defaultTimeoutMs = 30_000) {
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

export const handlePopupModule: RpaActionModule<{
  action: 'allow' | 'deny' | 'allow_once'
  required?: boolean
}> = {
  metadata: metadata(
    'handle_popup',
    'Handle popup',
    'Handle a known blocking popup. P1 supports Android permission dialogs only.'
  ),
  paramsSchema: z.object({
    action: z.enum(['allow', 'deny', 'allow_once']).default('allow'),
    required: z.boolean().default(false)
  }),
  async execute(context, params) {
    const startedAt = now()
    const result = await context.runtime.handlePermissionDialog(context.deviceId, params.action)
    if (result.success && result.data === false && params.required) {
      return needsHuman(startedAt, 'Required permission popup was not found', result.data)
    }
    return moduleResult(startedAt, result)
  }
}

export const tapByVlmTargetModule: RpaActionModule<{ target: string; instruction?: string }> = {
  metadata: metadata(
    'tap_by_vlm_target',
    'Tap by VLM target',
    'Ask the VLM to locate a visual target and tap it on the selected device.',
    60_000
  ),
  paramsSchema: z.object({
    target: z.string().min(1),
    instruction: z.string().min(1).optional()
  }),
  async execute(context, params) {
    const startedAt = now()
    const instruction = params.instruction ?? `Find and tap this visual target: ${params.target}`
    const result = await context.runtime.visionInstruction(
      context.deviceId,
      instruction,
      ['tap'],
      context.task.visionModel,
      context.signal
    )
    return moduleResult(startedAt, result, `VLM tap executed for target: ${params.target}`)
  }
}

export const swipeUntilVlmTargetModule: RpaActionModule<{
  target: string
  direction?: 'up' | 'down' | 'left' | 'right'
  maxAttempts?: number
}> = {
  metadata: metadata(
    'swipe_until_vlm_target',
    'Swipe until VLM target',
    'Ask the VLM to perform bounded swipes while searching for a visual target.',
    90_000
  ),
  paramsSchema: z.object({
    target: z.string().min(1),
    direction: z.enum(['up', 'down', 'left', 'right']).default('up'),
    maxAttempts: z.number().int().min(1).max(10).default(3)
  }),
  async execute(context, params) {
    const startedAt = now()
    let lastResult: Awaited<ReturnType<typeof context.runtime.visionInstruction>> | undefined
    const direction = params.direction ?? 'up'
    const maxAttempts = params.maxAttempts ?? 3

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      lastResult = await context.runtime.visionInstruction(
        context.deviceId,
        [
          `Search for visual target: ${params.target}`,
          `If it is not visible, swipe ${direction}.`,
          'Return a swipe action only.'
        ].join('\n'),
        ['swipe'],
        context.task.visionModel,
        context.signal
      )
      if (!lastResult.success) {
        return moduleResult(startedAt, lastResult)
      }
    }

    return moduleResult(
      startedAt,
      lastResult ?? {
        success: false,
        message: 'VLM swipe search did not execute'
      },
      `Completed VLM swipe search for target: ${params.target}`
    )
  }
}

export const p1RpaModules = [handlePopupModule, tapByVlmTargetModule, swipeUntilVlmTargetModule]
