import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { getConfigDir } from '@main/utils/file'
import { IpcChannel } from '@shared/IpcChannel'
import type {
  RpaTaskFlowDueTrigger,
  RpaTaskFlowSchedule,
  RpaTaskFlowTriggerAudit,
  RpaTaskFlowTriggerResult
} from '@shared/types/RpaTaskFlowSchedule'
import { Cron } from 'croner'
import { BrowserWindow } from 'electron'

const logger = loggerService.withContext('RpaTaskFlowSchedulerService')
const MIN_INTERVAL_MS = 60_000

export class RpaTaskFlowSchedulerService {
  private schedules: RpaTaskFlowSchedule[] = []
  private timer?: NodeJS.Timeout
  private initialized = false

  constructor(
    private readonly filePath = path.join(getConfigDir(), 'rpa', 'task-flow-schedules.json'),
    private readonly now: () => number = Date.now
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.schedules = await this.read()
    this.initialized = true
    await this.recalculateRestoredSchedules()
    this.armTimer()
  }

  async getSchedules(): Promise<RpaTaskFlowSchedule[]> {
    await this.initialize()
    return structuredClone(this.schedules)
  }

  async saveSchedules(value: unknown): Promise<RpaTaskFlowSchedule[]> {
    await this.initialize()
    this.schedules = sanitizeSchedules(value, this.now())
    this.recalculateNextRuns()
    const invalid = this.schedules.find((schedule) => schedule.enabled && schedule.nextRunAt === undefined)
    if (invalid) throw new Error(`Enabled RPA task flow schedule has no valid next run: ${invalid.id}`)
    await this.write()
    this.armTimer()
    return structuredClone(this.schedules)
  }

  async triggerNow(scheduleId: string): Promise<RpaTaskFlowDueTrigger> {
    await this.initialize()
    const schedule = this.requireSchedule(scheduleId)
    return this.dispatch(schedule, this.now())
  }

  async completeTrigger(result: RpaTaskFlowTriggerResult): Promise<void> {
    await this.initialize()
    const schedule = this.schedules.find((item) => item.id === result.scheduleId)
    if (!schedule) return
    schedule.activeTriggerId = schedule.activeTriggerId === result.triggerId ? undefined : schedule.activeTriggerId
    schedule.triggerHistory = schedule.triggerHistory.map((item) =>
      item.id === result.triggerId
        ? {
            ...item,
            status: result.status,
            runId: cleanText(result.runId),
            reason: cleanText(result.reason),
            finishedAt: this.now()
          }
        : item
    )
    schedule.updatedAt = this.now()
    await this.write()
    this.armTimer()
  }

  private async recalculateRestoredSchedules(): Promise<void> {
    const now = this.now()
    for (const schedule of this.schedules) {
      if (!schedule.enabled) continue
      if (schedule.activeTriggerId) {
        schedule.activeTriggerId = undefined
        const active = schedule.triggerHistory.find((item) => item.status === 'dispatched')
        if (active) {
          active.status = 'failed'
          active.reason = 'Application restarted before the trigger completed'
          active.finishedAt = now
        }
      }
      if (schedule.nextRunAt && schedule.nextRunAt <= now) {
        if (schedule.missedRunPolicy === 'run_once') {
          schedule.nextRunAt = now
        } else {
          schedule.nextRunAt = nextRun(schedule, now)
        }
      } else if (!schedule.nextRunAt) {
        schedule.nextRunAt = nextRun(schedule, now)
      }
    }
    await this.write()
  }

  private recalculateNextRuns(): void {
    const now = this.now()
    for (const schedule of this.schedules) {
      schedule.nextRunAt = schedule.enabled ? nextRun(schedule, now) : undefined
    }
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    const now = this.now()
    const next = this.schedules
      .filter((item) => item.enabled && item.nextRunAt !== undefined)
      .sort((left, right) => left.nextRunAt! - right.nextRunAt!)[0]
    if (!next?.nextRunAt) return
    this.timer = setTimeout(
      () => void this.handleDueSchedules(),
      Math.max(100, Math.min(next.nextRunAt - now, 2_147_000_000))
    )
    this.timer.unref()
  }

