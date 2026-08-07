import { loggerService } from '@logger'

import type { RpaAppPlaybookLearningResult } from './RpaAppPlaybookLearningService'
import type { RpaExecutionTargetSelection } from './RpaExecutionTarget'
import type { RpaRunContextSnapshot } from './RpaRunContextSnapshot'
import { trySanitizeRpaRunContextSnapshot } from './RpaRunContextSnapshot'
import type { RpaRunStepEvent, RpaTask } from './RpaTypes'

const logger = loggerService.withContext('RpaRunStorage')
const MAX_PERSISTED_DEPTH = 12
const MAX_PERSISTED_OBJECT_KEYS = 256
const MAX_PERSISTED_ARRAY_ITEMS = 2_000
const MAX_PERSISTED_STRING_LENGTH = 16_384
const OMITTED_BINARY_PREFIX = '[BINARY_OMITTED'
const OMITTED_TEXT_PREFIX = '[TEXT_OMITTED'

export type RpaDeviceRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'needs_human'

export type RpaBatchRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface RpaTaskFlowLearningResult {
  status: 'created' | 'versioned' | 'already_applied' | 'skipped_version_conflict' | 'skipped_validation_failed'
  templateId?: string
  sourceVersion?: number
  appliedVersion?: number
  usedCorrection: boolean
  validationIssues?: string[]
}

export interface RpaTraceAnalysisRecord {
  runId: string
  deviceRunId: string
  summary: string
  failureClass?: string
  confidence: number
  stateIds: string[]
  transitions: string[]
  locatorHints: string[]
  assertionHints: string[]
  evidenceArtifactIds: string[]
  failureFingerprintId?: string
  taskFlowLearning?: RpaTaskFlowLearningResult
  appPlaybookLearning?: RpaAppPlaybookLearningResult
  /** Historical proposal references are retained for replay compatibility. */
  improvementProposalIds: string[]
  redactions: string[]
  analyzedAt: number
}

export interface RpaDeviceRunRecord {
  id: string
  batchRunId: string
  taskId: string
  deviceId: string
  status: RpaDeviceRunStatus
  currentStepId?: string
  error?: string
  events: RpaRunStepEvent[]
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  traceAnalysis?: RpaTraceAnalysisRecord
}

export interface RpaBatchRunRecord {
  id: string
  task: RpaTask
  deviceIds: string[]
  status: RpaBatchRunStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  deviceRuns: RpaDeviceRunRecord[]
  targetSelection?: RpaExecutionTargetSelection
  contextSnapshot?: RpaRunContextSnapshot
}

export interface RpaRunStorage {
  loadBatchRuns(): Promise<RpaBatchRunRecord[]>
  saveBatchRuns(runs: RpaBatchRunRecord[]): Promise<void>
}

const RPA_RUN_STORAGE_KEY = 'rpa_batch_runs'

export function sanitizeRpaBatchRunsForStorage(runs: RpaBatchRunRecord[]): RpaBatchRunRecord[] {
  return sanitizePersistedValue(Array.isArray(runs) ? runs : [], 0, []) as RpaBatchRunRecord[]
}

export class LocalStorageRpaRunStorage implements RpaRunStorage {
  async loadBatchRuns(): Promise<RpaBatchRunRecord[]> {
    if (typeof localStorage === 'undefined') return []

    try {
      const stored = localStorage.getItem(RPA_RUN_STORAGE_KEY)
      if (!stored) return []
      const runs = JSON.parse(stored) as RpaBatchRunRecord[]
      return Array.isArray(runs) ? runs.map(normalizeInterruptedRun) : []
    } catch (error) {
      logger.warn('Failed to load RPA runs from storage', { error })
      return []
    }
  }

  async saveBatchRuns(runs: RpaBatchRunRecord[]): Promise<void> {
    if (typeof localStorage === 'undefined') return

    try {
      localStorage.setItem(RPA_RUN_STORAGE_KEY, JSON.stringify(sanitizeRpaBatchRunsForStorage(runs)))
    } catch (error) {
      logger.warn('Failed to save RPA runs to storage', { error })
    }
  }
}

function normalizeInterruptedRun(run: RpaBatchRunRecord): RpaBatchRunRecord {
  const deviceRuns = run.deviceRuns.map((deviceRun) => {
    if (deviceRun.status !== 'running') return deviceRun
    return {
      ...deviceRun,
      status: 'paused' as const,
      error: 'Run was interrupted before completion',
      updatedAt: Date.now()
    }
  })

  if (run.status !== 'running') {
    return { ...run, deviceRuns, contextSnapshot: trySanitizeRpaRunContextSnapshot(run.contextSnapshot) }
  }

  return {
    ...run,
    status: 'paused',
    deviceRuns,
    contextSnapshot: trySanitizeRpaRunContextSnapshot(run.contextSnapshot),
    updatedAt: Date.now()
  }
}

