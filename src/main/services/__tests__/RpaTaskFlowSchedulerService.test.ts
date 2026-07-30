import fs from 'node:fs/promises'
import path from 'node:path'

import type { RpaTaskFlowSchedule } from '@shared/types/RpaTaskFlowSchedule'
import { afterEach, describe, expect, it } from 'vitest'

import { RpaTaskFlowSchedulerService } from '../RpaTaskFlowSchedulerService'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('RpaTaskFlowSchedulerService', () => {
  it('persists interval schedules and calculates the next anchored execution', async () => {
    const now = Date.UTC(2026, 6, 24, 1, 0, 0)
    const service = new RpaTaskFlowSchedulerService(await schedulePath(), () => now)
    const [saved] = await service.saveSchedules([
      schedule({ kind: 'interval', runAt: now - 30_000, intervalMs: 60_000 })
    ])

    expect(saved.nextRunAt).toBe(now + 30_000)
    expect((await service.getSchedules())[0].role).toEqual({ id: 'role-1', version: 3 })
  })

  it('calculates cron schedules in the configured timezone', async () => {
    const now = Date.UTC(2026, 6, 24, 0, 0, 0)
    const service = new RpaTaskFlowSchedulerService(await schedulePath(), () => now)
    const [saved] = await service.saveSchedules([
      schedule({ kind: 'cron', timezone: 'Asia/Shanghai', cronExpression: '0 9 * * *' })
    ])

    expect(saved.nextRunAt).toBe(Date.UTC(2026, 6, 24, 1, 0, 0))
  })

  it('rejects an enabled schedule without a valid future execution', async () => {
    const now = Date.UTC(2026, 6, 24, 1, 0, 0)
    const service = new RpaTaskFlowSchedulerService(await schedulePath(), () => now)

    await expect(service.saveSchedules([schedule({ kind: 'one_time', runAt: now - 1 })])).rejects.toThrow(
      'has no valid next run'
    )
  })
})

function schedule(patch: Partial<RpaTaskFlowSchedule>): RpaTaskFlowSchedule {
  return {
    schemaVersion: 1,
    id: 'schedule-1',
    taskFlowId: 'flow-1',
    role: { id: 'role-1', version: 3 },
    kind: 'one_time',
    enabled: true,
    timezone: 'UTC',
    target: { mode: 'manual', deviceIds: ['device-1'], groupIds: [] },
    overlapPolicy: 'skip',
    missedRunPolicy: 'skip',
    triggerHistory: [],
    createdAt: Date.UTC(2026, 6, 24, 0, 0, 0),
    updatedAt: Date.UTC(2026, 6, 24, 0, 0, 0),
    ...patch
  }
}

async function schedulePath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.rpa-task-flow-scheduler-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'schedules.json')
}
