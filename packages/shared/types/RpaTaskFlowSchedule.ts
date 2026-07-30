export type RpaTaskFlowScheduleKind = 'one_time' | 'interval' | 'cron'
export type RpaTaskFlowOverlapPolicy = 'skip' | 'queue' | 'forbid_overlap'
export type RpaTaskFlowMissedRunPolicy = 'skip' | 'run_once'
export type RpaTaskFlowTriggerStatus = 'pending' | 'dispatched' | 'completed' | 'failed' | 'skipped'

export interface RpaTaskFlowRoleReference {
  id: string
  version: number
}

export interface RpaTaskFlowTargetScope {
  mode: 'manual' | 'groups' | 'all_online'
  deviceIds: string[]
  groupIds: string[]
}

export interface RpaTaskFlowTriggerAudit {
  id: string
  scheduledAt: number
  triggeredAt?: number
  finishedAt?: number
  status: RpaTaskFlowTriggerStatus
  runId?: string
  reason?: string
}

export interface RpaTaskFlowSchedule {
  schemaVersion: 1
  id: string
  taskFlowId: string
  role: RpaTaskFlowRoleReference
  kind: RpaTaskFlowScheduleKind
  enabled: boolean
  timezone: string
  runAt?: number
  intervalMs?: number
  cronExpression?: string
  target: RpaTaskFlowTargetScope
  overlapPolicy: RpaTaskFlowOverlapPolicy
  missedRunPolicy: RpaTaskFlowMissedRunPolicy
  nextRunAt?: number
  activeTriggerId?: string
  triggerHistory: RpaTaskFlowTriggerAudit[]
  createdAt: number
  updatedAt: number
}

export interface RpaTaskFlowDueTrigger {
  scheduleId: string
  triggerId: string
  taskFlowId: string
  role: RpaTaskFlowRoleReference
  target: RpaTaskFlowTargetScope
  scheduledAt: number
}

export interface RpaTaskFlowTriggerResult {
  scheduleId: string
  triggerId: string
  status: 'completed' | 'failed'
  runId?: string
  reason?: string
}
