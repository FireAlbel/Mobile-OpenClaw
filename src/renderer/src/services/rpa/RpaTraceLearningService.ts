import { type RpaArtifactStore, rpaArtifactStore } from './RpaArtifactStore'
import { createDefaultRpaModuleRegistry } from './RpaDefaultRegistry'
import {
  type RpaFailureClass,
  type RpaFailureFingerprintRepository,
  rpaFailureFingerprintRepository
} from './RpaFailureFingerprint'
import { redactRpaKnowledgeText } from './RpaKnowledge'
import type { RpaBatchRunRecord, RpaTaskFlowLearningResult, RpaTraceAnalysisRecord } from './RpaRunStorage'
import { RpaTaskValidator } from './RpaTaskValidator'
import { type RpaTemplateRepository, rpaTemplateRepository } from './RpaTemplateRepository'
import type { RpaCorrectionAction, RpaRunStepEvent, RpaStep, RpaTask } from './RpaTypes'

export interface RpaTraceLearningServiceOptions {
  fingerprints?: RpaFailureFingerprintRepository
  artifacts?: RpaArtifactStore
  templates?: Pick<RpaTemplateRepository, 'getAll' | 'save'>
  now?: () => number
}

export class RpaTraceLearningService {
  private readonly fingerprints: RpaFailureFingerprintRepository
  private readonly artifacts: RpaArtifactStore
  private readonly templates: Pick<RpaTemplateRepository, 'getAll' | 'save'>
  private readonly validator = new RpaTaskValidator(createDefaultRpaModuleRegistry(), { requireDeviceIds: false })
  private readonly now: () => number
  private readonly consolidationByRun = new Map<string, Promise<RpaTaskFlowLearningResult | undefined>>()

  constructor(options: RpaTraceLearningServiceOptions = {}) {
    this.fingerprints = options.fingerprints ?? rpaFailureFingerprintRepository
    this.artifacts = options.artifacts ?? rpaArtifactStore
    this.templates = options.templates ?? rpaTemplateRepository
    this.now = options.now ?? Date.now
  }

  async analyzeDeviceRun(run: RpaBatchRunRecord, deviceRunId: string): Promise<RpaTraceAnalysisRecord> {
    const deviceRun = run.deviceRuns.find((candidate) => candidate.id === deviceRunId)
    if (!deviceRun) throw new Error(`RPA device run not found: ${deviceRunId}`)
    if (deviceRun.status === 'pending' || deviceRun.status === 'running') {
      throw new Error('Active device runs cannot be analyzed')
    }

    const events = deviceRun.events
    const stateIds = extractStateIds(events)
    const transitions = stateIds.slice(1).map((stateId, index) => `${stateIds[index]} -> ${stateId}`)
    const failureClass = deviceRun.status === 'completed' ? undefined : classifyFailure(deviceRun.error, events)
    const evidenceArtifactIds = await this.collectEvidence(run.id, deviceRun.id, events)
    const failedPolicyIds = deviceRun.status === 'completed' ? [] : extractRecoveryPolicyIds(events)
    const summaryResult = redactRpaKnowledgeText(
      buildTraceSummary(run, deviceRun.status, deviceRun.error, events, failureClass),
      4_000
    )
    const locatorHints = extractLocatorHints(events)
    const assertionHints = extractAssertionHints(events)
    let failureFingerprintId: string | undefined
    let taskFlowLearning: RpaTaskFlowLearningResult | undefined

    if (failureClass) {
      const fingerprint = await this.fingerprints.upsert({
        failureClass,
        appPackage: readAppPackage(run),
        taskGoal: run.task.goal,
        stateId: stateIds.at(-1),
        stepId: terminalEvent(events)?.stepId,
        moduleId: readFailedModule(run, terminalEvent(events)?.stepId),
        failedRecoveryPolicyIds: failedPolicyIds,
        sourceRunId: run.id,
        sourceDeviceRunId: deviceRun.id,
        evidenceArtifactIds
      })
      failureFingerprintId = fingerprint.id
    } else if (run.deviceRuns.every((candidate) => candidate.status === 'completed')) {
      taskFlowLearning = await this.consolidateSuccessfulRun(run)
    }

    return {
      runId: run.id,
      deviceRunId: deviceRun.id,
      summary: summaryResult.text,
      failureClass,
      confidence: failureClass ? classificationConfidence(failureClass) : 0.9,
      stateIds,
      transitions: uniqueStrings(transitions),
      locatorHints,
      assertionHints,
      evidenceArtifactIds,
      failureFingerprintId,
      taskFlowLearning,
      improvementProposalIds: [],
      redactions: summaryResult.redactions,
      analyzedAt: this.now()
    }
  }

