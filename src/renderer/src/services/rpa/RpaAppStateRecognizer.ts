import { loggerService } from '@logger'

import { type RpaArtifactStore, rpaArtifactStore } from './RpaArtifactStore'
import type {
  RpaAppStateBlockingCondition,
  RpaAppStateEvidence,
  RpaAppStateProfile,
  RpaAppStateRecoveryScope,
  RpaAppStateRule,
  RpaDeviceObservation,
  RpaRecognizedAppState,
  RpaRunStepEvent
} from './RpaTypes'

const logger = loggerService.withContext('RpaAppStateRecognizer')
const UNKNOWN_STATE_ID = 'UNKNOWN'
const DEFAULT_MIN_CONFIDENCE = 0.55
const DEFAULT_CONFLICT_DELTA = 0.08

export interface RpaAppStateRecognitionInput {
  observation: RpaDeviceObservation
  profile?: RpaAppStateProfile
  expectedStateId?: string
  recentEvents?: RpaRunStepEvent[]
  minConfidence?: number
  conflictDelta?: number
  persistEvidence?: boolean
  artifactContext?: {
    targetType: 'run' | 'device_run'
    targetId: string
  }
}

export interface RpaAppStateRecognizerDependencies {
  artifactStore?: RpaArtifactStore
  persistTextFile?: (content: string) => Promise<string>
  now?: () => number
}

interface StateCandidate {
  rule: RpaAppStateRule
  confidence: number
  evidence: RpaAppStateEvidence[]
  rejected: boolean
}

export class RpaAppStateRecognizer {
  private readonly artifactStore: RpaArtifactStore
  private readonly persistTextFile: (content: string) => Promise<string>
  private readonly now: () => number

  constructor(dependencies: RpaAppStateRecognizerDependencies = {}) {
    this.artifactStore = dependencies.artifactStore ?? rpaArtifactStore
    this.persistTextFile = dependencies.persistTextFile ?? this.persistTextFileToLibrary.bind(this)
    this.now = dependencies.now ?? Date.now
  }

  async recognize(input: RpaAppStateRecognitionInput): Promise<RpaRecognizedAppState> {
    const rules = [...globalBlockingRules(), ...(input.profile?.states ?? [])]
    const candidates = rules
      .map((rule) => this.scoreRule(rule, input))
      .filter((candidate) => !candidate.rejected)
      .sort(compareCandidates)
    const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE
    const conflictDelta = input.conflictDelta ?? DEFAULT_CONFLICT_DELTA
    const best = candidates[0]
    const second = candidates[1]

    let result: RpaRecognizedAppState
    if (!best || best.confidence < minConfidence) {
      result = this.unknownResult(
        input,
        best,
        best ? `Best candidate ${best.rule.stateId} was below the confidence threshold` : 'No state rule matched'
      )
    } else if (
      second &&
      second.rule.stateId !== best.rule.stateId &&
      second.confidence >= minConfidence &&
      best.confidence - second.confidence <= conflictDelta
    ) {
      result = this.unknownResult(
        input,
        best,
        `Conflicting state evidence for ${best.rule.stateId} and ${second.rule.stateId}`
      )
      result.evidence = [...best.evidence, ...second.evidence]
    } else {
      const blockingCondition = best.rule.blockingCondition ?? 'none'
      result = {
        stateId: best.rule.stateId,
        label: best.rule.label ?? best.rule.stateId,
        confidence: roundConfidence(best.confidence),
        blocking: blockingCondition !== 'none',
        blockingCondition,
        recoveryScope: best.rule.recoveryScope ?? defaultRecoveryScope(blockingCondition),
        suggestedTransitions: uniqueStrings(best.rule.suggestedTransitions),
        evidence: best.evidence,
        reason: `Matched ${best.rule.stateId} with ${best.evidence.filter((item) => item.matched).length} evidence item(s)`,
        recognizedAt: this.now()
      }
    }

    if (input.persistEvidence && input.artifactContext) {
      try {
        result.artifactId = await this.persistResult(result, input)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        input.observation.warnings.push({
          source: 'artifact',
          message: `State evidence persistence failed: ${message}`
        })
        logger.warn('Failed to persist recognized app state', {
          error,
          deviceId: input.observation.deviceId,
          stateId: result.stateId
        })
      }
    }

    input.observation.recognizedState = result
    return result
  }

