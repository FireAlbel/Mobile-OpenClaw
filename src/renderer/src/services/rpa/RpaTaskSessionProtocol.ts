export type RpaTaskSessionState =
  | 'empty'
  | 'planning'
  | 'needs_clarification'
  | 'draft'
  | 'validating'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'non_executable'

export type RpaTaskInteractionOutcome =
  | 'create_dsl'
  | 'revise_dsl'
  | 'answer_clarification'
  | 'explain_dsl'
  | 'control_run'
  | 'create_new_task'
  | 'non_executable'

export type RpaRunControlAction = 'pause' | 'resume' | 'stop' | 'retry' | 'approve_manual_intervention'

export type RpaTaskInteractionPhase = 'received' | 'completed' | 'rejected' | 'failed'

export interface RpaTaskInteractionEvent {
  id: string
  requestId: string
  outcome: RpaTaskInteractionOutcome
  phase: RpaTaskInteractionPhase
  input: string
  stateBefore: RpaTaskSessionState
  stateAfter: RpaTaskSessionState
  sourceRevision?: number
  reason?: string
  createdAt: number
}

const transitions: Record<RpaTaskSessionState, ReadonlySet<RpaTaskSessionState>> = {
  empty: new Set(['planning', 'non_executable']),
  planning: new Set([
    'empty',
    'needs_clarification',
    'draft',
    'validating',
    'ready',
    'completed',
    'failed',
    'non_executable'
  ]),
  needs_clarification: new Set(['planning', 'draft', 'failed', 'non_executable']),
  draft: new Set(['planning', 'validating', 'ready', 'failed', 'non_executable']),
  validating: new Set(['draft', 'ready', 'failed', 'non_executable']),
  ready: new Set(['planning', 'draft', 'executing', 'failed', 'non_executable']),
  executing: new Set(['paused', 'completed', 'failed']),
  paused: new Set(['planning', 'executing', 'completed', 'failed']),
  completed: new Set(['planning']),
  failed: new Set(['planning', 'non_executable']),
  non_executable: new Set(['planning'])
}

export function canTransitionRpaTaskSessionState(from: RpaTaskSessionState, to: RpaTaskSessionState): boolean {
  return from === to || transitions[from].has(to)
}

export function taskStateFromLegacyStatus(status: string, hasRevision = false): RpaTaskSessionState {
  switch (status) {
    case 'clarification_required':
      return 'needs_clarification'
    case 'validated':
      return 'ready'
    case 'non_executable':
      return 'non_executable'
    case 'executing':
      return 'executing'
    case 'paused':
      return 'paused'
    case 'completed':
    case 'ended':
      return 'completed'
    case 'failed':
      return 'failed'
    default:
      return hasRevision ? 'draft' : 'empty'
  }
}

export function resolveStableRpaTaskSessionState(
  state: RpaTaskSessionState,
  events: RpaTaskInteractionEvent[]
): RpaTaskSessionState {
  if (state !== 'planning') return state
  let candidate = state as RpaTaskSessionState
  for (const event of [...events].reverse()) {
    if (event.stateAfter !== 'planning' || candidate !== 'planning') continue
    candidate = event.stateBefore
    if (candidate !== 'planning') return candidate
  }
  return 'empty'
}

export function sanitizeRpaTaskSessionState(value: unknown, fallback: RpaTaskSessionState): RpaTaskSessionState {
  return typeof value === 'string' && value in transitions ? (value as RpaTaskSessionState) : fallback
}

export function sanitizeRpaTaskInteractionEvent(value: unknown): RpaTaskInteractionEvent | undefined {
  if (!record(value)) return undefined
  const id = text(value.id, 256)
  const requestId = text(value.requestId, 256)
  const input = text(value.input, 4_000)
  const outcome = outcomes.has(String(value.outcome)) ? (value.outcome as RpaTaskInteractionOutcome) : undefined
  const phase = phases.has(String(value.phase)) ? (value.phase as RpaTaskInteractionPhase) : undefined
  if (!id || !requestId || !input || !outcome || !phase) return undefined
  const fallback = 'draft' satisfies RpaTaskSessionState
  return {
    id,
    requestId,
    outcome,
    phase,
    input,
    stateBefore: sanitizeRpaTaskSessionState(value.stateBefore, fallback),
    stateAfter: sanitizeRpaTaskSessionState(value.stateAfter, fallback),
    sourceRevision: positiveOptional(value.sourceRevision),
    reason: text(value.reason, 4_000) || undefined,
    createdAt: time(value.createdAt)
  }
}

const outcomes = new Set<string>([
  'create_dsl',
  'revise_dsl',
  'answer_clarification',
  'explain_dsl',
  'control_run',
  'create_new_task',
  'non_executable'
])
const phases = new Set<string>(['received', 'completed', 'rejected', 'failed'])

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function positiveOptional(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function time(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}
