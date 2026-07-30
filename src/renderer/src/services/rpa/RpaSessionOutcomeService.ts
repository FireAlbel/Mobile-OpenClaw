import type { RpaBatchRunner } from './RpaBatchRunner'
import { rpaBatchRunner } from './RpaBatchRunner'
import type { RpaDslSession } from './RpaDslSession'
import type { RpaBatchRunRecord } from './RpaRunStorage'
import type { RpaRunControlAction, RpaTaskSessionState } from './RpaTaskSessionProtocol'
import type { RpaTask } from './RpaTypes'

export interface RpaSessionOutcomeResult {
  kind: 'explanation' | 'run_control' | 'new_task' | 'non_executable'
  success: boolean
  message: string
  stateAfter: RpaTaskSessionState
  runId?: string
  newRunId?: string
  affectedDeviceRunIds?: string[]
}

type SessionRunner = Pick<
  RpaBatchRunner,
  'initialize' | 'getRuns' | 'pauseDeviceRun' | 'resumeDeviceRun' | 'cancelBatchRun' | 'retryBatchRun'
>

export class RpaSessionOutcomeService {
  constructor(private readonly runner: SessionRunner = rpaBatchRunner) {}

  async explain(session: RpaDslSession): Promise<RpaSessionOutcomeResult> {
    await this.runner.initialize()
    const revision = session.revisions.find((candidate) => candidate.version === session.activeRevisionVersion)
    if (!revision) {
      return {
        kind: 'non_executable',
        success: false,
        message: 'This task session has no DSL revision to explain. Generate a workflow first.',
        stateAfter: session.interactionState
      }
    }

    const task = revision.dsl as Partial<RpaTask>
    const steps = Array.isArray(task.steps) ? task.steps : []
    const validation = revision.executable
      ? 'The active revision is validated and ready for execution.'
      : `The active revision is not executable and has ${revision.validationIssues.length} validation issue(s).`
    const runSummary = this.describeRuns(session)
    const stepSummary = steps.length
      ? steps
          .map((step, index) => `${index + 1}. ${step.name || step.moduleId || step.id || 'Unnamed step'}`)
          .join('\n')
      : 'No executable steps are present.'

    return {
      kind: 'explanation',
      success: true,
      stateAfter: session.interactionState,
      message: [
        `Task: ${task.name || session.goal}`,
        `Goal: ${task.goal || session.goal}`,
        validation,
        'Steps:',
        stepSummary,
        runSummary
      ].join('\n')
    }
  }

  async control(session: RpaDslSession, action: RpaRunControlAction): Promise<RpaSessionOutcomeResult> {
    await this.runner.initialize()
    const run = this.findLatestSessionRun(session)
    if (!run) {
      return this.controlError(session, 'No execution run is linked to this task session.')
    }

    if (action === 'stop') {
      const success = await this.runner.cancelBatchRun(run.id)
      return success
        ? this.controlSuccess(
            run,
            action,
            run.deviceRuns.map((deviceRun) => deviceRun.id),
            'The run was stopped.'
          )
        : this.controlError(session, 'The linked run is already finished and cannot be stopped.', run.id)
    }

    if (action === 'retry') {
      const retried = await this.runner.retryBatchRun(run.id)
      return retried
        ? {
            kind: 'run_control',
            success: true,
            message: `A new retry run was started for ${retried.deviceRuns.length} device(s).`,
            stateAfter: 'executing',
            runId: run.id,
            newRunId: retried.id,
            affectedDeviceRunIds: retried.deviceRuns.map((deviceRun) => deviceRun.id)
          }
        : this.controlError(session, 'Only a failed or cancelled run can be retried.', run.id)
    }

    const candidates = run.deviceRuns.filter((deviceRun) => {
      if (action === 'pause') return deviceRun.status === 'pending' || deviceRun.status === 'running'
      if (action === 'approve_manual_intervention') return deviceRun.status === 'needs_human'
      return deviceRun.status === 'paused' || deviceRun.status === 'needs_human'
    })
    if (!candidates.length) {
      return this.controlError(session, `The linked run has no device execution eligible for ${action}.`, run.id)
    }

    const results = await Promise.all(
      candidates.map((deviceRun) =>
        action === 'pause' ? this.runner.pauseDeviceRun(deviceRun.id) : this.runner.resumeDeviceRun(deviceRun.id)
      )
    )
    const affected = candidates.filter((_, index) => results[index]).map((deviceRun) => deviceRun.id)
    if (!affected.length) return this.controlError(session, `The ${action} command did not change the run.`, run.id)

    const message =
      action === 'pause'
        ? `Paused ${affected.length} device execution(s).`
        : action === 'approve_manual_intervention'
          ? `Accepted manual intervention and resumed ${affected.length} device execution(s).`
          : `Resumed ${affected.length} device execution(s).`
    return this.controlSuccess(run, action, affected, message)
  }

  extractNewTaskGoal(input: string): string | undefined {
    const goal = input
      .trim()
      .replace(
        /^(?:new task|create new task|start new task|new rpa task|\u65b0\u5efa\u4efb\u52a1|\u521b\u5efa\u65b0\u4efb\u52a1|\u5f00\u59cb\u65b0\u4efb\u52a1|\u65b0\u5efa rpa \u4efb\u52a1)\s*[\uff1a:]?\s*/i,
        ''
      )
      .trim()
    return goal && goal !== input.trim() ? goal : undefined
  }

  private findLatestSessionRun(session: RpaDslSession): RpaBatchRunRecord | undefined {
    const runs = this.runner.getRuns()
    for (const runId of [...session.runIds].reverse()) {
      const run = runs.find((candidate) => candidate.id === runId)
      if (run) return run
    }
    return undefined
  }

  private describeRuns(session: RpaDslSession): string {
    const run = this.findLatestSessionRun(session)
    if (!run) return 'Run evidence: no execution run is linked to this task session.'
    const statuses = run.deviceRuns.map((deviceRun) => `${deviceRun.deviceId}: ${deviceRun.status}`).join(', ')
    return `Latest run: ${run.status} (${statuses})`
  }

  private controlSuccess(
    run: RpaBatchRunRecord,
    action: RpaRunControlAction,
    affectedDeviceRunIds: string[],
    message: string
  ): RpaSessionOutcomeResult {
    return {
      kind: 'run_control',
      success: true,
      message,
      stateAfter: action === 'pause' ? 'paused' : action === 'stop' ? 'failed' : 'executing',
      runId: run.id,
      affectedDeviceRunIds
    }
  }

  private controlError(session: RpaDslSession, message: string, runId?: string): RpaSessionOutcomeResult {
    return {
      kind: 'non_executable',
      success: false,
      message,
      stateAfter: session.interactionState,
      runId
    }
  }
}

export const rpaSessionOutcomeService = new RpaSessionOutcomeService()
