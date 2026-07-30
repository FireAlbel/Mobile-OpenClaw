import { loggerService } from '@logger'
import type { RpaTaskFlowDueTrigger } from '@shared/types/RpaTaskFlowSchedule'
import type { FC } from 'react'
import { useEffect } from 'react'

import {
  DEVICE_GROUPS_CONFIG_KEY,
  DEVICE_INFO_CONFIG_KEY,
  sanitizeDeviceGroups,
  sanitizeDeviceMetadataMap
} from '../../pages/device/deviceMetadata'
import { deviceServiceProxy } from '../DeviceServiceProxy'
import { rpaAppRoleRepository } from './RpaAppRole'
import { rpaBatchRunner } from './RpaBatchRunner'
import { resolveRpaExecutionTargets } from './RpaExecutionTarget'
import { rpaTaskFlowScheduleRepository } from './RpaTaskFlowScheduleRepository'
import { getTemplateTask, rpaTemplateRepository } from './RpaTemplateRepository'

const logger = loggerService.withContext('RpaTaskFlowExecutionHost')
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

const RpaTaskFlowExecutionHost: FC = () => {
  useEffect(() => {
    const unsubscribe = window.api.rpa.onTaskFlowScheduleDue((trigger) => void executeTrigger(trigger))
    return unsubscribe
  }, [])
  return null
}

async function executeTrigger(trigger: RpaTaskFlowDueTrigger): Promise<void> {
  try {
    const [taskFlow, role, devices, storedGroups, storedDeviceInfo] = await Promise.all([
      rpaTemplateRepository.getById(trigger.taskFlowId),
      rpaAppRoleRepository.getById(trigger.role.id),
      deviceServiceProxy.scanDevices(),
      window.api.config.get(DEVICE_GROUPS_CONFIG_KEY),
      window.api.config.get(DEVICE_INFO_CONFIG_KEY)
    ])
    if (!taskFlow) throw new Error(`RPA task flow not found: ${trigger.taskFlowId}`)
    if (!role || role.status !== 'enabled') throw new Error(`RPA Role is missing or disabled: ${trigger.role.id}`)
    if (role.version !== trigger.role.version) {
      throw new Error(
        `RPA Role version changed from ${trigger.role.version} to ${role.version}; confirm the upgrade first`
      )
    }
    const task = getTemplateTask(taskFlow)
    if (!task) throw new Error('RPA task flow DSL is not executable')
    const targetSelection = resolveRpaExecutionTargets({
      devices,
      groups: sanitizeDeviceGroups(storedGroups),
      deviceInfo: sanitizeDeviceMetadataMap(storedDeviceInfo),
      intent: {
        mode: trigger.target.mode,
        groupIds: trigger.target.groupIds,
        includedDeviceIds: trigger.target.deviceIds,
        excludedDeviceIds: []
      }
    })
    if (!targetSelection.deviceIds.length) throw new Error('No online device matches the scheduled target scope')
    const run = await rpaBatchRunner.start({
      task: {
        ...task,
        deviceIds: targetSelection.deviceIds,
        metadata: {
          ...task.metadata,
          templateId: taskFlow.id,
          templateVersion: taskFlow.version,
          taskFlowScheduleId: trigger.scheduleId,
          roleId: role.id,
          roleVersion: role.version
        }
      },
      targetSelection
    })
    await waitForTerminalRun(run.id)
    const completed = rpaBatchRunner.getRuns().find((candidate) => candidate.id === run.id)
    await rpaTaskFlowScheduleRepository.complete({
      scheduleId: trigger.scheduleId,
      triggerId: trigger.triggerId,
      status: completed?.status === 'completed' ? 'completed' : 'failed',
      runId: run.id,
      reason: completed?.status === 'completed' ? undefined : `Run ended with status ${completed?.status ?? 'unknown'}`
    })
  } catch (error) {
    logger.error('Scheduled RPA task flow failed', { error, trigger })
    await rpaTaskFlowScheduleRepository.complete({
      scheduleId: trigger.scheduleId,
      triggerId: trigger.triggerId,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error)
    })
  }
}

function waitForTerminalRun(runId: string): Promise<void> {
  return new Promise((resolve) => {
    const inspect = () => {
      const run = rpaBatchRunner.getRuns().find((candidate) => candidate.id === runId)
      if (!run || !TERMINAL_STATUSES.has(run.status)) return
      unsubscribe()
      resolve()
    }
    const unsubscribe = rpaBatchRunner.subscribe(inspect)
    inspect()
  })
}

export default RpaTaskFlowExecutionHost