  private async consolidateSuccessfulRun(run: RpaBatchRunRecord): Promise<RpaTaskFlowLearningResult | undefined> {
    const inFlight = this.consolidationByRun.get(run.id)
    if (inFlight) return inFlight
    const operation = this.consolidateSuccessfulRunOnce(run).finally(() => {
      if (this.consolidationByRun.get(run.id) === operation) this.consolidationByRun.delete(run.id)
    })
    this.consolidationByRun.set(run.id, operation)
    return operation
  }

  private async consolidateSuccessfulRunOnce(run: RpaBatchRunRecord): Promise<RpaTaskFlowLearningResult | undefined> {
    const learned = buildDeterministicTask(run)
    if (!learned.changed) return undefined
    const validation = this.validator.validate(learned.task)
    if (!validation.success || !validation.task) {
      return {
        status: 'skipped_validation_failed',
        usedCorrection: learned.usedCorrection,
        validationIssues: validation.issues.map((issue) => `${issue.path}: ${issue.message}`).slice(0, 20)
      }
    }
    const sourceTemplate = run.contextSnapshot?.sourceTemplate
    if (!sourceTemplate) {
      const existing = (await this.templates.getAll()).find((template) => template.sourceRef === run.id)
      if (existing) {
        return {
          status: 'already_applied',
          templateId: existing.id,
          appliedVersion: existing.version,
          usedCorrection: learned.usedCorrection
        }
      }
      const created = await this.templates.save({
        name: `${run.task.name} - Verified`,
        goal: run.task.goal,
        dsl: validation.task,
        tags: ['verified', 'deterministic'],
        source: 'manual',
        sourceRef: run.id
      })
      return {
        status: 'created',
        templateId: created.id,
        appliedVersion: created.version,
        usedCorrection: learned.usedCorrection
      }
    }

    const current = (await this.templates.getAll()).find((template) => template.id === sourceTemplate.id)
    const sourceVersion = Number(sourceTemplate.version)
    if (!current) {
      return {
        status: 'skipped_version_conflict',
        templateId: sourceTemplate.id,
        sourceVersion: Number.isFinite(sourceVersion) ? sourceVersion : undefined,
        usedCorrection: learned.usedCorrection
      }
    }
    if (readLearningSourceRunId(current.dsl) === run.id) {
      return {
        status: 'already_applied',
        templateId: current.id,
        sourceVersion: Number.isFinite(sourceVersion) ? sourceVersion : undefined,
        appliedVersion: current.version,
        usedCorrection: learned.usedCorrection
      }
    }
    if (!Number.isInteger(sourceVersion) || current.version !== sourceVersion) {
      return {
        status: 'skipped_version_conflict',
        templateId: current.id,
        sourceVersion: Number.isFinite(sourceVersion) ? sourceVersion : undefined,
        appliedVersion: current.version,
        usedCorrection: learned.usedCorrection
      }
    }

    const saved = await this.templates.save({
      id: current.id,
      name: current.name,
      goal: current.goal,
      dsl: validation.task,
      tags: uniqueStrings([...current.tags, 'verified', 'deterministic']),
      skillLinks: current.skillLinks,
      role: current.role,
      source: current.source,
      sourceRef: current.sourceRef,
      sourceContext: current.sourceContext,
      saveMode: 'new_version'
    })
    return {
      status: 'versioned',
      templateId: saved.id,
      sourceVersion,
      appliedVersion: saved.version,
      usedCorrection: learned.usedCorrection
    }
  }

