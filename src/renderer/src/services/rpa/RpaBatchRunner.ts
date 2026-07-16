import { loggerService } from '@logger'

import { ipcRpaRunStorage, type RpaBatchRunRecord, type RpaRunStorage } from './RpaRunStorage'
import type { RpaRunResult, RpaRunStepEvent, RpaTask } from './RpaTypes'

const logger = loggerService.withContext('RpaBatchRunner')

type Listener = () => void

export interface RpaBatchRunnerOptions {
  storage?: RpaRunStorage
  executorFactory?: (onEvent: (event: RpaRunStepEvent) => void) => RpaTaskExecutorLike
  now?: () => number
}

export interface RpaTaskExecutorLike {
  run(input: unknown, deviceId: string): Promise<RpaRunResult>
}

export interface StartRpaBatchRunInput {
  task: RpaTask
  deviceIds?: string[]
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export class RpaBatchRunner {
  private runs: RpaBatchRunRecord[] = []
  private readonly listeners = new Set<Listener>()
  private readonly pausedDeviceRuns = new Set<string>()
  private readonly cancelledDeviceRuns = new Set<string>()
  private persistenceQueue: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(private readonly options: RpaBatchRunnerOptions = {}) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async initialize(): Promise<void> {
    if (this.loaded) return
    this.runs = await this.storage.loadBatchRuns()
    this.loaded = true
    this.emit()
  }

  getRuns(): RpaBatchRunRecord[] {
    return snapshotRuns(this.runs).sort((a, b) => b.createdAt - a.createdAt)
  }

  async start(input: StartRpaBatchRunInput): Promise<RpaBatchRunRecord> {
    await this.initialize()

    const deviceIds = input.deviceIds?.length ? input.deviceIds : input.task.deviceIds
    if (deviceIds.length === 0) {
      throw new Error('At least one device is required')
    }

    const now = this.now()
    const run: RpaBatchRunRecord = {
      id: createId('rpa-batch'),
      task: { ...input.task, deviceIds },
      deviceIds,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      deviceRuns: deviceIds.map((deviceId) => ({
        id: createId('rpa-device-run'),
        batchRunId: '',
        taskId: input.task.id,
        deviceId,
        status: 'pending',
        events: [],
        createdAt: now,
        updatedAt: now
      }))
    }
    run.deviceRuns = run.deviceRuns.map((deviceRun) => ({ ...deviceRun, batchRunId: run.id }))

    this.runs = [run, ...this.runs].slice(0, 100)
    await this.persistAndEmit()

    for (const deviceRun of run.deviceRuns) {
      void this.runDevice(run.id, deviceRun.id)
    }

    return run
  }

  async pauseDeviceRun(deviceRunId: string): Promise<boolean> {
    await this.initialize()
    const deviceRun = this.findDeviceRun(deviceRunId)
    if (!deviceRun || isTerminalStatus(deviceRun.status)) return false

    this.pausedDeviceRuns.add(deviceRunId)
    deviceRun.status = 'paused'
    deviceRun.updatedAt = this.now()
    await this.refreshParentStatus(deviceRun.batchRunId)
    await this.persistAndEmit()
    return true
  }

  async resumeDeviceRun(deviceRunId: string): Promise<boolean> {
    await this.initialize()
    const run = this.findBatchRunByDeviceRunId(deviceRunId)
    const deviceRun = this.findDeviceRun(deviceRunId)
    if (!run || !deviceRun || (deviceRun.status !== 'paused' && deviceRun.status !== 'needs_human')) return false

    this.pausedDeviceRuns.delete(deviceRunId)
    deviceRun.status = 'pending'
    deviceRun.error = undefined
    deviceRun.finishedAt = undefined
    deviceRun.updatedAt = this.now()
    await this.refreshParentStatus(run.id)
    await this.persistAndEmit()
    void this.runDevice(run.id, deviceRunId)
    return true
  }

  async cancelDeviceRun(deviceRunId: string): Promise<boolean> {
    await this.initialize()
    const deviceRun = this.findDeviceRun(deviceRunId)
    if (!deviceRun || isTerminalStatus(deviceRun.status)) return false

    this.cancelledDeviceRuns.add(deviceRunId)
    deviceRun.status = 'cancelled'
    deviceRun.finishedAt = this.now()
    deviceRun.updatedAt = deviceRun.finishedAt
    await this.refreshParentStatus(deviceRun.batchRunId)
    await this.persistAndEmit()
    return true
  }

  async cancelBatchRun(batchRunId: string): Promise<boolean> {
    await this.initialize()
    const run = this.runs.find((item) => item.id === batchRunId)
    if (!run || isTerminalBatchStatus(run.status)) return false

    for (const deviceRun of run.deviceRuns) {
      if (!isTerminalStatus(deviceRun.status)) {
        this.cancelledDeviceRuns.add(deviceRun.id)
        deviceRun.status = 'cancelled'
        deviceRun.finishedAt = this.now()
        deviceRun.updatedAt = deviceRun.finishedAt
      }
    }
    run.status = 'cancelled'
    run.finishedAt = this.now()
    run.updatedAt = run.finishedAt
    await this.persistAndEmit()
    return true
  }

  private async runDevice(batchRunId: string, deviceRunId: string): Promise<void> {
    const run = this.runs.find((item) => item.id === batchRunId)
    const deviceRun = run?.deviceRuns.find((item) => item.id === deviceRunId)
    if (!run || !deviceRun || deviceRun.status !== 'pending') return

    deviceRun.status = 'running'
    deviceRun.startedAt ??= this.now()
    deviceRun.updatedAt = this.now()
    run.status = 'running'
    run.startedAt ??= this.now()
    run.updatedAt = this.now()
    await this.persistAndEmit()

    try {
      if (this.cancelledDeviceRuns.has(deviceRun.id)) return
      if (this.pausedDeviceRuns.has(deviceRun.id)) {
        deviceRun.status = 'paused'
        return
      }

      const executor = await this.createExecutor((event) => {
        this.recordEvent(deviceRun.id, event)
      })
      const result = await executor.run(run.task, deviceRun.deviceId)
      this.applyRunResult(deviceRun, result)
    } catch (error) {
      logger.error('RPA device run failed', { error, batchRunId, deviceRunId, deviceId: deviceRun.deviceId })
      deviceRun.status = 'failed'
      deviceRun.error = error instanceof Error ? error.message : String(error)
      deviceRun.finishedAt = this.now()
      deviceRun.updatedAt = deviceRun.finishedAt
    } finally {
      await this.refreshParentStatus(batchRunId)
      await this.persistAndEmit()
    }
  }

  private recordEvent(deviceRunId: string, event: RpaRunStepEvent): void {
    const deviceRun = this.findDeviceRun(deviceRunId)
    if (!deviceRun) return

    deviceRun.events = [...deviceRun.events, event].slice(-500)
    deviceRun.currentStepId = event.stepId
    deviceRun.updatedAt = this.now()
    void this.persistAndEmit()
  }

  private applyRunResult(deviceRun: RpaBatchRunRecord['deviceRuns'][number], result: RpaRunResult): void {
    if (this.cancelledDeviceRuns.has(deviceRun.id)) {
      deviceRun.status = 'cancelled'
    } else if (this.pausedDeviceRuns.has(deviceRun.id)) {
      deviceRun.status = 'paused'
    } else {
      deviceRun.status = result.status
    }
    deviceRun.error = result.error
    deviceRun.events = result.events
    deviceRun.finishedAt = result.finishedAt
    deviceRun.updatedAt = result.finishedAt
  }

  private async refreshParentStatus(batchRunId: string): Promise<void> {
    const run = this.runs.find((item) => item.id === batchRunId)
    if (!run) return

    const statuses = run.deviceRuns.map((deviceRun) => deviceRun.status)
    if (statuses.every((status) => status === 'completed')) {
      run.status = 'completed'
      run.finishedAt = this.now()
    } else if (statuses.every((status) => status === 'cancelled')) {
      run.status = 'cancelled'
      run.finishedAt = this.now()
    } else if (statuses.some((status) => status === 'running')) {
      run.status = 'running'
    } else if (statuses.some((status) => status === 'paused' || status === 'needs_human')) {
      run.status = 'paused'
    } else if (statuses.some((status) => status === 'failed')) {
      run.status = 'failed'
      run.finishedAt = this.now()
    } else {
      run.status = 'pending'
    }
    run.updatedAt = this.now()
  }

  private findBatchRunByDeviceRunId(deviceRunId: string): RpaBatchRunRecord | undefined {
    return this.runs.find((run) => run.deviceRuns.some((deviceRun) => deviceRun.id === deviceRunId))
  }

  private findDeviceRun(deviceRunId: string): RpaBatchRunRecord['deviceRuns'][number] | undefined {
    return this.findBatchRunByDeviceRunId(deviceRunId)?.deviceRuns.find((deviceRun) => deviceRun.id === deviceRunId)
  }

  private async createExecutor(onEvent: (event: RpaRunStepEvent) => void): Promise<RpaTaskExecutorLike> {
    if (this.options.executorFactory) {
      return this.options.executorFactory(onEvent)
    }

    const [{ RpaTaskExecutor }, { defaultRpaModuleRegistry }, { rpaDeviceRuntime }] = await Promise.all([
      import('./RpaTaskExecutor'),
      import('./RpaDefaultRegistry'),
      import('./RpaDeviceActionRuntimeAdapter')
    ])

    return new RpaTaskExecutor({
      registry: defaultRpaModuleRegistry,
      runtime: rpaDeviceRuntime,
      onEvent
    })
  }

  private async persistAndEmit(): Promise<void> {
    this.emit()
    const snapshot = snapshotRuns(this.runs)
    this.persistenceQueue = this.persistenceQueue
      .catch((error) => logger.warn('Previous RPA run persistence failed', { error }))
      .then(() => this.storage.saveBatchRuns(snapshot))
    await this.persistenceQueue
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private get storage(): RpaRunStorage {
    return this.options.storage ?? ipcRpaRunStorage
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

function snapshotRuns(runs: RpaBatchRunRecord[]): RpaBatchRunRecord[] {
  return runs.map((run) => ({
    ...run,
    task: {
      ...run.task,
      deviceIds: [...run.task.deviceIds],
      steps: run.task.steps.map((step) => ({ ...step })),
      metadata: { ...run.task.metadata }
    },
    deviceIds: [...run.deviceIds],
    deviceRuns: run.deviceRuns.map((deviceRun) => ({
      ...deviceRun,
      events: [...deviceRun.events]
    }))
  }))
}

function isTerminalStatus(status: RpaBatchRunRecord['deviceRuns'][number]['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function isTerminalBatchStatus(status: RpaBatchRunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export const rpaBatchRunner = new RpaBatchRunner()
