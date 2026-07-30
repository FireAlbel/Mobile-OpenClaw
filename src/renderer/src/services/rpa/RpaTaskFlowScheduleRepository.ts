import { loggerService } from '@logger'
import type {
  RpaTaskFlowDueTrigger,
  RpaTaskFlowSchedule,
  RpaTaskFlowTriggerResult
} from '@shared/types/RpaTaskFlowSchedule'

const logger = loggerService.withContext('RpaTaskFlowScheduleRepository')

export class RpaTaskFlowScheduleRepository {
  async getAll(): Promise<RpaTaskFlowSchedule[]> {
    if (!window.api?.rpa?.loadTaskFlowSchedules) return []
    return window.api.rpa.loadTaskFlowSchedules()
  }

  async getByTaskFlowId(taskFlowId: string): Promise<RpaTaskFlowSchedule | undefined> {
    return (await this.getAll()).find((schedule) => schedule.taskFlowId === taskFlowId)
  }

  async save(schedule: RpaTaskFlowSchedule): Promise<RpaTaskFlowSchedule> {
    const schedules = await this.getAll()
    const saved = await window.api.rpa.saveTaskFlowSchedules([
      schedule,
      ...schedules.filter((item) => item.id !== schedule.id && item.taskFlowId !== schedule.taskFlowId)
    ])
    const result = saved.find((item) => item.id === schedule.id)
    if (!result) throw new Error('RPA task flow schedule was not persisted')
    return result
  }

  async removeByTaskFlowId(taskFlowId: string): Promise<void> {
    const schedules = await this.getAll()
    await window.api.rpa.saveTaskFlowSchedules(schedules.filter((item) => item.taskFlowId !== taskFlowId))
  }

  async triggerNow(scheduleId: string): Promise<RpaTaskFlowDueTrigger> {
    return window.api.rpa.triggerTaskFlowSchedule(scheduleId)
  }

  async complete(result: RpaTaskFlowTriggerResult): Promise<void> {
    try {
      await window.api.rpa.completeTaskFlowTrigger(result)
    } catch (error) {
      logger.error('Failed to complete RPA task flow trigger', { error, result })
      throw error
    }
  }
}

export const rpaTaskFlowScheduleRepository = new RpaTaskFlowScheduleRepository()
