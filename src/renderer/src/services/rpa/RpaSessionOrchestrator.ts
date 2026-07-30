import type { RpaRoleVersionReference } from './RpaAppRole'
import type { RpaDslSession } from './RpaDslSession'
import { resolveRpaSessionRouting } from './RpaSessionRoutingPolicy'
import type { RpaRunControlAction, RpaTaskInteractionOutcome, RpaTaskSessionState } from './RpaTaskSessionProtocol'

export interface RpaTaskInputEnvelope {
  requestId: string
  sessionId?: string
  baseRevision?: number
  role?: RpaRoleVersionReference
  input: string
  attachments?: string[]
  topicCompatibilityId?: string
  requestedOutcome?: RpaTaskInteractionOutcome
  runControlAction?: RpaRunControlAction
}

export interface RpaSessionRouteDecision {
  requestId: string
  outcome: RpaTaskInteractionOutcome
  stateAfter: RpaTaskSessionState
  sourceRevision?: number
  runControlAction?: RpaRunControlAction
  reason: string
}

export class RpaSessionOrchestrator {
  route(envelope: RpaTaskInputEnvelope, session?: RpaDslSession): RpaSessionRouteDecision {
    const requestId = envelope.requestId.trim()
    const input = envelope.input.trim()
    if (!requestId) throw new Error('RPA task input requestId is required')
    if (!input) throw new Error('RPA task input is empty')
    if (!envelope.role) {
      return {
        requestId,
        outcome: 'non_executable',
        stateAfter: 'non_executable',
        reason: 'An active immutable RPA Role is required'
      }
    }
    if (session && envelope.sessionId && session.id !== envelope.sessionId) {
      return {
        requestId,
        outcome: 'non_executable',
        stateAfter: 'non_executable',
        sourceRevision: session.activeRevisionVersion,
        reason: 'The task input session does not match the active RPA DSL session'
      }
    }
    if (
      session?.primaryRole &&
      (session.primaryRole.id !== envelope.role.id || session.primaryRole.version !== envelope.role.version)
    ) {
      return {
        requestId,
        outcome: 'non_executable',
        stateAfter: 'non_executable',
        sourceRevision: session.activeRevisionVersion,
        reason: 'The active Role does not match the immutable RPA DSL session Role'
      }
    }
    if (session?.status === 'ended') {
      return {
        requestId,
        outcome: 'non_executable',
        stateAfter: 'completed',
        sourceRevision: session.activeRevisionVersion,
        reason: 'This RPA task has ended. Create or duplicate a task to continue.'
      }
    }
    const explicitOutcome = envelope.requestedOutcome ?? classifyExplicitOutcome(input)
    if (explicitOutcome === 'create_new_task') {
      return {
        requestId,
        outcome: explicitOutcome,
        stateAfter: 'planning',
        sourceRevision: session?.activeRevisionVersion,
        reason: 'Create an independent RPA task session while retaining the selected Role version'
      }
    }
    if (explicitOutcome === 'control_run') {
      const runControlAction = envelope.runControlAction ?? classifyRunControlAction(input)
      if (!runControlAction) {
        return {
          requestId,
          outcome: 'non_executable',
          stateAfter: session?.interactionState ?? 'non_executable',
          sourceRevision: session?.activeRevisionVersion,
          reason: 'The run-control action is missing or unsupported'
        }
      }
      return {
        requestId,
        outcome: explicitOutcome,
        stateAfter: session?.interactionState ?? 'non_executable',
        sourceRevision: session?.activeRevisionVersion,
        runControlAction,
        reason: `Control the active session run with action: ${runControlAction}`
      }
    }
    if (explicitOutcome === 'explain_dsl') {
      return {
        requestId,
        outcome: explicitOutcome,
        stateAfter: session?.interactionState ?? 'non_executable',
        sourceRevision: session?.activeRevisionVersion,
        reason: 'Explain the persisted DSL and run evidence without creating a revision'
      }
    }
    if (session?.status === 'clarification_required') {
      return {
        requestId,
        outcome: 'answer_clarification',
        stateAfter: 'planning',
        sourceRevision: session.activeRevisionVersion,
        reason: 'Continue the pending planning request with the clarification answer'
      }
    }
    if (session?.revisions.length) {
      return {
        requestId,
        outcome: 'revise_dsl',
        stateAfter: 'planning',
        sourceRevision: session.activeRevisionVersion,
        reason: 'Revise the active immutable DSL revision'
      }
    }
    return {
      requestId,
      outcome: 'create_dsl',
      stateAfter: 'planning',
      reason: 'Create the first DSL revision for the Role-scoped task session'
    }
  }
}

