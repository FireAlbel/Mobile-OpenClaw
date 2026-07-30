import { loggerService } from '@logger'

import { redactRpaKnowledgeText } from './RpaKnowledge'

const logger = loggerService.withContext('RpaFailureFingerprint')

export const RPA_FAILURE_CLASSES = [
  'NOT_ON_HOME',
  'ENTRY_NOT_VISIBLE',
  'LOGIN_REQUIRED',
  'CAPTCHA_REQUIRED',
  'PAYMENT_REQUIRED',
  'ACCOUNT_SECURITY_REQUIRED',
  'POPUP_BLOCKED',
  'PERMISSION_BLOCKED',
  'NETWORK_ERROR',
  'UI_CHANGED',
  'NO_PROGRESS',
  'TIMEOUT',
  'VERIFICATION_FAILED',
  'UNKNOWN_FAILURE'
] as const

export type RpaFailureClass = (typeof RPA_FAILURE_CLASSES)[number]

export interface RpaStructuredFailureExperience {
  schemaVersion: 1
  scope: {
    appPackage?: string
    taskGoal: string
    stateId?: string
    stepId?: string
    moduleId?: string
  }
  diagnosis: {
    failureClass: RpaFailureClass
    disposition: 'retry_bounded' | 'skip_failed_policy' | 'human_required'
  }
  recovery: {
    failedPolicyIds: string[]
  }
  verification: {
    status: 'unverified' | 'verified'
    successCount: number
    lastVerifiedAt?: number
  }
  confidence: number
}

export interface RpaFailureFingerprint {
  id: string
  key: string
  failureClass: RpaFailureClass
  appPackage?: string
  taskGoalSummary: string
  stateId?: string
  stepId?: string
  moduleId?: string
  failedRecoveryPolicyIds: string[]
  sourceRunIds: string[]
  sourceDeviceRunIds: string[]
  evidenceArtifactIds: string[]
  occurrenceCount: number
  disposition: 'retry_bounded' | 'skip_failed_policy' | 'human_required'
  experience: RpaStructuredFailureExperience
  status: 'active' | 'disabled'
  firstSeenAt: number
  lastSeenAt: number
}

export interface UpsertRpaFailureFingerprintInput {
  failureClass: RpaFailureClass
  appPackage?: string
  taskGoal: string
  stateId?: string
  stepId?: string
  moduleId?: string
  failedRecoveryPolicyIds?: string[]
  sourceRunId: string
  sourceDeviceRunId: string
  evidenceArtifactIds?: string[]
}

export interface RpaFailureFingerprintMatchInput {
  appPackage?: string
  taskGoal?: string
  stateId?: string
  failureClass?: RpaFailureClass
}

export interface RpaFailureFingerprintStorage {
  loadFingerprints(): Promise<RpaFailureFingerprint[]>
  saveFingerprints(fingerprints: RpaFailureFingerprint[]): Promise<void>
}

class LocalStorageRpaFailureFingerprintStorage implements RpaFailureFingerprintStorage {
  private readonly storageKey = 'rpa_failure_fingerprints'

  async loadFingerprints(): Promise<RpaFailureFingerprint[]> {
    if (typeof localStorage === 'undefined') return []
    try {
      const stored = localStorage.getItem(this.storageKey)
      return stored ? sanitizeRpaFailureFingerprints(JSON.parse(stored)) : []
    } catch (error) {
      logger.warn('Failed to load local RPA failure fingerprints', { error })
      return []
    }
  }

  async saveFingerprints(fingerprints: RpaFailureFingerprint[]): Promise<void> {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(this.storageKey, JSON.stringify(sanitizeRpaFailureFingerprints(fingerprints)))
  }
}

class IpcRpaFailureFingerprintStorage implements RpaFailureFingerprintStorage {
  constructor(
    private readonly fallback: RpaFailureFingerprintStorage = new LocalStorageRpaFailureFingerprintStorage()
  ) {}