  private scoreRule(rule: RpaAppStateRule, input: RpaAppStateRecognitionInput): StateCandidate {
    const evidence: RpaAppStateEvidence[] = []
    const foreground = readForeground(input.observation.foregroundApp)
    const searchableTexts = collectSearchableTexts(input.observation)
    let score = Math.max(0, Math.min(0.1, (rule.priority ?? 0) / 1_000))
    let possibleWeight = 0
    let rejected = false

    const addEvidence = (source: RpaAppStateEvidence['source'], value: string, weight: number, matched: boolean) => {
      possibleWeight += weight
      if (matched) score += weight
      evidence.push({ source, value, weight, matched })
    }

    if (rule.packageNames?.length) {
      const matched = rule.packageNames.some(
        (packageName) => normalize(packageName) === normalize(foreground.packageName)
      )
      addEvidence('foreground_package', foreground.packageName || 'unavailable', 0.35, matched)
    }

    if (rule.activityIncludes?.length) {
      const matched = rule.activityIncludes.some((activity) =>
        normalize(foreground.activity).includes(normalize(activity))
      )
      addEvidence('foreground_activity', foreground.activity || 'unavailable', 0.2, matched)
    }

    for (const requiredText of rule.requiredTexts ?? []) {
      const match = findTextMatch(requiredText, searchableTexts)
      addEvidence(match?.source ?? 'ui_tree', requiredText, 0.25, Boolean(match))
      if (!match) rejected = true
    }

    if (rule.anyTexts?.length) {
      const eligibleTexts =
        rule.stateId === 'BLOCKED_BY_POPUP'
          ? rule.anyTexts.filter((text) => !weakStandalonePopupTargets.has(normalize(text)))
          : rule.anyTexts
      const matchedText = eligibleTexts.find((text) => findTextMatch(text, searchableTexts))
      const match = matchedText ? findTextMatch(matchedText, searchableTexts) : undefined
      addEvidence(match?.source ?? 'ui_tree', matchedText ?? eligibleTexts.join(' | '), 0.45, Boolean(match))
    }

    const excludedText = rule.excludedTexts?.find((text) => findTextMatch(text, searchableTexts))
    if (excludedText) {
      const match = findTextMatch(excludedText, searchableTexts)
      evidence.push({ source: match?.source ?? 'ui_tree', value: excludedText, weight: -1, matched: true })
      rejected = true
    }

    if (rule.requireScreenshot) {
      addEvidence('screenshot', 'screenshot available', 0.1, Boolean(input.observation.screenshot))
    }

    if (input.expectedStateId === rule.stateId) {
      addEvidence('run_context', `expected:${rule.stateId}`, 0.08, true)
    }

    const recentState = readRecentState(input.recentEvents)
    if (recentState === rule.stateId) {
      addEvidence('run_context', `recent:${rule.stateId}`, 0.04, true)
    }

    const normalizedScore = possibleWeight > 0 ? score / Math.max(1, possibleWeight) : score
    return { rule, confidence: Math.min(1, normalizedScore), evidence, rejected }
  }

  private unknownResult(
    input: RpaAppStateRecognitionInput,
    candidate: StateCandidate | undefined,
    reason: string
  ): RpaRecognizedAppState {
    return {
      stateId: UNKNOWN_STATE_ID,
      label: 'Unknown',
      confidence: roundConfidence(candidate?.confidence ?? 0),
      blocking: true,
      blockingCondition: 'unknown',
      recoveryScope: input.observation.screenshot ? 'navigate' : 'restart_app',
      suggestedTransitions: candidate ? [candidate.rule.stateId] : [],
      evidence: candidate?.evidence ?? [],
      candidateStateId: candidate?.rule.stateId,
      reason,
      recognizedAt: this.now()
    }
  }

