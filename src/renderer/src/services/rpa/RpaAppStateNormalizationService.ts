import { loggerService } from '@logger'

import {
  type RpaAppPlaybook,
  type RpaAppPlaybookRepository,
  rpaAppPlaybookRepository
} from './RpaAppPlaybookRepository'
import { RpaAppStateRecognizer } from './RpaAppStateRecognizer'
import { RpaObservationService } from './RpaObservationService'
import type {
  RpaAppNormalizationActionGroup,
  RpaAppNormalizationPolicy,
  RpaAppNormalizationResult,
  RpaAppNormalizationStage,
  RpaAppStateProfile,
  RpaAppTargetState,
  RpaDeviceObservation,
  RpaDeviceRuntime,
  RpaModuleProgressEvent,
  RpaRecognizedAppState,
  RpaStep,
  RpaTask
} from './RpaTypes'

const logger = loggerService.withContext('RpaAppStateNormalizationService')
const PROTECTED_CONDITIONS = new Set([
  'authentication',
  'captcha',
  'payment',
  'account_security',
  'unsupported_app_version'
])
const SAFE_PLAYBOOK_MODULES = new Set([
  'tap_absolute',
  'tap_percent',
  'swipe_percent',
  'press_back',
  'press_home',
  'launch_app',
  'wait',
  'handle_popup'
])

export const DEFAULT_APP_NORMALIZATION_POLICY: RpaAppNormalizationPolicy = {
  stages: [
    'dismiss_transient',
    'dismiss_keyboard',
    'bounded_back',
    'known_home_action',
    'soft_relaunch',
    'hard_restart'
  ],
  maxBackCount: 3,
  restartMode: 'soft_then_hard',
  deadlineMs: 45_000,
  stabilityWindowMs: 600,
  noProgressLimit: 2
}

export interface RpaAppStateNormalizationInput {
  deviceId: string
  packageName: string
  targetState: RpaAppTargetState
  task?: RpaTask
  profile?: RpaAppStateProfile
  appVersion?: string
  locale?: string
  policy?: Partial<RpaAppNormalizationPolicy>
  restartFirst?: 'soft' | 'hard'
  signal?: AbortSignal
  reportProgress?: (event: RpaModuleProgressEvent) => void
}

export interface RpaAppStateNormalizationDependencies {
  observationService?: RpaObservationService
  recognizer?: RpaAppStateRecognizer
  playbooks?: RpaAppPlaybookRepository
  now?: () => number
  delay?: (durationMs: number, signal?: AbortSignal) => Promise<void>
}

export class RpaAppStateNormalizationService {
  private readonly observationService: RpaObservationService
  private readonly recognizer: RpaAppStateRecognizer
  private readonly playbooks: RpaAppPlaybookRepository
  private readonly now: () => number
  private readonly wait: (durationMs: number, signal?: AbortSignal) => Promise<void>

  constructor(
    private readonly runtime: RpaDeviceRuntime,
    dependencies: RpaAppStateNormalizationDependencies = {}
  ) {
    this.observationService = dependencies.observationService ?? new RpaObservationService(runtime)
    this.recognizer = dependencies.recognizer ?? new RpaAppStateRecognizer()
    this.playbooks = dependencies.playbooks ?? rpaAppPlaybookRepository
    this.now = dependencies.now ?? Date.now
    this.wait = dependencies.delay ?? abortableDelay
  }

