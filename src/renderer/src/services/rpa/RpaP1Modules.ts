import * as z from 'zod'

import { RpaObservationService } from './RpaObservationService'
import type {
  RpaActionModule,
  RpaDeviceObservation,
  RpaModuleExecutionContext,
  RpaModuleResult,
  RpaRetryPolicy
} from './RpaTypes'

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
  targetAliases?: string[]
  resourceIds?: string[]
  includeOcr?: boolean
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
    fallbackToVlm: z.boolean().default(true),
    targetAliases: z.array(z.string().min(1)).default([]),
    resourceIds: z.array(z.string().min(1)).default([]),
    includeOcr: z.boolean().default(false)
  }),
  async execute(context, params) {
    const startedAt = now()
    const candidate = await findDeterministicTextCandidate(context, params.target, {
      targetAliases: params.targetAliases,
      resourceIds: params.resourceIds,
      includeOcr: params.includeOcr
    })
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

interface DeterministicTargetOptions {
  targetAliases?: string[]
  resourceIds?: string[]
  includeOcr?: boolean
}

type DeterministicTextCandidate = NonNullable<RpaDeviceObservation['textCandidates']>[number]

async function captureDeterministicViewport(
  context: RpaModuleExecutionContext,
  target: string,
  options: DeterministicTargetOptions = {}
): Promise<{
  candidate?: DeterministicTextCandidate
  fingerprint?: string
  warnings: RpaDeviceObservation['warnings']
}> {
  const targetAliases = [...new Set([...extractTargetAliases(target), ...(options.targetAliases ?? [])])]
    .map(normalizeTargetText)
    .filter(Boolean)
  const observation = await new RpaObservationService(context.runtime).capture(context.deviceId, {
    includeScreenshot: options.includeOcr === true,
    includeForegroundApp: false,
    includeScreenSize: true,
    includeUiTree: true,
    includeOcr: options.includeOcr === true,
    targetTexts: targetAliases
  })
  const normalizedResourceIds = (options.resourceIds ?? []).map(normalizeTargetText).filter(Boolean)
  const resourceCandidate = observation.uiTree?.nodes.find((node) =>
    normalizedResourceIds.some((resourceId) => normalizeTargetText(node.resourceId) === resourceId)
  )
  const candidate = resourceCandidate
    ? {
        source: 'ui_tree' as const,
        text: resourceCandidate.text || resourceCandidate.contentDescription || resourceCandidate.resourceId,
        confidence: 1,
        bounds: resourceCandidate.bounds,
        nodeId: resourceCandidate.id
      }
    : observation.textCandidates
        ?.filter((item) => !item.approximate)
        .sort((left, right) => compareTextCandidates(left, right, targetAliases))[0]
  return {
    candidate,
    fingerprint: createViewportFingerprint(observation),
    warnings: observation.warnings
  }
}

async function findDeterministicTextCandidate(
  context: RpaModuleExecutionContext,
  target: string,
  options: DeterministicTargetOptions = {}
) {
  return (await captureDeterministicViewport(context, target, options)).candidate
}

function createViewportFingerprint(observation: RpaDeviceObservation): string | undefined {
  const nodes = observation.uiTree?.nodes
  if (!nodes?.length) return undefined
  const normalized = nodes.map((node) =>
    [node.text, node.contentDescription, node.resourceId, node.bounds.physical.top, node.bounds.physical.bottom].join(
      '|'
    )
  )
  let hash = 2166136261
  const value = normalized.join('\n')
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
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

interface ListScanTargetParams {
  target: string
  targetAliases?: string[]
  resourceIds?: string[]
  searchMode?: 'current_then_exhaustive'
  resetToBoundary?: boolean
  resetDirection?: 'up' | 'down'
  scanDirection?: 'up' | 'down'
  maxResetSwipes?: number
  maxScanSwipes?: number
  noProgressLimit?: number
  includeOcr?: boolean
  fallbackToVlm?: boolean
}

interface ListScanAudit {
  target: string
  viewportsScanned: number
  uniqueViewports: number
  resetSwipes: number
  scanSwipes: number
  resetBoundaryReached: boolean
  scanBoundaryReached: boolean
  locatorSource?: 'ui_tree' | 'ocr'
  matchedText?: string
  vlmInvoked: boolean
  warnings: string[]
}

export const listScanTargetModule: RpaActionModule<ListScanTargetParams> = {
  metadata: metadata(
    'list.scan_target',
    'Scan list for target',
    'Search the current viewport, reset to a list boundary, scan boundary-to-boundary, then use one compact VLM fallback.',
    120_000
  ),
  paramsSchema: z.object({
    target: z.string().min(1),
    targetAliases: z.array(z.string().min(1)).default([]),
    resourceIds: z.array(z.string().min(1)).default([]),
    searchMode: z.literal('current_then_exhaustive').default('current_then_exhaustive'),
    resetToBoundary: z.boolean().default(true),
    resetDirection: z.enum(['up', 'down']).default('down'),
    scanDirection: z.enum(['up', 'down']).default('up'),
    maxResetSwipes: z.number().int().min(0).max(30).default(8),
    maxScanSwipes: z.number().int().min(1).max(50).default(20),
    noProgressLimit: z.number().int().min(1).max(5).default(2),
    includeOcr: z.boolean().default(false),
    fallbackToVlm: z.boolean().default(true)
  }),
  async execute(context, params) {
    const startedAt = now()
    const options: DeterministicTargetOptions = {
      targetAliases: params.targetAliases,
      resourceIds: params.resourceIds,
      includeOcr: params.includeOcr
    }
    const audit: ListScanAudit = {
      target: params.target,
      viewportsScanned: 0,
      uniqueViewports: 0,
      resetSwipes: 0,
      scanSwipes: 0,
      resetBoundaryReached: params.resetToBoundary === false,
      scanBoundaryReached: false,
      vlmInvoked: false,
      warnings: []
    }
    const fingerprints = new Set<string>()
    let viewport = await captureDeterministicViewport(context, params.target, options)

    const inspectViewport = (): RpaModuleResult | undefined => {
      audit.viewportsScanned += 1
      if (viewport.fingerprint) fingerprints.add(viewport.fingerprint)
      audit.uniqueViewports = fingerprints.size
      audit.warnings.push(...viewport.warnings.map((warning) => `${warning.source}: ${warning.message}`))
      if (!viewport.candidate) return undefined
      audit.locatorSource = viewport.candidate.source
      audit.matchedText = viewport.candidate.text
      return {
        success: true,
        status: 'passed',
        message: `Deterministic list target found: ${viewport.candidate.text}`,
        data: audit,
        startedAt,
        finishedAt: now()
      }
    }
    const initialMatch = inspectViewport()
    if (initialMatch) return initialMatch

    const swipeAndCapture = async (direction: 'up' | 'down') => {
      if (context.signal?.aborted) throw context.signal.reason ?? new Error('List scan aborted')
      const screenSize = await context.runtime.getScreenSize(context.deviceId)
      if (!screenSize.success || !screenSize.data) return { failure: moduleResult(startedAt, screenSize) }
      const swipe = createSearchSwipe(screenSize.data, direction)
      const swipeResult = await context.runtime.swipe(context.deviceId, swipe.x1, swipe.y1, swipe.x2, swipe.y2, 500, {
        enabled: true,
        pathSamples: 12,
        curveStrength: 0.16
      })
      if (!swipeResult.success) return { failure: moduleResult(startedAt, swipeResult) }
      const previousFingerprint = viewport.fingerprint
      viewport = await captureDeterministicViewport(context, params.target, options)
      return { unchanged: Boolean(previousFingerprint && viewport.fingerprint === previousFingerprint) }
    }

    if (params.resetToBoundary !== false) {
      let noProgress = 0
      for (let swipeIndex = 0; swipeIndex < (params.maxResetSwipes ?? 8); swipeIndex += 1) {
        const moved = await swipeAndCapture(params.resetDirection ?? 'down')
        if (moved.failure) return moved.failure
        audit.resetSwipes += 1
        const match = inspectViewport()
        if (match) return match
        noProgress = moved.unchanged ? noProgress + 1 : 0
        if (noProgress >= (params.noProgressLimit ?? 2)) {
          audit.resetBoundaryReached = true
          break
        }
      }
    }

    let noProgress = 0
    for (let swipeIndex = 0; swipeIndex < (params.maxScanSwipes ?? 20); swipeIndex += 1) {
      const moved = await swipeAndCapture(params.scanDirection ?? 'up')
      if (moved.failure) return moved.failure
      audit.scanSwipes += 1
      const match = inspectViewport()
      if (match) return match
      noProgress = moved.unchanged ? noProgress + 1 : 0
      if (noProgress >= (params.noProgressLimit ?? 2)) {
        audit.scanBoundaryReached = true
        break
      }
    }

    if (params.fallbackToVlm !== false) {
      audit.vlmInvoked = true
      const aliases = [...new Set([params.target, ...(params.targetAliases ?? [])])].join(' | ')
      const compactContext = [
        `Target aliases: ${aliases}`,
        `Deterministic coverage: resetBoundary=${audit.resetBoundaryReached}, scanBoundary=${audit.scanBoundaryReached}`,
        `Viewports=${audit.viewportsScanned}, unique=${audit.uniqueViewports}`,
        'Allowed decision: report whether the target is visible in the current viewport; do not infer unseen list content.'
      ].join('\n')
      const located = await context.runtime.locateVisualTarget(
        context.deviceId,
        compactContext,
        context.task.visionModel,
        context.signal
      )
      if (!located.success) return moduleResult(startedAt, located)
      if (located.data?.found) {
        return {
          success: true,
          status: 'passed',
          message: `VLM found list target after deterministic scan: ${params.target}`,
          data: { ...audit, vlm: located.data },
          startedAt,
          finishedAt: now()
        }
      }
    }

    const exhaustive = audit.resetBoundaryReached && audit.scanBoundaryReached
    return {
      success: false,
      status: 'failed',
      message: exhaustive
        ? `List target not found after boundary-to-boundary scan: ${params.target}`
        : `List target not found and exhaustive coverage could not be proven: ${params.target}`,
      data: audit,
      startedAt,
      finishedAt: now()
    }
  }
}

export const p1RpaModules = [handlePopupModule, tapByVlmTargetModule, swipeUntilVlmTargetModule, listScanTargetModule]