  async loadFingerprints(): Promise<RpaFailureFingerprint[]> {
    if (!window.api?.rpa?.loadFailureFingerprints) return this.fallback.loadFingerprints()
    try {
      return sanitizeRpaFailureFingerprints(await window.api.rpa.loadFailureFingerprints())
    } catch (error) {
      logger.warn('Failed to load RPA failure fingerprints through IPC', { error })
      return this.fallback.loadFingerprints()
    }
  }

  async saveFingerprints(fingerprints: RpaFailureFingerprint[]): Promise<void> {
    const sanitized = sanitizeRpaFailureFingerprints(fingerprints)
    if (!window.api?.rpa?.saveFailureFingerprints) return this.fallback.saveFingerprints(sanitized)
    try {
      await window.api.rpa.saveFailureFingerprints(sanitized)
    } catch (error) {
      logger.warn('Failed to save RPA failure fingerprints through IPC', { error })
      await this.fallback.saveFingerprints(sanitized)
    }
  }
}

export class RpaFailureFingerprintRepository {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: RpaFailureFingerprintStorage = new IpcRpaFailureFingerprintStorage(),
    private readonly now: () => number = Date.now
  ) {}

  async getAll(): Promise<RpaFailureFingerprint[]> {
    await this.writeQueue
    return sanitizeRpaFailureFingerprints(await this.storage.loadFingerprints())
  }

  async findMatches(input: RpaFailureFingerprintMatchInput): Promise<RpaFailureFingerprint[]> {
    const goal = normalizeForMatch(input.taskGoal ?? '')
    return (await this.getAll())
      .filter((fingerprint) => fingerprint.status === 'active')
      .filter((fingerprint) => fingerprint.experience.confidence >= 0.65)
      .filter((fingerprint) => !input.appPackage || fingerprint.appPackage === input.appPackage)
      .filter((fingerprint) => !input.stateId || fingerprint.stateId === input.stateId)
      .filter((fingerprint) => !input.failureClass || fingerprint.failureClass === input.failureClass)
      .filter(
        (fingerprint) =>
          !goal ||
          normalizeForMatch(fingerprint.taskGoalSummary).includes(goal) ||
          goal.includes(normalizeForMatch(fingerprint.taskGoalSummary))
      )
      .sort((left, right) => right.occurrenceCount - left.occurrenceCount || right.lastSeenAt - left.lastSeenAt)
  }

  async shouldSkipPolicy(input: RpaFailureFingerprintMatchInput, policyId: string): Promise<boolean> {
    return (await this.findMatches(input)).some(
      (fingerprint) =>
        fingerprint.disposition === 'skip_failed_policy' &&
        fingerprint.occurrenceCount >= 2 &&
        fingerprint.failedRecoveryPolicyIds.includes(policyId)
    )
  }

  async upsert(input: UpsertRpaFailureFingerprintInput): Promise<RpaFailureFingerprint> {
    const timestamp = this.now()
    const normalized = normalizeInput(input)
    const key = fingerprintKey(normalized)
    return this.enqueue(async () => {
      const fingerprints = sanitizeRpaFailureFingerprints(await this.storage.loadFingerprints())
      const existing = fingerprints.find((fingerprint) => fingerprint.key === key)
      const occurrenceCount = (existing?.occurrenceCount ?? 0) + 1
      const failedRecoveryPolicyIds = uniqueStrings([
        ...(existing?.failedRecoveryPolicyIds ?? []),
        ...normalized.failedRecoveryPolicyIds
      ])
      const disposition = resolveDisposition(normalized.failureClass, occurrenceCount, failedRecoveryPolicyIds)
      const fingerprint: RpaFailureFingerprint = {
        id: existing?.id ?? `rpa-failure-${timestamp}-${simpleHash(key)}`,
        key,
        failureClass: normalized.failureClass,
        appPackage: normalized.appPackage,
        taskGoalSummary: normalized.taskGoalSummary,
        stateId: normalized.stateId,
        stepId: normalized.stepId,
        moduleId: normalized.moduleId,
        failedRecoveryPolicyIds,
        sourceRunIds: uniqueStrings([...(existing?.sourceRunIds ?? []), normalized.sourceRunId]).slice(-50),
        sourceDeviceRunIds: uniqueStrings([
          ...(existing?.sourceDeviceRunIds ?? []),
          normalized.sourceDeviceRunId
        ]).slice(-100),
        evidenceArtifactIds: uniqueStrings([
          ...(existing?.evidenceArtifactIds ?? []),
          ...normalized.evidenceArtifactIds
        ]).slice(-100),
        occurrenceCount,
        disposition,
        experience: {
          schemaVersion: 1,
          scope: {
            appPackage: normalized.appPackage,
            taskGoal: normalized.taskGoalSummary,
            stateId: normalized.stateId,
            stepId: normalized.stepId,
            moduleId: normalized.moduleId
          },
          diagnosis: { failureClass: normalized.failureClass, disposition },
          recovery: { failedPolicyIds: failedRecoveryPolicyIds },
          verification: existing?.experience.verification ?? { status: 'unverified', successCount: 0 },
          confidence: experienceConfidence(normalized.failureClass, occurrenceCount)
        },
        status: existing?.status ?? 'active',
        firstSeenAt: existing?.firstSeenAt ?? timestamp,
        lastSeenAt: timestamp
      }
      await this.storage.saveFingerprints([
        fingerprint,
        ...fingerprints.filter((candidate) => candidate.id !== fingerprint.id)
      ])
      return fingerprint
    })
  }

  async disable(id: string): Promise<RpaFailureFingerprint> {
    return this.enqueue(async () => {
      const fingerprints = sanitizeRpaFailureFingerprints(await this.storage.loadFingerprints())
      const existing = fingerprints.find((fingerprint) => fingerprint.id === id)
      if (!existing) throw new Error(`RPA failure fingerprint not found: ${id}`)
      const updated = { ...existing, status: 'disabled' as const, lastSeenAt: this.now() }
      await this.storage.saveFingerprints([updated, ...fingerprints.filter((item) => item.id !== id)])
      return updated
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export function sanitizeRpaFailureFingerprints(value: unknown): RpaFailureFingerprint[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const failureClass = RPA_FAILURE_CLASSES.includes(candidate.failureClass as RpaFailureClass)
      ? (candidate.failureClass as RpaFailureClass)
      : undefined
    if (!failureClass || typeof candidate.id !== 'string' || typeof candidate.key !== 'string') return []
    const firstSeenAt = timestamp(candidate.firstSeenAt)
    const occurrenceCount = positiveInteger(candidate.occurrenceCount)
    const failedRecoveryPolicyIds = uniqueStrings(candidate.failedRecoveryPolicyIds)
    const disposition = ['retry_bounded', 'skip_failed_policy', 'human_required'].includes(
      String(candidate.disposition)
    )
      ? (candidate.disposition as RpaFailureFingerprint['disposition'])
      : resolveDisposition(failureClass, occurrenceCount, failedRecoveryPolicyIds)
    return [
      {
        id: candidate.id,
        key: candidate.key,
        failureClass,
        appPackage: optionalText(candidate.appPackage),
        taskGoalSummary: redactRpaKnowledgeText(candidate.taskGoalSummary, 500).text,
        stateId: optionalText(candidate.stateId),
        stepId: optionalText(candidate.stepId),
        moduleId: optionalText(candidate.moduleId),
        failedRecoveryPolicyIds,
        sourceRunIds: uniqueStrings(candidate.sourceRunIds),
        sourceDeviceRunIds: uniqueStrings(candidate.sourceDeviceRunIds),
        evidenceArtifactIds: uniqueStrings(candidate.evidenceArtifactIds),
        occurrenceCount,
        disposition,
        experience: sanitizeStructuredExperience(candidate.experience, {
          failureClass,
          appPackage: optionalText(candidate.appPackage),
          taskGoal: redactRpaKnowledgeText(candidate.taskGoalSummary, 500).text,
          stateId: optionalText(candidate.stateId),
          stepId: optionalText(candidate.stepId),
          moduleId: optionalText(candidate.moduleId),
          failedPolicyIds: failedRecoveryPolicyIds,
          disposition,
          occurrenceCount
        }),
        status: candidate.status === 'disabled' ? 'disabled' : 'active',
        firstSeenAt,
        lastSeenAt: Math.max(firstSeenAt, timestamp(candidate.lastSeenAt))
      }
    ]
  })
}

function sanitizeStructuredExperience(
  value: unknown,
  fallback: {
    failureClass: RpaFailureClass
    appPackage?: string
    taskGoal: string
    stateId?: string
    stepId?: string
    moduleId?: string
    failedPolicyIds: string[]
    disposition: RpaFailureFingerprint['disposition']
    occurrenceCount: number
  }
): RpaStructuredFailureExperience {
  const source = isRecord(value) ? value : {}
  const verification = isRecord(source.verification) ? source.verification : {}
  const status = verification.status === 'verified' ? 'verified' : 'unverified'
  const successCount = nonNegativeInteger(verification.successCount)
  const lastVerifiedAt =
    status === 'verified' && verification.lastVerifiedAt !== undefined
      ? timestamp(verification.lastVerifiedAt)
      : undefined
  return {
    schemaVersion: 1,
    scope: {
      appPackage: fallback.appPackage,
      taskGoal: fallback.taskGoal,
      stateId: fallback.stateId,
      stepId: fallback.stepId,
      moduleId: fallback.moduleId
    },
    diagnosis: { failureClass: fallback.failureClass, disposition: fallback.disposition },
    recovery: { failedPolicyIds: fallback.failedPolicyIds },
    verification: { status, successCount, lastVerifiedAt },
    confidence: clampConfidence(
      source.confidence,
      experienceConfidence(fallback.failureClass, fallback.occurrenceCount)
    )
  }
}

function normalizeInput(input: UpsertRpaFailureFingerprintInput) {
  return {
    ...input,
    appPackage: optionalText(input.appPackage),
    taskGoalSummary: redactRpaKnowledgeText(input.taskGoal, 500).text,
    stateId: optionalText(input.stateId),
    stepId: optionalText(input.stepId),
    moduleId: optionalText(input.moduleId),
    failedRecoveryPolicyIds: uniqueStrings(input.failedRecoveryPolicyIds),
    evidenceArtifactIds: uniqueStrings(input.evidenceArtifactIds),
    sourceRunId: requireText(input.sourceRunId, 'sourceRunId'),
    sourceDeviceRunId: requireText(input.sourceDeviceRunId, 'sourceDeviceRunId')
  }
}

function fingerprintKey(input: ReturnType<typeof normalizeInput>): string {
  return [
    input.failureClass,
    input.appPackage ?? '*',
    normalizeForMatch(input.taskGoalSummary),
    input.stateId ?? '*',
    input.moduleId ?? '*'
  ].join('|')
}

function resolveDisposition(
  failureClass: RpaFailureClass,
  occurrenceCount: number,
  failedPolicyIds: string[]
): RpaFailureFingerprint['disposition'] {
  if (['LOGIN_REQUIRED', 'CAPTCHA_REQUIRED', 'PAYMENT_REQUIRED', 'ACCOUNT_SECURITY_REQUIRED'].includes(failureClass)) {
    return 'human_required'
  }
  if (occurrenceCount >= 2 && failedPolicyIds.length) return 'skip_failed_policy'
  return 'retry_bounded'
}

function experienceConfidence(failureClass: RpaFailureClass, occurrenceCount: number): number {
  if (['LOGIN_REQUIRED', 'CAPTCHA_REQUIRED', 'PAYMENT_REQUIRED', 'ACCOUNT_SECURITY_REQUIRED'].includes(failureClass)) {
    return 0.98
  }
  if (occurrenceCount >= 3) return 0.9
  if (occurrenceCount >= 2) return 0.75
  return 0.55
}

function normalizeForMatch(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, '')
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()))
  ].filter(Boolean)
}

function requireText(value: unknown, label: string): string {
  const normalized = optionalText(value)
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function clampConfidence(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function simpleHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export const rpaFailureFingerprintRepository = new RpaFailureFingerprintRepository()