  private async collectEvidence(runId: string, deviceRunId: string, events: RpaRunStepEvent[]): Promise<string[]> {
    const [runArtifacts, deviceArtifacts] = await Promise.all([
      this.artifacts.findByLink('run', runId),
      this.artifacts.findByLink('device_run', deviceRunId)
    ])
    return uniqueStrings([
      ...runArtifacts.map((artifact) => artifact.id),
      ...deviceArtifacts.map((artifact) => artifact.id),
      ...events.flatMap((event) => findStringProperties(event.data, 'artifactId'))
    ])
  }
}

interface DeterministicTaskResult {
  task: RpaTask
  changed: boolean
  usedCorrection: boolean
}

function buildDeterministicTask(run: RpaBatchRunRecord): DeterministicTaskResult {
  const events = run.deviceRuns.flatMap((deviceRun) => deviceRun.events)
  const screenSize = findScreenSize(events.map((event) => event.data))
  const changes: string[] = []
  let usedCorrection = false
  const steps = run.task.steps.flatMap((step) => {
    const correctionActions = uniqueCorrectionActions(
      events.filter(
        (event) =>
          event.parentStepId === step.id &&
          event.phase === 'temporary_action' &&
          event.status === 'passed' &&
          event.verification?.status === 'passed' &&
          event.action
      )
    )
    if (correctionActions.length) {
      const learnedSteps = correctionActions
        .map((action, index) => correctionActionToStep(step, action, index, correctionActions.length, screenSize))
        .filter((candidate): candidate is RpaStep => Boolean(candidate))
      if (learnedSteps.length === correctionActions.length) {
        usedCorrection = true
        changes.push(`${step.id}: replaced by ${learnedSteps.map((candidate) => candidate.moduleId).join(', ')}`)
        return learnedSteps
      }
    }

    if (step.moduleId === 'tap_by_vlm_target' || step.moduleId === 'swipe_until_vlm_target') {
      changes.push(`${step.id}: VLM disabled for the normal path; failure recovery remains available`)
      return [{ ...step, params: { ...step.params, fallbackToVlm: false } }]
    }
    return [step]
  })

  return {
    task: {
      ...run.task,
      deviceIds: [],
      steps,
      metadata: {
        ...run.task.metadata,
        deterministicExecution: {
          sourceRunId: run.id,
          sourceDeviceIds: [...run.deviceIds],
          strategy: 'deterministic_first_vlm_on_failure',
          usedCorrection
        }
      }
    },
    changed: changes.length > 0,
    usedCorrection
  }
}

function uniqueCorrectionActions(events: RpaRunStepEvent[]): RpaCorrectionAction[] {
  const actions = new Map<string, RpaCorrectionAction>()
  for (const event of events)
    if (event.action && !actions.has(event.action.id)) actions.set(event.action.id, event.action)
  return [...actions.values()]
}