export class IpcRpaRunStorage implements RpaRunStorage {
  constructor(private readonly fallback: RpaRunStorage = new LocalStorageRpaRunStorage()) {}

  async loadBatchRuns(): Promise<RpaBatchRunRecord[]> {
    if (!window.api?.rpa) {
      return this.fallback.loadBatchRuns()
    }

    try {
      const runs = (await window.api.rpa.loadRuns()) as RpaBatchRunRecord[]
      return Array.isArray(runs) ? runs.map(normalizeInterruptedRun) : []
    } catch (error) {
      logger.warn('Failed to load RPA runs through IPC', { error })
      return this.fallback.loadBatchRuns()
    }
  }

  async saveBatchRuns(runs: RpaBatchRunRecord[]): Promise<void> {
    if (!window.api?.rpa) {
      await this.fallback.saveBatchRuns(runs)
      return
    }

    try {
      await window.api.rpa.saveRuns(sanitizeRpaBatchRunsForStorage(runs))
    } catch (error) {
      logger.warn('Failed to save RPA runs through IPC', { error })
      await this.fallback.saveBatchRuns(runs)
    }
  }
}

export const localStorageRpaRunStorage = new LocalStorageRpaRunStorage()
export const ipcRpaRunStorage = new IpcRpaRunStorage(localStorageRpaRunStorage)

function sanitizePersistedValue(value: unknown, depth: number, path: string[]): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value

  if (typeof value === 'string') {
    const key = path.at(-1)?.toLocaleLowerCase() ?? ''
    if (isBinaryPayloadKey(key)) return `${OMITTED_BINARY_PREFIX}:${value.length}]`
    if (key === 'xml' && path.some((part) => part.toLocaleLowerCase() === 'uitree')) {
      return `${OMITTED_TEXT_PREFIX}:UI_TREE_XML:${value.length}]`
    }
    if (value.length > MAX_PERSISTED_STRING_LENGTH) {
      return `${value.slice(0, MAX_PERSISTED_STRING_LENGTH)}\n${OMITTED_TEXT_PREFIX}:${value.length - MAX_PERSISTED_STRING_LENGTH}]`
    }
    return value
  }

  if (depth >= MAX_PERSISTED_DEPTH) return '[DEPTH_LIMIT_REACHED]'

  if (Array.isArray(value)) {
    const omittedCollection = summarizeObservationCollection(path, value.length)
    if (omittedCollection) return omittedCollection
    const items = value
      .slice(0, MAX_PERSISTED_ARRAY_ITEMS)
      .map((item, index) => sanitizePersistedValue(item, depth + 1, [...path, String(index)]))
    if (value.length > MAX_PERSISTED_ARRAY_ITEMS) {
      items.push(`[ARRAY_ITEMS_OMITTED:${value.length - MAX_PERSISTED_ARRAY_ITEMS}]`)
    }
    return items
  }

  if (typeof value !== 'object') return String(value)

  const entries = Object.entries(value as Record<string, unknown>)
  const output: Record<string, unknown> = {}
  for (const [key, nested] of entries.slice(0, MAX_PERSISTED_OBJECT_KEYS)) {
    output[key] = sanitizePersistedValue(nested, depth + 1, [...path, key])
  }
  if (entries.length > MAX_PERSISTED_OBJECT_KEYS) {
    output.__omittedObjectKeys = entries.length - MAX_PERSISTED_OBJECT_KEYS
  }
  return output
}

function isBinaryPayloadKey(key: string): boolean {
  return key === 'imagebase64' || key === 'base64' || key === 'imagedata' || key === 'screenshotbase64'
}

function summarizeObservationCollection(path: string[], count: number): string | undefined {
  const normalized = path.map((part) => part.toLocaleLowerCase())
  const key = normalized.at(-1)
  if (key === 'textcandidates') return `[TEXT_CANDIDATES_OMITTED:${count}]`
  if (key === 'nodes' && normalized.includes('uitree')) return `[UI_TREE_NODES_OMITTED:${count}]`
  if (key === 'texts' && normalized.includes('uitree')) return `[UI_TREE_TEXTS_OMITTED:${count}]`
  if (key === 'blocks' && normalized.includes('ocr')) return `[OCR_BLOCKS_OMITTED:${count}]`
  return undefined
}
