import * as z from 'zod'

import { RpaObservationService } from './RpaObservationService'
import type { RpaActionModule, RpaModuleExecutionContext, RpaModuleResult, RpaRetryPolicy } from './RpaTypes'

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

export const tapByVlmTargetModule: RpaActionModule<{
  target: string
  instruction?: string
  fallbackToVlm?: boolean
}> = {
  metadata: metadata(
    'tap_by_vlm_target',
    'Tap by VLM target',
    'Ask the VLM to locate a visual target and tap it on the selected device.',
    60_000
  ),
  paramsSchema: z.object({
    target: z.string().min(1),
    instruction: z.string().min(1).optional(),
    fallbackToVlm: z.boolean().default(true)
  }),
  async execute(context, params) {
    const startedAt = now()
    const candidate = await findDeterministicTextCandidate(context, params.target)
    if (candidate) {
      const radius = Math.max(
        0,
        Math.min(7, candidate.bounds.physical.width / 2 - 2, candidate.bounds.physical.height / 2 - 2)
      )
      const tap = await context.runtime.tap(
        context.deviceId,
        candidate.bounds.physical.centerX,
        candidate.bounds.physical.centerY,
        { randomRadiusPx: radius, safeInsetPx: 2 }
      )
      return moduleResult(startedAt, tap, `Deterministic text target tapped: ${candidate.text}`)
    }
    if (params.fallbackToVlm === false) {
      return {
        success: false,
        status: 'failed',
        message: `Deterministic text target not found: ${params.target}`,
        data: { target: params.target, fallbackToVlm: false },
        startedAt,
        finishedAt: now()
      }
    }
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

function extractTargetAliases(target: string): string[] {
  const quoted = [...target.matchAll(/[“”"']([^“”"']+)[“”"']/g)].map((match) => match[1])
  const delimited = target
    .split(/(?:\s*(?:或|或者|、|\/|\||；|;)\s*)/u)
    .map((value) => value.replace(/^[“”"']+|[“”"']+$/g, '').trim())
    .filter((value) => value.length > 1 && value.length <= 40)
  return [...new Set([...quoted, ...delimited, target].map(normalizeTargetText).filter(Boolean))]
}

function compareTextCandidates(
  left: { text: string; confidence: number },
  right: { text: string; confidence: number },
  aliases: string[]
): number {
  const score = (candidate: { text: string; confidence: number }) => {
    const text = normalizeTargetText(candidate.text)
    const exactAlias = aliases.find((alias) => text === alias)
    const containedAlias = aliases
      .filter((alias) => text.includes(alias))
      .sort((leftAlias, rightAlias) => rightAlias.length - leftAlias.length)[0]
    return (
      (exactAlias ? 2_000 + exactAlias.length : containedAlias ? 1_000 + containedAlias.length : 0) +
      candidate.confidence
    )
  }
  return score(right) - score(left)
}

function normalizeTargetText(value: string): string {
  return value.trim().toLocaleLowerCase()
}

async function findDeterministicTextCandidate(context: RpaModuleExecutionContext, target: string) {
  if (typeof context.runtime.getUiTree !== 'function') return undefined
  const targetAliases = extractTargetAliases(target)
  const observation = await new RpaObservationService(context.runtime).capture(context.deviceId, {
    includeScreenshot: false,
    includeForegroundApp: false,
    includeScreenSize: true,
    includeUiTree: true,
    includeOcr: false,
    targetTexts: targetAliases
  })
  return observation.textCandidates
    ?.filter((item) => !item.approximate)
    .sort((left, right) => compareTextCandidates(left, right, targetAliases))[0]
}

export const swipeUntilVlmTargetModule: RpaActionModule<{
  target: string
  direction?: 'up' | 'down' | 'left' | 'right'
  maxAttempts?: number
  maxSwipes?: number
  fallbackToVlm?: boolean
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
    maxAttempts: z.number().int().min(1).max(10).default(3),
    maxSwipes: z.number().int().min(1).max(10).optional(),
    fallbackToVlm: z.boolean().default(true)
  }),
  async execute(context, params) {
    const startedAt = now()
    const direction = params.direction ?? 'up'
    const maxAttempts = params.maxSwipes ?? params.maxAttempts ?? 3

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const candidate = await findDeterministicTextCandidate(context, params.target)
      if (candidate) {
        return {
          success: true,
          status: 'passed',
          message: `Deterministic text target found: ${candidate.text}`,
          data: { target: params.target, matchedText: candidate.text, attempts: attempt },
          startedAt,
          finishedAt: now()
        }
      }
      if (params.fallbackToVlm !== false) {
        const located = await context.runtime.locateVisualTarget(
          context.deviceId,
          params.target,
          context.task.visionModel,
          context.signal
        )
        if (!located.success) return moduleResult(startedAt, located)
        if (located.data?.found) {
          return {
            success: true,
            status: 'passed',
            message: `Visual target found: ${params.target}`,
            data: { ...located.data, attempts: attempt },
            startedAt,
            finishedAt: now()
          }
        }
      }
      if (attempt >= maxAttempts) break

      const screenSize = await context.runtime.getScreenSize(context.deviceId)
      if (!screenSize.success || !screenSize.data) {
        return moduleResult(startedAt, screenSize)
      }
      const swipe = createSearchSwipe(screenSize.data, direction)
      const swipeResult = await context.runtime.swipe(context.deviceId, swipe.x1, swipe.y1, swipe.x2, swipe.y2, 500)
      if (!swipeResult.success) {
        return moduleResult(startedAt, swipeResult)
      }
    }

    return {
      success: false,
      status: 'failed',
      message: `Visual target not found after ${maxAttempts} attempts: ${params.target}`,
      data: { target: params.target, attempts: maxAttempts },
      startedAt,
      finishedAt: now()
    }
  }
}

function createSearchSwipe(
  screen: { width: number; height: number },
  direction: 'up' | 'down' | 'left' | 'right'
): { x1: number; y1: number; x2: number; y2: number } {
  const centerX = Math.round(screen.width / 2)
  const centerY = Math.round(screen.height / 2)
  const horizontalStart = Math.round(screen.width * 0.8)
  const horizontalEnd = Math.round(screen.width * 0.2)
  const verticalStart = Math.round(screen.height * 0.8)
  const verticalEnd = Math.round(screen.height * 0.3)
  if (direction === 'up') return { x1: centerX, y1: verticalStart, x2: centerX, y2: verticalEnd }
  if (direction === 'down') return { x1: centerX, y1: verticalEnd, x2: centerX, y2: verticalStart }
  if (direction === 'left') return { x1: horizontalStart, y1: centerY, x2: horizontalEnd, y2: centerY }
  return { x1: horizontalEnd, y1: centerY, x2: horizontalStart, y2: centerY }
}

export const p1RpaModules = [handlePopupModule, tapByVlmTargetModule, swipeUntilVlmTargetModule]