  async normalize(input: RpaAppStateNormalizationInput): Promise<RpaAppNormalizationResult> {
    const startedAt = this.now()
    const policy = resolvePolicy(input.policy)
    const deadline = startedAt + policy.deadlineMs
    const actionGroups: RpaAppNormalizationActionGroup[] = []
    const playbook = await this.playbooks.resolve(input.packageName, input.appVersion, input.locale)
    const profile = mergeProfiles(
      input.packageName,
      input.profile ?? readTaskProfile(input.task),
      playbook && this.playbooks.toProfile(playbook)
    )
    const targetStateId = resolveTargetStateId(input.targetState, playbook, profile)
    let observation = await this.captureStableObservation(input, profile, policy.stabilityWindowMs)
    const initialState = observation.recognizedState
    input.reportProgress?.({
      phase: 'app_normalization_initial',
      status: 'running',
      message: `Initial app state: ${initialState?.stateId ?? 'UNKNOWN'}`,
      data: { recognizedState: initialState, artifacts: observation.artifacts }
    })

    if (input.targetState !== 'foreground' && input.targetState !== 'home' && !targetStateId) {
      return this.result(input, startedAt, actionGroups, initialState, observation.recognizedState, 'failed', playbook)
    }
    if (isProtected(observation.recognizedState)) {
      return this.result(
        input,
        startedAt,
        actionGroups,
        initialState,
        observation.recognizedState,
        'human_required',
        playbook
      )
    }
    if (matchesTarget(observation, input.packageName, input.targetState, targetStateId)) {
      return this.result(
        input,
        startedAt,
        actionGroups,
        initialState,
        observation.recognizedState,
        'goal_achieved',
        playbook
      )
    }

    const stages: RpaAppNormalizationStage[] = input.restartFirst
      ? [input.restartFirst === 'hard' ? 'hard_restart' : 'soft_relaunch', ...policy.stages]
      : policy.stages
    const attemptedStages = new Set<RpaAppNormalizationStage>()
    let noProgressCount = 0
    let previousSignature = observationSignature(observation)

    for (const stage of stages) {
      input.signal?.throwIfAborted()
      if (this.now() >= deadline) {
        return this.result(
          input,
          startedAt,
          actionGroups,
          initialState,
          observation.recognizedState,
          'timeout',
          playbook
        )
      }
      if (attemptedStages.has(stage)) continue
      attemptedStages.add(stage)
      const stageAttempts = stage === 'bounded_back' ? policy.maxBackCount : 1
      for (let stageAttempt = 1; stageAttempt <= stageAttempts; stageAttempt += 1) {
        const stageGroups = await this.executeStage(
          stage,
          stageAttempt,
          input,
          observation,
          targetStateId,
          playbook,
          policy
        )
        if (!stageGroups.length) break
        for (const group of stageGroups) {
          actionGroups.push(group)
          input.reportProgress?.({
            phase: 'app_normalization_action',
            status: group.success ? 'passed' : 'failed',
            message: `${group.stage}: ${group.message}`,
            data: group
          })
          observation = await this.captureStableObservation(input, profile, policy.stabilityWindowMs)
          group.afterStateId = observation.recognizedState?.stateId
          group.finishedAt = this.now()
          group.verification = {
            status: matchesTarget(observation, input.packageName, input.targetState, targetStateId)
              ? 'passed'
              : 'failed',
            confidence: observation.recognizedState?.confidence ?? 0,
            message: `Observed ${observation.recognizedState?.stateId ?? 'UNKNOWN'} after ${stage}`,
            evidence: { recognizedState: observation.recognizedState, artifacts: observation.artifacts }
          }
          input.reportProgress?.({
            phase: 'app_normalization_verification',
            status: group.verification.status === 'passed' ? 'passed' : 'failed',
            message: group.verification.message,
            data: group,
            verification: group.verification
          })
          if (isProtected(observation.recognizedState)) {
            return this.result(
              input,
              startedAt,
              actionGroups,
              initialState,
              observation.recognizedState,
              'human_required',
              playbook
            )
          }
          if (group.verification.status === 'passed') {
            return this.result(
              input,
              startedAt,
              actionGroups,
              initialState,
              observation.recognizedState,
              'goal_achieved',
              playbook
            )
          }
          const signature = observationSignature(observation)
          noProgressCount = signature === previousSignature ? noProgressCount + 1 : 0
          previousSignature = signature
          if (noProgressCount >= policy.noProgressLimit) {
            logger.warn('App state normalization stopped after repeated no-progress observations', {
              deviceId: input.deviceId,
              packageName: input.packageName,
              stage,
              noProgressCount
            })
            return this.result(
              input,
              startedAt,
              actionGroups,
              initialState,
              observation.recognizedState,
              'replan',
              playbook
            )
          }
        }
      }
    }

    return this.result(
      input,
      startedAt,
      actionGroups,
      initialState,
      observation.recognizedState,
      observation.recognizedState?.stateId === 'UNKNOWN' ? 'replan' : 'failed',
      playbook
    )
  }