  private async persistResult(result: RpaRecognizedAppState, input: RpaAppStateRecognitionInput): Promise<string> {
    const artifactContext = input.artifactContext
    if (!artifactContext) throw new Error('State artifact context is required')
    const content = JSON.stringify(
      {
        deviceId: input.observation.deviceId,
        observationCapturedAt: input.observation.capturedAt,
        expectedStateId: input.expectedStateId,
        appPackage: input.profile?.appPackage,
        appVersion: input.profile?.appVersion,
        result
      },
      null,
      2
    )
    const externalPath = await this.persistTextFile(content)
    const registered = await this.artifactStore.register({
      category: 'run_log',
      title: `Recognized state ${result.stateId} on ${input.observation.deviceId}`,
      description: result.reason,
      contentHash: stateContentHash(content),
      sizeBytes: new TextEncoder().encode(content).byteLength,
      source: 'observation',
      locator: { externalPath, extension: '.json', mimeType: 'application/json' },
      links: [{ ...artifactContext, relation: 'recognized_app_state' }],
      retentionPolicy: 'temporary',
      textForRedaction: content
    })
    return registered.artifact.id
  }

  private async persistTextFileToLibrary(content: string): Promise<string> {
    if (!window.api?.file?.writeWithId) throw new Error('RPA state artifact storage is unavailable')
    return await window.api.file.writeWithId(`${stateContentHash(content)}.json`, content)
  }
}

function globalBlockingRules(): RpaAppStateRule[] {
  return [
    {
      stateId: 'PERMISSION_DIALOG',
      label: 'Permission dialog',
      priority: 100,
      packageNames: ['com.android.permissioncontroller', 'com.google.android.permissioncontroller'],
      anyTexts: ['允许', '仅在使用时允许', 'allow', 'while using the app'],
      blockingCondition: 'permission_dialog',
      recoveryScope: 'dismiss_overlay',
      suggestedTransitions: ['EXPECTED_STATE']
    },
    {
      stateId: 'CAPTCHA',
      label: 'Security verification',
      priority: 100,
      anyTexts: ['验证码', '安全验证', '拖动滑块', 'captcha', 'security verification'],
      blockingCondition: 'captcha',
      recoveryScope: 'human'
    },
    {
      stateId: 'LOGIN',
      label: 'Login required',
      priority: 100,
      anyTexts: ['登录', '验证码登录', '手机号登录', 'sign in', 'log in'],
      blockingCondition: 'authentication',
      recoveryScope: 'human'
    },
    {
      stateId: 'PAYMENT',
      label: 'Payment confirmation',
      priority: 100,
      anyTexts: ['confirm payment', 'pay now', 'payment password', 'purchase'],
      blockingCondition: 'payment',
      recoveryScope: 'human'
    },
    {
      stateId: 'ACCOUNT_SECURITY',
      label: 'Account security confirmation',
      priority: 100,
      anyTexts: ['account security', 'identity verification', 'verify your identity', 'suspicious activity'],
      blockingCondition: 'account_security',
      recoveryScope: 'human'
    },
    {
      stateId: 'BLOCKED_BY_POPUP',
      label: 'Blocked by popup',
      priority: 100,
      anyTexts: ['稍后再说', '暂不', '关闭', '取消', '我知道了', 'not now', 'cancel', 'close'],
      blockingCondition: 'popup',
      recoveryScope: 'dismiss_overlay'
    },
    {
      stateId: 'UPDATE_PROMPT',
      label: 'Update prompt',
      priority: 95,
      anyTexts: ['update now', 'new version available', '发现新版本', '立即更新'],
      blockingCondition: 'update_prompt',
      recoveryScope: 'dismiss_overlay'
    },
    {
      stateId: 'PROMOTIONAL_OVERLAY',
      label: 'Promotional overlay',
      priority: 95,
      anyTexts: ['skip ad', 'close ad', '跳过广告', '关闭广告'],
      blockingCondition: 'promotional_overlay',
      recoveryScope: 'dismiss_overlay'
    },
    {
      stateId: 'NETWORK_ERROR',
      label: 'Network error',
      priority: 90,
      anyTexts: ['no internet connection', 'network unavailable', '网络不可用', '网络开小差'],
      blockingCondition: 'network_error',
      recoveryScope: 'navigate'
    },
    {
      stateId: 'LOADING_FAILURE',
      label: 'Loading failure',
      priority: 90,
      anyTexts: ['failed to load', 'load failed', '加载失败', '页面加载失败'],
      blockingCondition: 'loading_failure',
      recoveryScope: 'navigate'
    }
  ]
}

