import { loggerService } from '@logger'
import { type DeviceInfo, deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'

import type { RpaExecutionTargetSelection } from './RpaExecutionTarget'
import {
  type RpaRunContextSnapshot,
  sanitizeRpaRunContextSnapshot,
  trySanitizeRpaRunContextSnapshot
} from './RpaRunContextSnapshot'
import {
  ipcRpaRunStorage,
  type RpaBatchRunRecord,
  type RpaRunStorage,
  type RpaTraceAnalysisRecord
} from './RpaRunStorage'
import { type RpaSafetyPolicyEngine, rpaSafetyPolicyEngine } from './RpaSafetyPolicyEngine'
import type { RpaRunResult, RpaRunStepEvent, RpaSafetyApproval, RpaTask } from './RpaTypes'

const logger = loggerService.withContext('RpaBatchRunner')

type Listener = () => void

export interface RpaBatchRunnerOptions {
  storage?: RpaRunStorage
  executorFactory?: (
    onEvent: (event: RpaRunStepEvent) => void,
    context: { safetyApproval?: RpaSafetyApproval }
  ) => RpaTaskExecutorLike
  now?: () => number
  safetyPolicyEngine?: RpaSafetyPolicyEngine
  traceLearningService?: RpaTraceLearningServiceLike
  deviceScanner?: () => Promise<DeviceInfo[]>
  deviceMonitorIntervalMs?: number
}

export interface RpaTaskExecutorLike {
  run(input: unknown, deviceId: string, signal?: AbortSignal): Promise<RpaRunResult>
}

export interface RpaTraceLearningServiceLike {
  analyzeDeviceRun(run: RpaBatchRunRecord, deviceRunId: string): Promise<RpaTraceAnalysisRecord>
}

export interface StartRpaBatchRunInput {
  task: RpaTask
  deviceIds?: string[]
  safetyApproval?: RpaSafetyApproval
  targetSelection?: RpaExecutionTargetSelection
  contextSnapshot?: RpaRunContextSnapshot
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export class RpaBatchRunner {
  private runs: RpaBatchRunRecord[] = []
  private readonly listeners = new Set<Listener>()
  private readonly pausedDeviceRuns = new Set<string>()
  private readonly cancelledDeviceRuns = new Set<string>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly safetyApprovals = new Map<string, RpaSafetyApproval>()
  private detectedDevices: DeviceInfo[] = []
  private deviceStatusSnapshotReady = false
  private deviceMonitorTimer?: ReturnType<typeof setInterval>
  private deviceRefreshPromise?: Promise<DeviceInfo[]>
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

  getDetectedDevices(): DeviceInfo[] {
    return this.detectedDevices.map((device) => ({ ...device }))
  }

  hasDeviceStatusSnapshot(): boolean {
    return this.deviceStatusSnapshotReady
  }

  async refreshDeviceStatuses(): Promise<DeviceInfo[]> {
    if (this.deviceRefreshPromise) return this.deviceRefreshPromise
    this.deviceRefreshPromise = this.performDeviceStatusRefresh().finally(() => {
      this.deviceRefreshPromise = undefined
    })
    return this.deviceRefreshPromise
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
      })),
      targetSelection: input.targetSelection ? cloneTargetSelection(input.targetSelection) : undefined,
      contextSnapshot: input.contextSnapshot ? sanitizeRpaRunContextSnapshot(input.contextSnapshot) : undefined
    }
    run.deviceRuns = run.deviceRuns.map((deviceRun) => ({ ...deviceRun, batchRunId: run.id }))
    if (input.safetyApproval) this.safetyApprovals.set(run.id, input.safetyApproval)

    this.runs = [run, ...this.runs].slice(0, 100)
    await this.persistAndEmit()
    this.ensureDeviceMonitor()

    for (const deviceRun of run.deviceRuns) {
      void this.runDevice(run.id, deviceRun.id)
    }

    return run
  }

  async pauseDeviceRun(deviceRunId: string, reason?: string): Promise<boolean> {
    await this.initialize()
    const deviceRun = this.findDeviceRun(deviceRunId)
    if (!deviceRun || isTerminalStatus(deviceRun.status)) return false

    this.pausedDeviceRuns.add(deviceRunId)
    this.controllers.get(deviceRunId)?.abort(new Error(reason ?? 'RPA device run paused'))
    deviceRun.status = 'paused'
    deviceRun.error = reason
    deviceRun.finishedAt = undefined
    deviceRun.updatedAt = this.now()
    await this.refreshParentStatus(deviceRun.batchRunId)
    await this.persistAndEmit()
    this.reconcileDeviceMonitor()
    return true
  }

  async resumeDeviceRun(deviceRunId: string, safetyApproval?: RpaSafetyApproval): Promise<boolean> {
    await this.initialize()
    const run = this.findBatchRunByDeviceRunId(deviceRunId)
    const deviceRun = this.findDeviceRun(deviceRunId)
    if (!run || !deviceRun || (deviceRun.status !== 'paused' && deviceRun.status !== 'needs_human')) return false

    if (safetyApproval) this.safetyApprovals.set(run.id, safetyApproval)
    this.pausedDeviceRuns.delete(deviceRunId)
    deviceRun.status = 'pending'
    deviceRun.error = undefined
    deviceRun.finishedAt = undefined
    deviceRun.updatedAt = this.now()
    await this.refreshParentStatus(run.id)
    await this.persistAndEmit()
    this.ensureDeviceMonitor()
    void this.runDevice(run.id, deviceRunId)
    return true
  }

  async cancelDeviceRun(deviceRunId: string): Promise<boolean> {
    await this.initialize()
    const deviceRun = this.findDeviceRun(deviceRunId)
    if (!deviceRun || isTerminalStatus(deviceRun.status)) return false

    this.cancelledDeviceRuns.add(deviceRunId)
    this.controllers.get(deviceRunId)?.abort(new Error('RPA device run cancelled'))
    deviceRun.status = 'cancelled'
    deviceRun.finishedAt = this.now()
    deviceRun.updatedAt = deviceRun.finishedAt
    await this.refreshParentStatus(deviceRun.batchRunId)
    await this.persistAndEmit()
    this.reconcileDeviceMonitor()
    return true
  }

  async cancelBatchRun(batchRunId: string): Promise<boolean> {
    await this.initialize()
    const run = this.runs.find((item) => item.id === batchRunId)
    if (!run || isTerminalBatchStatus(run.status)) return false

    for (const deviceRun of run.deviceRuns) {
      if (!isTerminalStatus(deviceRun.status)) {
        this.cancelledDeviceRuns.add(deviceRun.id)
        this.controllers.get(deviceRun.id)?.abort(new Error('RPA batch run cancelled'))
        deviceRun.status = 'cancelled'
        deviceRun.finishedAt = this.now()
        deviceRun.updatedAt = deviceRun.finishedAt
      }
    }
    run.status = 'cancelled'
    run.finishedAt = this.now()
    run.updatedAt = run.finishedAt
    await this.persistAndEmit()
    this.reconcileDeviceMonitor()
    return true
  }

  async retryBatchRun(batchRunId: string): Promise<RpaBatchRunRecord | undefined> {
    await this.initialize()
    const run = this.runs.find((item) => item.id === batchRunId)
    if (!run || (run.status !== 'failed' && run.status !== 'cancelled')) return undefined

    return this.start({
      task: run.task,
      deviceIds: run.deviceIds,
      safetyApproval: this.safetyApprovals.get(run.id),
      targetSelection: run.targetSelection,
      contextSnapshot: run.contextSnapshot
    })
  }

  async emergencyStop(): Promise<number> {
    await this.initialize()
    let cancelled = 0
    const stoppedAt = this.now()
    for (const run of this.runs) {
      for (const deviceRun of run.deviceRuns) {
        if (isTerminalStatus(deviceRun.status)) continue
        cancelled += 1
        this.cancelledDeviceRuns.add(deviceRun.id)
        this.controllers.get(deviceRun.id)?.abort(new Error('RPA emergency stop'))
        deviceRun.status = 'cancelled'
        deviceRun.error = 'Stopped by emergency stop'
        deviceRun.finishedAt = stoppedAt
        deviceRun.updatedAt = stoppedAt
      }
      if (run.deviceRuns.some((deviceRun) => deviceRun.status === 'cancelled')) {
        run.status = 'cancelled'
        run.finishedAt = stoppedAt
        run.updatedAt = stoppedAt
      }
    }
    await this.persistAndEmit()
    return cancelled
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

      const controller = new AbortController()
      this.controllers.set(deviceRun.id, controller)
      const executor = await this.createExecutor((event) => {
        this.recordEvent(deviceRun.id, event)
      }, this.safetyApprovals.get(run.id))
      const result = await executor.run(run.task, deviceRun.deviceId, controller.signal)
      this.applyRunResult(deviceRun, result)
    } catch (error) {
      if (this.cancelledDeviceRuns.has(deviceRun.id)) {
        deviceRun.status = 'cancelled'
      } else if (this.pausedDeviceRuns.has(deviceRun.id)) {
        deviceRun.status = 'paused'
        deviceRun.finishedAt = undefined
      } else {
        logger.error('RPA device run failed', { error, batchRunId, deviceRunId, deviceId: deviceRun.deviceId })
        deviceRun.status = 'failed'
        deviceRun.error = error instanceof Error ? error.message : String(error)
        deviceRun.finishedAt = this.now()
      }
      deviceRun.updatedAt = this.now()
    } finally {
      this.controllers.delete(deviceRunId)
      await this.refreshParentStatus(batchRunId)
      await this.analyzeDeviceRun(run, deviceRun)
      await this.persistAndEmit()
      this.reconcileDeviceMonitor()
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
      deviceRun.events = result.events
      deviceRun.finishedAt = undefined
      deviceRun.updatedAt = this.now()
      return
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

  private async createExecutor(
    onEvent: (event: RpaRunStepEvent) => void,
    safetyApproval?: RpaSafetyApproval
  ): Promise<RpaTaskExecutorLike> {
    if (this.options.executorFactory) {
      return this.options.executorFactory(onEvent, { safetyApproval })
    }

    const [{ RpaTaskExecutor }, { defaultRpaModuleRegistry }, { rpaDeviceRuntime }] = await Promise.all([
      import('./RpaTaskExecutor'),
      import('./RpaDefaultRegistry'),
      import('./RpaDeviceActionRuntimeAdapter')
    ])

    return new RpaTaskExecutor({
      registry: defaultRpaModuleRegistry,
      runtime: rpaDeviceRuntime,
      safetyPolicyEngine: this.options.safetyPolicyEngine ?? rpaSafetyPolicyEngine,
      safetyApproval,
      onEvent
    })
  }

  private async analyzeDeviceRun(
    run: RpaBatchRunRecord,
    deviceRun: RpaBatchRunRecord['deviceRuns'][number]
  ): Promise<void> {
    if (!['completed', 'failed', 'needs_human'].includes(deviceRun.status)) return
    try {
      const service =
        this.options.traceLearningService ?? (await import('./RpaTraceLearningService')).rpaTraceLearningService
      deviceRun.traceAnalysis = await service.analyzeDeviceRun(snapshotRuns([run])[0], deviceRun.id)
      deviceRun.updatedAt = this.now()
    } catch (error) {
      logger.warn('RPA trace learning failed without affecting the run result', {
        error,
        runId: run.id,
        deviceRunId: deviceRun.id
      })
    }
  }

  private ensureDeviceMonitor(): void {
    if (this.deviceMonitorTimer || (this.options.executorFactory && !this.options.deviceScanner)) return
    void this.refreshDeviceStatuses()
    const intervalMs = this.options.deviceMonitorIntervalMs ?? 3000
    if (intervalMs <= 0) return
    this.deviceMonitorTimer = setInterval(() => void this.refreshDeviceStatuses(), intervalMs)
  }

  private reconcileDeviceMonitor(): void {
    const hasActiveDeviceRuns = this.runs.some((run) =>
      run.deviceRuns.some((deviceRun) => deviceRun.status === 'pending' || deviceRun.status === 'running')
    )
    if (hasActiveDeviceRuns || !this.deviceMonitorTimer) return
    clearInterval(this.deviceMonitorTimer)
    this.deviceMonitorTimer = undefined
  }

  private async performDeviceStatusRefresh(): Promise<DeviceInfo[]> {
    try {
      const devices = await (this.options.deviceScanner ?? (() => deviceServiceProxy.scanDevices()))()
      this.detectedDevices = devices.map((device) => ({ ...device }))
      this.deviceStatusSnapshotReady = true
      const deviceById = new Map(devices.map((device) => [device.id, device]))
      const activeDeviceRuns = this.runs.flatMap((run) =>
        run.deviceRuns.filter((deviceRun) => deviceRun.status === 'pending' || deviceRun.status === 'running')
      )
      for (const deviceRun of activeDeviceRuns) {
        const device = deviceById.get(deviceRun.deviceId)
        if (device?.status === 'online') continue
        const reason =
          device?.status === 'unauthorized'
            ? `Device unauthorized during RPA execution: ${deviceRun.deviceId}`
            : `Device offline during RPA execution: ${deviceRun.deviceId}`
        await this.pauseDeviceRun(deviceRun.id, reason)
      }
      this.emit()
      return this.getDetectedDevices()
    } catch (error) {
      logger.warn('Failed to refresh RPA device statuses', { error })
      return this.getDetectedDevices()
    }
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
      events: [...deviceRun.events],
      traceAnalysis: deviceRun.traceAnalysis
        ? {
            ...deviceRun.traceAnalysis,
            stateIds: [...deviceRun.traceAnalysis.stateIds],
            transitions: [...deviceRun.traceAnalysis.transitions],
            locatorHints: [...deviceRun.traceAnalysis.locatorHints],
            assertionHints: [...deviceRun.traceAnalysis.assertionHints],
            evidenceArtifactIds: [...deviceRun.traceAnalysis.evidenceArtifactIds],
            taskFlowLearning: deviceRun.traceAnalysis.taskFlowLearning
              ? {
                  ...deviceRun.traceAnalysis.taskFlowLearning,
                  validationIssues: [...(deviceRun.traceAnalysis.taskFlowLearning.validationIssues ?? [])]
                }
              : undefined,
            improvementProposalIds: [...deviceRun.traceAnalysis.improvementProposalIds],
            redactions: [...deviceRun.traceAnalysis.redactions]
          }
        : undefined
    })),
    targetSelection: run.targetSelection ? cloneTargetSelection(run.targetSelection) : undefined,
    contextSnapshot: trySanitizeRpaRunContextSnapshot(run.contextSnapshot)
  }))
}

function cloneTargetSelection(selection: RpaExecutionTargetSelection): RpaExecutionTargetSelection {
  return {
    ...selection,
    groupIds: [...selection.groupIds],
    includedDeviceIds: [...selection.includedDeviceIds],
    excludedDeviceIds: [...selection.excludedDeviceIds],
    deviceIds: [...selection.deviceIds],
    unavailableDeviceIds: [...selection.unavailableDeviceIds],
    partialGroupIds: [...selection.partialGroupIds],
    emptyGroupIds: [...selection.emptyGroupIds]
  }
}

function isTerminalStatus(status: RpaBatchRunRecord['deviceRuns'][number]['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function isTerminalBatchStatus(status: RpaBatchRunRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export const rpaBatchRunner = new RpaBatchRunner()
