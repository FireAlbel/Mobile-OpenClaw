import { loggerService } from '@logger'

import { deerFlowAdapter } from './DeerFlowAdapter'
import { type DeviceActionRequest, type DeviceActionResult, deviceActionRuntime } from './DeviceActionRuntime'

const logger = loggerService.withContext('DeviceTaskOrchestrator')

export type DeviceTaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'waiting_device'
  | 'cancelled'
  | 'failed'
  | 'completed'

export interface DeviceTaskStep {
  id: string
  name: string
  action: DeviceActionRequest
  verify?: DeviceActionRequest
}

export interface DeviceTaskLog {
  id: string
  taskId: string
  deviceId: string
  level: 'info' | 'warn' | 'error'
  message: string
  timestamp: number
  data?: unknown
}

export interface DeviceTask {
  id: string
  deviceId: string
  goal: string
  status: DeviceTaskStatus
  steps: DeviceTaskStep[]
  currentStepIndex: number
  priority: number
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
}

export interface EnqueueDeviceTaskInput {
  deviceId: string
  goal: string
  steps?: DeviceTaskStep[]
  priority?: number
  useDeerFlow?: boolean
}

type Listener = () => void

const TASK_STORAGE_KEY = 'device_task_orchestrator_tasks'
const LOG_STORAGE_KEY = 'device_task_orchestrator_logs'

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function buildDefaultSteps(goal: string): DeviceTaskStep[] {
  return [
    {
      id: createId('step'),
      name: 'Observe screen',
      action: { type: 'screenshot' }
    },
    {
      id: createId('step'),
      name: 'VLM action',
      action: {
        type: 'vision_instruction',
        params: { instruction: goal }
      },
      verify: { type: 'screenshot' }
    }
  ]
}

export class DeviceTaskOrchestrator {
  private tasks = new Map<string, DeviceTask>()
  private logs = new Map<string, DeviceTaskLog[]>()
  private runningDevices = new Set<string>()
  private pausedTasks = new Set<string>()
  private cancelledTasks = new Set<string>()
  private listeners = new Set<Listener>()