function collectSearchableTexts(observation: RpaDeviceObservation): Array<{ text: string; source: 'ui_tree' | 'ocr' }> {
  const values = [
    ...(observation.uiTree?.nodes.flatMap((node) =>
      [node.text, node.contentDescription].filter(Boolean).map((text) => ({ text, source: 'ui_tree' as const }))
    ) ?? []),
    ...(observation.ocr?.blocks.map((block) => ({ text: block.text, source: 'ocr' as const })) ?? [])
  ]
  const seen = new Set<string>()
  return values.filter(({ text, source }) => {
    const key = `${source}:${normalize(text)}`
    if (!normalize(text) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function findTextMatch(
  target: string,
  values: Array<{ text: string; source: 'ui_tree' | 'ocr' }>
): { text: string; source: 'ui_tree' | 'ocr' } | undefined {
  const normalizedTarget = normalize(target)
  if (exactMatchTargets.has(normalizedTarget)) {
    return values.find(({ text }) => normalize(text) === normalizedTarget)
  }
  return values.find(({ text }) => normalize(text).includes(normalizedTarget))
}

const exactMatchTargets = new Set(['登录', 'sign in', 'log in'])

const weakStandalonePopupTargets = new Set(['关闭', '取消', 'cancel', 'close'])

function readForeground(value: unknown): { packageName: string; activity: string } {
  if (!value || typeof value !== 'object') return { packageName: '', activity: '' }
  const record = value as Record<string, unknown>
  return {
    packageName: typeof record.packageName === 'string' ? record.packageName : '',
    activity: typeof record.activity === 'string' ? record.activity : ''
  }
}

function readRecentState(events: RpaRunStepEvent[] | undefined): string | undefined {
  for (const event of [...(events ?? [])].reverse()) {
    const state = findRecognizedState(event.data)
    if (state) return state.stateId
  }
  return undefined
}

function findRecognizedState(value: unknown): RpaRecognizedAppState | undefined {
  if (!value || typeof value !== 'object') return undefined
  if ('stateId' in value && typeof value.stateId === 'string' && 'confidence' in value) {
    return value as RpaRecognizedAppState
  }
  for (const nested of Object.values(value)) {
    const result = findRecognizedState(nested)
    if (result) return result
  }
  return undefined
}

function compareCandidates(left: StateCandidate, right: StateCandidate): number {
  return right.confidence - left.confidence || (right.rule.priority ?? 0) - (left.rule.priority ?? 0)
}

function defaultRecoveryScope(condition: RpaAppStateBlockingCondition): RpaAppStateRecoveryScope {
  if (condition === 'none') return 'none'
  if (condition === 'permission_dialog' || condition === 'popup') return 'dismiss_overlay'
  if (['authentication', 'captcha', 'payment', 'account_security'].includes(condition)) return 'human'
  return 'navigate'
}

function uniqueStrings(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((item) => item.trim()).filter(Boolean))]
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function roundConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000) / 1_000
}

function stateContentHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `rpa-state-${(hash >>> 0).toString(16)}`
}

export const rpaAppStateRecognizer = new RpaAppStateRecognizer()
