import type { RpaDslSession, RpaPlanningRequestStatus } from './RpaDslSession'

export interface RpaPlanningRequestInput {
  requestId: string
  sessionId: string
  baseRevision?: number
  expectedVersion: number
  supplementRevision: number
  contextSnapshotId?: string
  requestedAt: number
  timeoutMs: number
}

export class RpaPlanningRequestError extends Error {
  constructor(
    message: string,
    readonly status: Exclude<RpaPlanningRequestStatus, 'pending' | 'accepted'>
  ) {
    super(message)
    this.name = 'RpaPlanningRequestError'
  }
}

export interface RpaPlanningRequestHandle {
  readonly input: RpaPlanningRequestInput
  readonly signal: AbortSignal
  isCurrent(): boolean
  assertCurrent(session: RpaDslSession, supplementRevision: number, contextSnapshotId?: string): void
  accept(session: RpaDslSession, supplementRevision: number, contextSnapshotId?: string): void
  release(): void
}

interface ActiveRequest {
  input: RpaPlanningRequestInput
  controller: AbortController
  timeout: ReturnType<typeof setTimeout>
  token: symbol
}

export class RpaPlanningRequestCoordinator {
  private readonly active = new Map<string, ActiveRequest>()

  start(input: RpaPlanningRequestInput): RpaPlanningRequestHandle {
    const normalized = normalizeInput(input)
    const previous = this.active.get(normalized.sessionId)
    const token = Symbol(normalized.requestId)
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new RpaPlanningRequestError('RPA planning request timed out', 'timed_out'))
    }, normalized.timeoutMs)
    const request: ActiveRequest = { input: normalized, controller, timeout, token }

    if (previous && compareRequestOrder(previous.input, normalized) > 0) {
      clearTimeout(timeout)
      controller.abort(new RpaPlanningRequestError('RPA planning request was superseded before it started', 'stale'))
    } else {
      if (previous) {
        clearTimeout(previous.timeout)
        previous.controller.abort(new RpaPlanningRequestError('RPA planning request was superseded', 'cancelled'))
      }
      this.active.set(normalized.sessionId, request)
    }

    const assertCurrent = (session: RpaDslSession, supplementRevision: number, contextSnapshotId?: string) => {
      const current = this.active.get(normalized.sessionId)
      if (!current || current.token !== token) {
        throw abortReason(controller.signal, 'RPA planning request is no longer current', 'stale')
      }
      if (controller.signal.aborted)
        throw abortReason(controller.signal, 'RPA planning request was cancelled', 'cancelled')
      if (session.id !== normalized.sessionId) throw new RpaPlanningRequestError('Planning Session changed', 'stale')
      if (session.version !== normalized.expectedVersion) {
        throw new RpaPlanningRequestError('Planning expectedVersion is stale', 'stale')
      }
      if (session.activeRevisionVersion !== normalized.baseRevision) {
        throw new RpaPlanningRequestError('Planning baseRevision is stale', 'stale')
      }
      if (supplementRevision !== normalized.supplementRevision) {
        throw new RpaPlanningRequestError('Planning supplementRevision is stale', 'stale')
      }
      if ((contextSnapshotId ?? undefined) !== (normalized.contextSnapshotId ?? undefined)) {
        throw new RpaPlanningRequestError('Planning Context Snapshot is stale', 'stale')
      }
    }

    return {
      input: normalized,
      signal: controller.signal,
      isCurrent: () => this.active.get(normalized.sessionId)?.token === token,
      assertCurrent,
      accept: (session, supplementRevision, contextSnapshotId) => {
        assertCurrent(session, supplementRevision, contextSnapshotId)
        this.release(normalized.sessionId, token)
      },
      release: () => this.release(normalized.sessionId, token)
    }
  }

  cancel(sessionId: string, reason = 'RPA planning request was cancelled by the user'): boolean {
    const current = this.active.get(sessionId)
    if (!current || current.controller.signal.aborted) return false
    clearTimeout(current.timeout)
    current.controller.abort(new RpaPlanningRequestError(reason, 'cancelled'))
    return true
  }

  private release(sessionId: string, token: symbol): void {
    const current = this.active.get(sessionId)
    if (!current || current.token !== token) return
    clearTimeout(current.timeout)
    this.active.delete(sessionId)
  }
}

export function resolveRpaPlanningRequestError(
  error: unknown,
  signal?: AbortSignal
): RpaPlanningRequestError | undefined {
  if (error instanceof RpaPlanningRequestError) return error
  return signal?.reason instanceof RpaPlanningRequestError ? signal.reason : undefined
}

function normalizeInput(input: RpaPlanningRequestInput): RpaPlanningRequestInput {
  const requestId = input.requestId.trim()
  const sessionId = input.sessionId.trim()
  if (!requestId || !sessionId) throw new Error('Planning requestId and sessionId are required')
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new Error('Planning expectedVersion must be a positive integer')
  }
  if (!Number.isInteger(input.supplementRevision) || input.supplementRevision < 0) {
    throw new Error('Planning supplementRevision must be a non-negative integer')
  }
  return {
    ...input,
    requestId,
    sessionId,
    contextSnapshotId: input.contextSnapshotId?.trim() || undefined,
    baseRevision:
      input.baseRevision === undefined ? undefined : Math.max(1, Math.floor(Number(input.baseRevision) || 1)),
    requestedAt: Number.isFinite(input.requestedAt) ? input.requestedAt : Date.now(),
    timeoutMs: Math.max(100, Math.floor(input.timeoutMs))
  }
}

function compareRequestOrder(left: RpaPlanningRequestInput, right: RpaPlanningRequestInput): number {
  if (left.requestedAt !== right.requestedAt) return left.requestedAt - right.requestedAt
  return left.requestId.localeCompare(right.requestId)
}

function abortReason(
  signal: AbortSignal,
  fallback: string,
  status: Exclude<RpaPlanningRequestStatus, 'pending' | 'accepted'>
): RpaPlanningRequestError {
  return signal.reason instanceof RpaPlanningRequestError
    ? signal.reason
    : new RpaPlanningRequestError(fallback, status)
}

export const rpaPlanningRequestCoordinator = new RpaPlanningRequestCoordinator()