  private async executeStage(
    stage: RpaAppNormalizationStage,
    stageAttempt: number,
    input: RpaAppStateNormalizationInput,
    observation: RpaDeviceObservation,
    targetStateId: string | undefined,
    playbook: RpaAppPlaybook | undefined,
    policy: RpaAppNormalizationPolicy
  ): Promise<RpaAppNormalizationActionGroup[]> {
    const state = observation.recognizedState
    if (stage === 'dismiss_transient') {
      if (state?.blockingCondition === 'permission_dialog') {
        if (playbook?.disabledHandlerIds.includes('global:permission_dialog')) return []
        return [
          await this.runRuntimeGroup(stage, 1, state, [{ type: 'permission_action', detail: 'allow_once' }], () =>
            this.runtime.handlePermissionDialog(input.deviceId, 'allow_once')
          )
        ]
      }
      if (state?.blockingCondition === 'popup' || state?.recoveryScope === 'dismiss_overlay') {
        if (playbook?.disabledHandlerIds.includes('global:dismiss_popup_back')) return []
        return [
          await this.runRuntimeGroup(stage, 1, state, [{ type: 'key', detail: 'back' }], () =>
            this.runtime.key(input.deviceId, 4)
          )
        ]
      }
      if (state?.blockingCondition === 'network_error' || state?.blockingCondition === 'loading_failure') {
        if (playbook?.disabledHandlerIds.includes('global:retryable_loading_wait')) return []
        return [
          await this.runRuntimeGroup(stage, 1, state, [{ type: 'wait', detail: '1500ms' }], async () => {
            await this.wait(1_500, input.signal)
            return runtimeSuccess('Waited for retryable loading state', this.now())
          })
        ]
      }
      return []
    }
    if (stage === 'dismiss_keyboard') {
      if (playbook?.disabledHandlerIds.includes('global:dismiss_keyboard_back')) return []
      if (!looksLikeKeyboardState(observation)) return []
      return [
        await this.runRuntimeGroup(stage, 1, state, [{ type: 'key', detail: 'back' }], () =>
          this.runtime.key(input.deviceId, 4)
        )
      ]
    }
    if (stage === 'bounded_back') {
      return [
        await this.runRuntimeGroup(stage, stageAttempt, state, [{ type: 'key', detail: 'back' }], () =>
          this.runtime.key(input.deviceId, 4)
        )
      ]
    }
    if (stage === 'known_home_action') {
      if (!playbook || !targetStateId || !state) return []
      const path = this.playbooks.findPath(playbook, state.stateId, targetStateId)
      if (!path?.length) return []
      return [
        await this.runPlaybookGroup(
          input,
          state,
          path.flatMap((edge) => edge.steps)
        )
      ]
    }
    if (stage === 'soft_relaunch') {
      if (policy.restartMode === 'hard') return []
      const operation = this.runtime.softRelaunchApp ?? this.runtime.bringAppToForeground ?? this.runtime.startApp
      return [
        await this.runRuntimeGroup(stage, 1, state, [{ type: 'start_app', detail: input.packageName }], () =>
          operation.call(this.runtime, input.deviceId, input.packageName)
        )
      ]
    }
    if (policy.restartMode === 'soft') return []
    return [await this.runHardRestart(input, state)]
  }