  private async handleDueSchedules(): Promise<void> {
    const now = this.now()
    for (const schedule of this.schedules.filter(
      (item) => item.enabled && item.nextRunAt !== undefined && item.nextRunAt <= now
    )) {
      try {
        await this.dispatch(schedule, schedule.nextRunAt!)
      } catch (error) {
        logger.warn('Failed to dispatch scheduled RPA task flow', { error, scheduleId: schedule.id })
      }
    }
    await this.write()
    this.armTimer()
  }

  private async dispatch(schedule: RpaTaskFlowSchedule, scheduledAt: number): Promise<RpaTaskFlowDueTrigger> {
    const now = this.now()
    if (schedule.activeTriggerId) {
      const reason =
        schedule.overlapPolicy === 'queue'
          ? 'Previous run is active; trigger retained for the next scheduler cycle'
          : 'Previous run is still active'
      const skipped = createTrigger(scheduledAt, now)
      skipped.status = 'skipped'
      skipped.reason = reason
      skipped.finishedAt = now
      schedule.triggerHistory = [skipped, ...schedule.triggerHistory].slice(0, 50)
      schedule.nextRunAt =
        schedule.overlapPolicy === 'queue' ? now + MIN_INTERVAL_MS : nextRun(schedule, Math.max(now, scheduledAt))
      schedule.updatedAt = now
      await this.write()
      throw new Error(reason)
    }

    const audit = createTrigger(scheduledAt, now)
    audit.status = 'dispatched'
    schedule.activeTriggerId = audit.id
    schedule.triggerHistory = [audit, ...schedule.triggerHistory].slice(0, 50)
    schedule.nextRunAt = schedule.kind === 'one_time' ? undefined : nextRun(schedule, Math.max(now, scheduledAt))
    if (schedule.kind === 'one_time') schedule.enabled = false
    schedule.updatedAt = now
    await this.write()

    const trigger: RpaTaskFlowDueTrigger = {
      scheduleId: schedule.id,
      triggerId: audit.id,
      taskFlowId: schedule.taskFlowId,
      role: schedule.role,
      target: schedule.target,
      scheduledAt
    }
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
    if (!windows.length) throw new Error('No renderer is available for scheduled RPA execution')
    windows[0].webContents.send(IpcChannel.Rpa_TaskFlowScheduleDue, trigger)
    return trigger
  }

  private requireSchedule(id: string): RpaTaskFlowSchedule {
    const schedule = this.schedules.find((item) => item.id === id)
    if (!schedule) throw new Error(`RPA task flow schedule not found: ${id}`)
    return schedule
  }

  private async read(): Promise<RpaTaskFlowSchedule[]> {
    try {
      return sanitizeSchedules(JSON.parse(await fs.readFile(this.filePath, 'utf-8')), this.now())
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return []
      logger.warn('Failed to load RPA task flow schedules', { error })
      return []
    }
  }

  private async write(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await fs.writeFile(temporaryPath, JSON.stringify(this.schedules, null, 2), 'utf-8')
    await fs.rename(temporaryPath, this.filePath)
  }
}

function nextRun(schedule: RpaTaskFlowSchedule, after: number): number | undefined {
  if (schedule.kind === 'one_time') return schedule.runAt && schedule.runAt > after ? schedule.runAt : undefined
  if (schedule.kind === 'interval') {
    const interval = Math.max(MIN_INTERVAL_MS, schedule.intervalMs ?? MIN_INTERVAL_MS)
    const anchor = schedule.runAt ?? schedule.createdAt
    if (anchor > after) return anchor
    return anchor + (Math.floor((after - anchor) / interval) + 1) * interval
  }
  if (!schedule.cronExpression) return undefined
  try {
    return new Cron(schedule.cronExpression, { timezone: schedule.timezone, paused: true })
      .nextRun(new Date(after))
      ?.getTime()
  } catch (error) {
    logger.warn('Invalid RPA task flow cron expression', { error, scheduleId: schedule.id })
    return undefined
  }
}

