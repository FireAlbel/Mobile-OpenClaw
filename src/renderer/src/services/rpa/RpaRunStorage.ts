import { loggerService } from '@logger'

import type { RpaRunStepEvent, RpaTask } from './RpaTypes'

const logger = loggerService.withContext('RpaRunStorage')

export type RpaDeviceRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'needs_human'

export type RpaBatchRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

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
    return { ...run, deviceRuns }
  }

  return {
    ...run,
    status: 'paused',
    deviceRuns,
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