  private async runHardRestart(
    input: RpaAppStateNormalizationInput,
    state: RpaRecognizedAppState | undefined
  ): Promise<RpaAppNormalizationActionGroup> {
    if (this.runtime.hardRestartApp) {
      return this.runRuntimeGroup(
        'hard_restart',
        1,
        state,
        [
          { type: 'stop_app', detail: input.packageName },
          { type: 'start_app', detail: input.packageName }
        ],
        () => this.runtime.hardRestartApp!(input.deviceId, input.packageName)
      )
    }
    if (this.runtime.stopApp) {
      const stopped = await this.runtime.stopApp(input.deviceId, input.packageName)
      if (!stopped.success) return failedGroup('hard_restart', state, stopped.message, this.now())
      await this.wait(400, input.signal)
      return this.runRuntimeGroup(
        'hard_restart',
        1,
        state,
        [
          { type: 'stop_app', detail: input.packageName },
          { type: 'start_app', detail: input.packageName }
        ],
        () => this.runtime.startApp(input.deviceId, input.packageName)
      )
    }
    if (this.runtime.restartApp) {
      return this.runRuntimeGroup(
        'hard_restart',
        1,
        state,
        [
          { type: 'stop_app', detail: input.packageName },
          { type: 'start_app', detail: input.packageName }
        ],
        () => this.runtime.restartApp!(input.deviceId, input.packageName)
      )
    }
    return failedGroup('hard_restart', state, 'Hard restart is unavailable in this runtime', this.now())
  }

  private async runRuntimeGroup(
    stage: RpaAppNormalizationStage,
    attempt: number,
    state: RpaRecognizedAppState | undefined,
    actions: RpaAppNormalizationActionGroup['actions'],
    operation: () => Promise<{ success: boolean; message: string }>
  ): Promise<RpaAppNormalizationActionGroup> {
    const startedAt = this.now()
    const result = await operation()
    return {
      stage,
      attempt,
      actions,
      startedAt,
      finishedAt: this.now(),
      success: result.success,
      message: result.message,
      beforeStateId: state?.stateId
    }
  }

  private async runPlaybookGroup(
    input: RpaAppStateNormalizationInput,
    state: RpaRecognizedAppState,
    steps: RpaStep[]
  ): Promise<RpaAppNormalizationActionGroup> {
    const startedAt = this.now()
    for (const step of steps) {
      if (!SAFE_PLAYBOOK_MODULES.has(step.moduleId)) {
        return failedGroup('known_home_action', state, `Unsafe Playbook module rejected: ${step.moduleId}`, startedAt)
      }
      const result = await this.executePlaybookStep(input, step)
      if (!result.success) return failedGroup('known_home_action', state, result.message, startedAt)
    }
    return {
      stage: 'known_home_action',
      attempt: 1,
      actions: [{ type: 'playbook_steps', detail: steps.map((step) => step.moduleId).join(', ') }],
      startedAt,
      finishedAt: this.now(),
      success: true,
      message: `Executed ${steps.length} verified Playbook step(s)`,
      beforeStateId: state.stateId
    }
  }

  private async executePlaybookStep(input: RpaAppStateNormalizationInput, step: RpaStep) {
    const params = step.params
    if (step.moduleId === 'press_back') return this.runtime.key(input.deviceId, 4)
    if (step.moduleId === 'press_home') return this.runtime.key(input.deviceId, 3)
    if (step.moduleId === 'launch_app')
      return this.runtime.startApp(input.deviceId, readPackage(params, input.packageName))
    if (step.moduleId === 'handle_popup') {
      const action = params.action === 'deny' || params.action === 'allow' ? params.action : 'allow_once'
      return this.runtime.handlePermissionDialog(input.deviceId, action)
    }
    if (step.moduleId === 'wait') {
      await this.wait(readNumber(params.durationMs, 500, 0, 10_000), input.signal)
      return runtimeSuccess('Wait completed', this.now())
    }
    const size = await this.runtime.getScreenSize(input.deviceId)
    if (!size.success || !size.data) return size
    if (step.moduleId === 'tap_absolute') {
      return this.runtime.tap(
        input.deviceId,
        readNumber(params.x, 0, 0, size.data.width),
        readNumber(params.y, 0, 0, size.data.height)
      )
    }
    if (step.moduleId === 'tap_percent') {
      return this.runtime.tap(
        input.deviceId,
        Math.round(size.data.width * readNumber(params.x, 0, 0, 1)),
        Math.round(size.data.height * readNumber(params.y, 0, 0, 1))
      )
    }
    return this.runtime.swipe(
      input.deviceId,
      Math.round(size.data.width * readNumber(params.x1, 0.5, 0, 1)),
      Math.round(size.data.height * readNumber(params.y1, 0.8, 0, 1)),
      Math.round(size.data.width * readNumber(params.x2, 0.5, 0, 1)),
      Math.round(size.data.height * readNumber(params.y2, 0.2, 0, 1)),
      readNumber(params.durationMs, 500, 50, 10_000)
    )
  }