function classifyExplicitOutcome(input: string): RpaTaskInteractionOutcome | undefined {
  const normalized = normalizeCommand(input)
  if (/^(?:new task|create new task|start new task|new rpa task)(?::|\s|$)/i.test(normalized)) return 'create_new_task'
  if (
    /^(?:\u65b0\u5efa\u4efb\u52a1|\u521b\u5efa\u65b0\u4efb\u52a1|\u5f00\u59cb\u65b0\u4efb\u52a1|\u65b0\u5efa rpa \u4efb\u52a1)(?:[\uff1a:]|\s|$)/i.test(
      normalized
    )
  )
    return 'create_new_task'
  if (classifyRunControlAction(normalized)) return 'control_run'
  if (
    /^(?:explain|explain workflow|explain current workflow|explain dsl|why did (?:it|the task) fail)$/i.test(
      normalized
    ) ||
    /^(?:\u89e3\u91ca|\u89e3\u91ca\u6d41\u7a0b|\u89e3\u91ca\u5f53\u524d\u6d41\u7a0b|\u89e3\u91ca dsl|\u4e3a\u4ec0\u4e48\u4efb\u52a1\u5931\u8d25|\u4efb\u52a1\u4e3a\u4ec0\u4e48\u5931\u8d25)$/i.test(
      normalized
    )
  )
    return 'explain_dsl'
  return undefined
}

function classifyRunControlAction(input: string): RpaRunControlAction | undefined {
  const normalized = normalizeCommand(input)
  if (
    /^(?:pause|pause run|pause task|\u6682\u505c|\u6682\u505c\u4efb\u52a1|\u6682\u505c\u6267\u884c)$/i.test(normalized)
  )
    return 'pause'
  if (
    /^(?:resume|resume run|resume task|\u7ee7\u7eed|\u7ee7\u7eed\u4efb\u52a1|\u6062\u590d|\u6062\u590d\u6267\u884c)$/i.test(
      normalized
    )
  )
    return 'resume'
  if (
    /^(?:stop|stop run|stop task|cancel run|\u53d6\u6d88\u4efb\u52a1|\u505c\u6b62\u4efb\u52a1|\u505c\u6b62\u6267\u884c)$/i.test(
      normalized
    )
  )
    return 'stop'
  if (
    /^(?:retry|retry run|retry task|\u91cd\u8bd5|\u91cd\u8bd5\u4efb\u52a1|\u91cd\u65b0\u6267\u884c)$/i.test(normalized)
  )
    return 'retry'
  if (
    /^(?:approve manual intervention|manual intervention complete|\u4eba\u5de5\u5904\u7406\u5b8c\u6210|\u6279\u51c6\u4eba\u5de5\u4ecb\u5165)$/i.test(
      normalized
    )
  )
    return 'approve_manual_intervention'
  return undefined
}

function normalizeCommand(input: string): string {
  return input
    .trim()
    .replace(/[\u3002\uff01\uff1f!?]+$/g, '')
    .replace(/\s+/g, ' ')
}

export function shouldUseRpaSessionOrchestrator(input: {
  rpaAvailable: boolean
  roleId?: string
  cutoverState?: Parameters<typeof resolveRpaSessionRouting>[0]['cutoverState']
  previewEnabled?: boolean
}): boolean {
  return (
    resolveRpaSessionRouting({
      ...input,
      legacyIntentMatched: false,
      previewEnabled: input.previewEnabled ?? true
    }).mode === 'session_orchestrator'
  )
}

export function shouldRouteInputToRpa(input: {
  rpaAvailable: boolean
  roleId?: string
  legacyIntentMatched: boolean
  cutoverState?: Parameters<typeof resolveRpaSessionRouting>[0]['cutoverState']
  previewEnabled?: boolean
}): boolean {
  const mode = resolveRpaSessionRouting({ ...input, previewEnabled: input.previewEnabled ?? true }).mode
  return mode === 'session_orchestrator' || mode === 'compatibility'
}

export const rpaSessionOrchestrator = new RpaSessionOrchestrator()