function sanitizeSchedules(value: unknown, now: number): RpaTaskFlowSchedule[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const id = cleanText(candidate.id)
    const taskFlowId = cleanText(candidate.taskFlowId)
    const roleId = isRecord(candidate.role) ? cleanText(candidate.role.id) : undefined
    const role =
      roleId && isRecord(candidate.role) ? { id: roleId, version: positiveInteger(candidate.role.version) } : undefined
    const kind = candidate.kind === 'interval' || candidate.kind === 'cron' ? candidate.kind : 'one_time'
    if (!id || !taskFlowId || !role?.id) return []
    const createdAt = timestamp(candidate.createdAt, now)
    const schedule: RpaTaskFlowSchedule = {
      schemaVersion: 1,
      id,
      taskFlowId,
      role,
      kind,
      enabled: candidate.enabled === true,
      timezone: cleanText(candidate.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      runAt: optionalTimestamp(candidate.runAt),
      intervalMs:
        typeof candidate.intervalMs === 'number' ? Math.max(MIN_INTERVAL_MS, candidate.intervalMs) : undefined,
      cronExpression: cleanText(candidate.cronExpression),
      target: sanitizeTarget(candidate.target),
      overlapPolicy:
        candidate.overlapPolicy === 'queue' || candidate.overlapPolicy === 'forbid_overlap'
          ? candidate.overlapPolicy
          : 'skip',
      missedRunPolicy: candidate.missedRunPolicy === 'run_once' ? 'run_once' : 'skip',
      nextRunAt: optionalTimestamp(candidate.nextRunAt),
      activeTriggerId: cleanText(candidate.activeTriggerId),
      triggerHistory: sanitizeHistory(candidate.triggerHistory),
      createdAt,
      updatedAt: timestamp(candidate.updatedAt, createdAt)
    }
    return [schedule]
  })
}

function sanitizeTarget(value: unknown): RpaTaskFlowSchedule['target'] {
  if (!isRecord(value)) return { mode: 'manual', deviceIds: [], groupIds: [] }
  return {
    mode: value.mode === 'groups' || value.mode === 'all_online' ? value.mode : 'manual',
    deviceIds: strings(value.deviceIds),
    groupIds: strings(value.groupIds)
  }
}

function sanitizeHistory(value: unknown): RpaTaskFlowSchedule['triggerHistory'] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 50).flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const id = cleanText(candidate.id)
    const scheduledAt = optionalTimestamp(candidate.scheduledAt)
    if (!id || !scheduledAt) return []
    const status = ['pending', 'dispatched', 'completed', 'failed', 'skipped'].includes(String(candidate.status))
      ? (candidate.status as RpaTaskFlowSchedule['triggerHistory'][number]['status'])
      : 'failed'
    return [
      {
        id,
        scheduledAt,
        triggeredAt: optionalTimestamp(candidate.triggeredAt),
        finishedAt: optionalTimestamp(candidate.finishedAt),
        status,
        runId: cleanText(candidate.runId),
        reason: cleanText(candidate.reason)
      }
    ]
  })
}

function createTrigger(scheduledAt: number, now: number): RpaTaskFlowTriggerAudit {
  return {
    id: `rpa-trigger-${now}-${Math.random().toString(36).slice(2, 10)}`,
    scheduledAt,
    triggeredAt: now,
    status: 'pending' as const
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(cleanText).filter((item): item is string => Boolean(item)))] : []
}
function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
function timestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}
function optionalTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
function positiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export const rpaTaskFlowSchedulerService = new RpaTaskFlowSchedulerService()