  private async captureStableObservation(
    input: RpaAppStateNormalizationInput,
    profile: RpaAppStateProfile,
    stabilityWindowMs: number
  ): Promise<RpaDeviceObservation> {
    const capture = async () => {
      const observation = await this.observationService.capture(input.deviceId, {
        includeScreenshot: true,
        includeForegroundApp: true,
        includeScreenSize: true,
        includeUiTree: true,
        includeOcr: false,
        targetTexts: profile.states.flatMap((state) => [...(state.requiredTexts ?? []), ...(state.anyTexts ?? [])])
      })
      await this.recognizer.recognize({ observation, profile, expectedStateId: String(input.targetState) })
      return observation
    }
    let previous = await capture()
    if (stabilityWindowMs <= 0) return previous
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.wait(stabilityWindowMs, input.signal)
      const current = await capture()
      if (observationSignature(previous) === observationSignature(current)) return current
      previous = current
    }
    previous.warnings.push({
      source: 'state_recognition',
      message: 'Screen remained visually unstable during classification'
    })
    if (previous.recognizedState) {
      previous.recognizedState = {
        ...previous.recognizedState,
        stateId: 'UNKNOWN',
        label: 'Unstable',
        blocking: true,
        blockingCondition: 'unknown',
        recoveryScope: 'navigate',
        candidateStateId: previous.recognizedState.stateId,
        reason: 'Screen remained visually unstable during classification'
      }
    }
    return previous
  }

  private result(
    input: RpaAppStateNormalizationInput,
    startedAt: number,
    actionGroups: RpaAppNormalizationActionGroup[],
    initialState: RpaRecognizedAppState | undefined,
    finalState: RpaRecognizedAppState | undefined,
    outcome: RpaAppNormalizationResult['outcome'],
    playbook?: RpaAppPlaybook
  ): RpaAppNormalizationResult {
    const success = outcome === 'goal_achieved'
    const status = success
      ? 'passed'
      : outcome === 'human_required'
        ? 'needs_human'
        : outcome === 'timeout'
          ? 'timeout'
          : 'failed'
    return {
      success,
      status,
      outcome,
      packageName: input.packageName,
      targetState: input.targetState,
      initialState,
      finalState,
      actionGroups,
      attempts: actionGroups.length,
      elapsedMs: this.now() - startedAt,
      message: success
        ? `App reached ${input.targetState}`
        : outcome === 'human_required'
          ? `Protected app state requires human intervention: ${finalState?.stateId ?? 'UNKNOWN'}`
          : `Unable to reach ${input.targetState}: ${outcome}`,
      playbookId: playbook?.id,
      playbookVersion: playbook?.version
    }
  }
}

function resolvePolicy(input: Partial<RpaAppNormalizationPolicy> | undefined): RpaAppNormalizationPolicy {
  return {
    stages: input?.stages ?? DEFAULT_APP_NORMALIZATION_POLICY.stages,
    maxBackCount: clampInteger(input?.maxBackCount, 0, 5, DEFAULT_APP_NORMALIZATION_POLICY.maxBackCount),
    restartMode: input?.restartMode ?? DEFAULT_APP_NORMALIZATION_POLICY.restartMode,
    deadlineMs: clampInteger(input?.deadlineMs, 1_000, 120_000, DEFAULT_APP_NORMALIZATION_POLICY.deadlineMs),
    stabilityWindowMs: clampInteger(
      input?.stabilityWindowMs,
      0,
      5_000,
      DEFAULT_APP_NORMALIZATION_POLICY.stabilityWindowMs
    ),
    noProgressLimit: clampInteger(input?.noProgressLimit, 1, 5, DEFAULT_APP_NORMALIZATION_POLICY.noProgressLimit)
  }
}

