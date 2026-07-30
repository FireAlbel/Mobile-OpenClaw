import { loggerService } from '@logger'

import type { RpaExecutionTargetSelection } from './RpaExecutionTarget'
import type { RpaRunContextSnapshot } from './RpaRunContextSnapshot'
import { trySanitizeRpaRunContextSnapshot } from './RpaRunContextSnapshot'
import type { RpaRunStepEvent, RpaTask } from './RpaTypes'

const logger = loggerService.withContext('RpaRunStorage')

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
      localStorage.setItem(RPA_RUN_STORAGE_KEY, JSON.stringify(runs))
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
      await window.api.rpa.saveRuns(runs)
    } catch (error) {
      logger.warn('Failed to save RPA runs through IPC', { error })
      await this.fallback.saveBatchRuns(runs)
    }
  }
}

export const localStorageRpaRunStorage = new LocalStorageRpaRunStorage()
export const ipcRpaRunStorage = new IpcRpaRunStorage(localStorageRpaRunStorage)