  constructor() {
    this.loadFromStorage()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getTasks(): DeviceTask[] {
    return [...this.tasks.values()].sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
  }

  getLogs(taskId: string): DeviceTaskLog[] {
    return this.logs.get(taskId) ?? []
  }

  enqueue(input: EnqueueDeviceTaskInput): DeviceTask {
    if (!input.deviceId.trim()) {
      throw new Error('deviceId is required')
    }
    if (!input.goal.trim()) {
      throw new Error('goal is required')
    }

    const task: DeviceTask = {
      id: createId('device-task'),
      deviceId: input.deviceId.trim(),
      goal: input.goal.trim(),
      status: 'pending',
      steps: input.steps?.length ? input.steps : buildDefaultSteps(input.goal),
      currentStepIndex: 0,
      priority: input.priority ?? 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    this.tasks.set(task.id, task)
    this.addLog(task, 'info', `Task enqueued: ${task.goal}`)
    this.saveToStorage()
    this.emit()

    if (input.useDeerFlow) {
      void this.tryAttachDeerFlowPlan(task)
    }

    void this.pumpDeviceQueue(task.deviceId)
    return task
  }

  pause(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return false
    this.pausedTasks.add(taskId)
    task.status = 'paused'
    task.updatedAt = Date.now()
    this.addLog(task, 'warn', 'Task paused')
    this.saveToStorage()
    this.emit()
    return true
  }

  resume(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'paused') return false
    this.pausedTasks.delete(taskId)
    task.status = 'pending'
    task.updatedAt = Date.now()
    this.addLog(task, 'info', 'Task resumed')
    this.saveToStorage()
    this.emit()
    void this.pumpDeviceQueue(task.deviceId)
    return true
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return false
    this.cancelledTasks.add(taskId)
    task.status = 'cancelled'
    task.finishedAt = Date.now()
    task.updatedAt = Date.now()
    this.addLog(task, 'warn', 'Task cancelled')
    this.saveToStorage()
    this.emit()
    return true
  }

  clearCompleted(): void {
    for (const [taskId, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        this.tasks.delete(taskId)
      }
    }
    this.saveToStorage()
    this.emit()
  }

  private async pumpDeviceQueue(deviceId: string): Promise<void> {
    if (this.runningDevices.has(deviceId)) return

    const nextTask = this.getTasks().find((task) => task.deviceId === deviceId && task.status === 'pending')
    if (!nextTask) return

    this.runningDevices.add(deviceId)
    try {
      await this.runTask(nextTask)
    } finally {
      this.runningDevices.delete(deviceId)
      const hasMore = this.getTasks().some((task) => task.deviceId === deviceId && task.status === 'pending')
      if (hasMore) {
        void this.pumpDeviceQueue(deviceId)
      }
    }
  }

  private async runTask(task: DeviceTask): Promise<void> {
    task.status = 'running'
    task.startedAt ??= Date.now()
    task.updatedAt = Date.now()
    this.addLog(task, 'info', 'Task started')
    this.saveToStorage()
    this.emit()

    try {
      while (task.currentStepIndex < task.steps.length) {
        if (this.cancelledTasks.has(task.id)) return
        if (this.pausedTasks.has(task.id)) {
          task.status = 'paused'
          return
        }

        const step = task.steps[task.currentStepIndex]
        this.addLog(task, 'info', `Running step: ${step.name}`, step.action)
        const result = await deviceActionRuntime.execute(task.deviceId, step.action)
        this.addActionAudit(task, step, result)
        if (!result.success) {
          throw new Error(result.message)
        }

        if (step.verify) {
          const verifyResult = await deviceActionRuntime.execute(task.deviceId, step.verify)
          this.addActionAudit(task, { ...step, name: `${step.name} verify`, action: step.verify }, verifyResult)
          if (!verifyResult.success) {
            throw new Error(`Verify failed: ${verifyResult.message}`)
          }
        }

        task.currentStepIndex += 1
        task.updatedAt = Date.now()
        this.saveToStorage()
        this.emit()
      }

      task.status = 'completed'
      task.finishedAt = Date.now()
      task.updatedAt = Date.now()
      this.addLog(task, 'info', 'Task completed')
    } catch (error) {
      logger.error('Device task failed', { error, taskId: task.id, deviceId: task.deviceId })
      task.status = 'failed'
      task.error = error instanceof Error ? error.message : String(error)
      task.finishedAt = Date.now()
      task.updatedAt = Date.now()
      this.addLog(task, 'error', task.error)
    } finally {
      this.saveToStorage()
      this.emit()
    }
  }

  private async tryAttachDeerFlowPlan(task: DeviceTask): Promise<void> {
    const result = await deerFlowAdapter.requestPlan({
      taskId: task.id,
      deviceId: task.deviceId,
      goal: task.goal,
      context: { steps: task.steps }
    })
    this.addLog(task, result.available ? 'info' : 'warn', result.message, result.plan)
    this.saveToStorage()
    this.emit()
  }

  private addActionAudit(task: DeviceTask, step: DeviceTaskStep, result: DeviceActionResult): void {
    this.addLog(task, result.success ? 'info' : 'error', `Action ${result.type}: ${result.message}`, {
      stepId: step.id,
      action: step.action,
      durationMs: result.finishedAt - result.startedAt,
      result
    })
  }

  private addLog(task: DeviceTask, level: DeviceTaskLog['level'], message: string, data?: unknown): void {
    const entry: DeviceTaskLog = {
      id: createId('device-task-log'),
      taskId: task.id,
      deviceId: task.deviceId,
      level,
      message,
      timestamp: Date.now(),
      data
    }
    const logs = this.logs.get(task.id) ?? []
    logs.push(entry)
    this.logs.set(task.id, logs.slice(-500))
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private loadFromStorage(): void {
    if (typeof localStorage === 'undefined') return
    try {
      const tasks = JSON.parse(localStorage.getItem(TASK_STORAGE_KEY) || '[]') as DeviceTask[]
      for (const task of tasks) {
        this.tasks.set(task.id, task.status === 'running' ? { ...task, status: 'pending' } : task)
      }

      const logs = JSON.parse(localStorage.getItem(LOG_STORAGE_KEY) || '[]') as DeviceTaskLog[]
      for (const log of logs) {
        this.logs.set(log.taskId, [...(this.logs.get(log.taskId) ?? []), log])
      }
    } catch (error) {
      logger.warn('Failed to load device tasks from storage', { error })
    }
  }

  private saveToStorage(): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify([...this.tasks.values()]))
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify([...this.logs.values()].flat()))
  }
}

export const deviceTaskOrchestrator = new DeviceTaskOrchestrator()