function correctionActionToStep(
  original: RpaStep,
  action: RpaCorrectionAction,
  index: number,
  actionCount: number,
  screenSize?: { width: number; height: number }
): RpaStep | undefined {
  const base = {
    id: `${original.id}-learned-${index + 1}`,
    name: `${original.name} - learned action ${index + 1}`,
    continueOnFailure: false,
    verify: index === actionCount - 1 ? original.verify : undefined
  }
  if (action.type === 'tap') {
    return screenSize
      ? {
          ...base,
          moduleId: 'tap_percent',
          params: { x: clampPercent(action.x / screenSize.width), y: clampPercent(action.y / screenSize.height) }
        }
      : { ...base, moduleId: 'tap_absolute', params: { x: action.x, y: action.y } }
  }
  if (action.type === 'swipe' && screenSize) {
    return {
      ...base,
      moduleId: 'swipe_percent',
      params: {
        x1: clampPercent(action.x1 / screenSize.width),
        y1: clampPercent(action.y1 / screenSize.height),
        x2: clampPercent(action.x2 / screenSize.width),
        y2: clampPercent(action.y2 / screenSize.height),
        durationMs: action.durationMs
      }
    }
  }
  if (action.type === 'key' && action.key === 'back') return { ...base, moduleId: 'press_back', params: {} }
  if (action.type === 'key' && action.key === 'home') return { ...base, moduleId: 'press_home', params: {} }
  if (action.type === 'start_app') {
    return { ...base, moduleId: 'launch_app', params: { packageName: action.packageName } }
  }
  if (action.type === 'wait') return { ...base, moduleId: 'wait', params: { durationMs: action.durationMs } }
  if (action.type === 'permission_action') {
    return { ...base, moduleId: 'handle_popup', params: { action: action.action, required: true } }
  }
  return undefined
}

function findScreenSize(values: unknown[]): { width: number; height: number } | undefined {
  for (const value of values) {
    const found = findRecordByKey(value, 'screenSize')
    if (
      found &&
      typeof found.width === 'number' &&
      found.width > 0 &&
      typeof found.height === 'number' &&
      found.height > 0
    ) {
      return { width: found.width, height: found.height }
    }
  }
  return undefined
}

function findRecordByKey(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRecordByKey(item, key)
      if (found) return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  if (record[key] && typeof record[key] === 'object' && !Array.isArray(record[key])) {
    return record[key] as Record<string, unknown>
  }
  for (const item of Object.values(record)) {
    const found = findRecordByKey(item, key)
    if (found) return found
  }
  return undefined
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(6))))
}

function classifyFailure(error: string | undefined, events: RpaRunStepEvent[]): RpaFailureClass {
  const text = `${error ?? ''}\n${events.map((event) => event.message).join('\n')}`.toLocaleLowerCase()
  const blockingConditions = events.flatMap((event) => findStringProperties(event.data, 'blockingCondition'))
  if (blockingConditions.includes('authentication') || /login|required sign.?in|登录/.test(text))
    return 'LOGIN_REQUIRED'
  if (blockingConditions.includes('captcha') || /captcha|验证码|security verification/.test(text))
    return 'CAPTCHA_REQUIRED'
  if (blockingConditions.includes('payment') || /payment password|confirm payment|支付/.test(text))
    return 'PAYMENT_REQUIRED'
  if (blockingConditions.includes('account_security') || /verify your identity|account security|身份验证/.test(text)) {
    return 'ACCOUNT_SECURITY_REQUIRED'
  }
  if (blockingConditions.includes('permission_dialog') || /permission dialog|permission denied/.test(text)) {
    return 'PERMISSION_BLOCKED'
  }
  if (blockingConditions.includes('popup') || /blocked by popup|dismiss overlay/.test(text)) return 'POPUP_BLOCKED'
  if (/without progress|no progress/.test(text)) return 'NO_PROGRESS'
  if (/network|connection|dns|offline|socket/.test(text)) return 'NETWORK_ERROR'
  if (/ui changed|locator|target.+not found|element.+not found/.test(text)) return 'UI_CHANGED'
  if (/not on home|wrong page|unexpected state/.test(text)) return 'NOT_ON_HOME'
  if (/entry.+not visible|not visible/.test(text)) return 'ENTRY_NOT_VISIBLE'
  if (/timeout|timed out/.test(text) || events.some((event) => event.status === 'timeout')) return 'TIMEOUT'
  if (/verification/.test(text)) return 'VERIFICATION_FAILED'
  return 'UNKNOWN_FAILURE'
}