function readTaskProfile(task?: RpaTask): RpaAppStateProfile | undefined {
  const candidate = task?.metadata.appStateProfile
  if (!candidate || typeof candidate !== 'object' || !Array.isArray((candidate as RpaAppStateProfile).states))
    return undefined
  return candidate as RpaAppStateProfile
}

function mergeProfiles(packageName: string, ...profiles: Array<RpaAppStateProfile | undefined>): RpaAppStateProfile {
  const states = new Map<string, RpaAppStateProfile['states'][number]>()
  for (const profile of profiles) for (const state of profile?.states ?? []) states.set(state.stateId, state)
  return { appPackage: packageName, states: [...states.values()] }
}

function resolveTargetStateId(
  target: string,
  playbook: RpaAppPlaybook | undefined,
  profile: RpaAppStateProfile
): string | undefined {
  if (target === 'foreground') return undefined
  if (target === 'home') {
    return (
      playbook?.launchBehavior.homeStateId ??
      profile.states.find((state) => /^(home|app_home|main)$/i.test(state.stateId))?.stateId
    )
  }
  return target
}

function matchesTarget(
  observation: RpaDeviceObservation,
  packageName: string,
  target: string,
  targetStateId?: string
): boolean {
  const foreground = observation.foregroundApp as { packageName?: unknown } | undefined
  if (foreground?.packageName !== packageName) return false
  if (target === 'foreground') return true
  if (target === 'home' && !targetStateId) return matchesGenericHomeActivity(observation)
  return Boolean(
    targetStateId && observation.recognizedState?.stateId === targetStateId && !observation.recognizedState.blocking
  )
}

function matchesGenericHomeActivity(observation: RpaDeviceObservation): boolean {
  const foreground = observation.foregroundApp as { activity?: unknown } | undefined
  const activity = typeof foreground?.activity === 'string' ? foreground.activity.trim() : ''
  if (!activity || isProtected(observation.recognizedState)) return false
  const activityName = activity.split('/').at(-1) ?? activity
  return /(?:^|\.)(?:settings|mainactivity|homeactivity|launcheractivity)$/i.test(activityName)
}

function isProtected(state?: RpaRecognizedAppState): boolean {
  return Boolean(state && (state.recoveryScope === 'human' || PROTECTED_CONDITIONS.has(state.blockingCondition)))
}

function looksLikeKeyboardState(observation: RpaDeviceObservation): boolean {
  return /keyboard|input method|soft input|输入法|键盘/i.test(
    `${observation.recognizedState?.stateId ?? ''} ${observation.uiTree?.xml ?? ''}`
  )
}

function observationSignature(observation: RpaDeviceObservation): string {
  const foreground = observation.foregroundApp as { packageName?: unknown; activity?: unknown } | undefined
  const texts = (observation.textCandidates ?? [])
    .map((candidate) => candidate.text)
    .sort()
    .slice(0, 20)
  return JSON.stringify([foreground?.packageName, foreground?.activity, observation.recognizedState?.stateId, texts])
}

function failedGroup(
  stage: RpaAppNormalizationStage,
  state: RpaRecognizedAppState | undefined,
  message: string,
  startedAt: number
): RpaAppNormalizationActionGroup {
  return {
    stage,
    attempt: 1,
    actions: [],
    startedAt,
    finishedAt: Date.now(),
    success: false,
    message,
    beforeStateId: state?.stateId
  }
}

function runtimeSuccess(message: string, timestamp: number) {
  return { success: true, message, startedAt: timestamp, finishedAt: timestamp }
}

function readPackage(params: Record<string, unknown>, fallback: string): string {
  return typeof params.packageName === 'string' && /^[A-Za-z0-9_.]+$/.test(params.packageName)
    ? params.packageName
    : fallback
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  return value === undefined ? fallback : Math.max(min, Math.min(max, Math.round(value)))
}

function abortableDelay(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, durationMs)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(signal?.reason ?? new Error('App state normalization aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