function buildTraceSummary(
  run: RpaBatchRunRecord,
  status: string,
  error: string | undefined,
  events: RpaRunStepEvent[],
  failureClass: RpaFailureClass | undefined
): string {
  const terminal = terminalEvent(events)
  return [
    `${run.task.name}: ${status}`,
    `Goal: ${run.task.goal}`,
    failureClass ? `Failure class: ${failureClass}` : 'Result: completed',
    `Terminal step: ${terminal?.stepName ?? 'unknown'}`,
    `Reason: ${error ?? terminal?.message ?? 'No terminal error recorded'}`
  ].join('\n')
}

function extractStateIds(events: RpaRunStepEvent[]): string[] {
  const values = events.flatMap((event) => findStringProperties(event.data, 'stateId'))
  return values.filter((value, index) => index === 0 || value !== values[index - 1])
}

function extractRecoveryPolicyIds(events: RpaRunStepEvent[]): string[] {
  return uniqueStrings(
    events
      .filter((event) => event.phase === 'deterministic_recovery_plan')
      .flatMap((event) => findStringProperties(event.data, 'policyId'))
  )
}

function extractLocatorHints(events: RpaRunStepEvent[]): string[] {
  return uniqueStrings(
    events.flatMap((event) =>
      findEvidence(event.data)
        .filter((evidence) => ['ui_tree', 'ocr'].includes(String(evidence.source)) && evidence.matched === true)
        .map((evidence) => String(evidence.value ?? ''))
    )
  ).slice(0, 20)
}

function extractAssertionHints(events: RpaRunStepEvent[]): string[] {
  return uniqueStrings(
    events
      .filter((event) => event.status === 'passed' && event.verification?.status === 'passed')
      .map((event) => event.verification?.message ?? event.message)
  ).slice(0, 20)
}

function findEvidence(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(findEvidence)
  const record = value as Record<string, unknown>
  const current = 'source' in record && 'value' in record && 'matched' in record ? [record] : []
  return [...current, ...Object.values(record).flatMap(findEvidence)]
}

function findStringProperties(value: unknown, key: string): string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item) => findStringProperties(item, key))
  const record = value as Record<string, unknown>
  return [
    ...(typeof record[key] === 'string' ? [record[key] as string] : []),
    ...Object.values(record).flatMap((item) => findStringProperties(item, key))
  ]
}

function terminalEvent(events: RpaRunStepEvent[]): RpaRunStepEvent | undefined {
  return [...events].reverse().find((event) => ['failed', 'timeout', 'needs_human', 'passed'].includes(event.status))
}

function readFailedModule(run: RpaBatchRunRecord, stepId?: string): string | undefined {
  return run.task.steps.find((step) => step.id === stepId)?.moduleId
}

function readAppPackage(run: RpaBatchRunRecord): string | undefined {
  const profile = run.task.metadata.appStateProfile
  if (profile && typeof profile === 'object' && !Array.isArray(profile) && 'appPackage' in profile) {
    const value = profile.appPackage
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const packageName = run.task.steps.find((step) => typeof step.params.packageName === 'string')?.params.packageName
  return run.contextSnapshot?.appPackages[0] ?? (typeof packageName === 'string' ? packageName : undefined)
}

function readLearningSourceRunId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const metadata = (value as Record<string, unknown>).metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const deterministicExecution = (metadata as Record<string, unknown>).deterministicExecution
  if (!deterministicExecution || typeof deterministicExecution !== 'object' || Array.isArray(deterministicExecution)) {
    return undefined
  }
  const sourceRunId = (deterministicExecution as Record<string, unknown>).sourceRunId
  return typeof sourceRunId === 'string' ? sourceRunId : undefined
}

function classificationConfidence(failureClass: RpaFailureClass): number {
  return failureClass === 'UNKNOWN_FAILURE' ? 0.5 : humanOnlyFailure(failureClass) ? 0.98 : 0.85
}

function humanOnlyFailure(failureClass: RpaFailureClass): boolean {
  return ['LOGIN_REQUIRED', 'CAPTCHA_REQUIRED', 'PAYMENT_REQUIRED', 'ACCOUNT_SECURITY_REQUIRED'].includes(failureClass)
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

export const rpaTraceLearningService = new RpaTraceLearningService()
