import { describe, expect, it, vi } from 'vitest'

import type { RpaDslSession } from '../RpaDslSession'
import { RpaPlanningRequestCoordinator, RpaPlanningRequestError } from '../RpaPlanningRequestCoordinator'

function session(version = 3, activeRevisionVersion = 1): RpaDslSession {
  return { id: 'session-1', version, activeRevisionVersion } as RpaDslSession
}

describe('RpaPlanningRequestCoordinator', () => {
  it('uses latest-wins ordering and cancels an older in-flight request', () => {
    const coordinator = new RpaPlanningRequestCoordinator()
    const first = coordinator.start({
      requestId: 'request-1',
      sessionId: 'session-1',
      baseRevision: 1,
      expectedVersion: 3,
      supplementRevision: 0,
      requestedAt: 1,
      timeoutMs: 1_000
    })
    const second = coordinator.start({
      requestId: 'request-2',
      sessionId: 'session-1',
      baseRevision: 1,
      expectedVersion: 3,
      supplementRevision: 0,
      requestedAt: 2,
      timeoutMs: 1_000
    })

    expect(first.signal.aborted).toBe(true)
    expect(first.signal.reason).toMatchObject({ status: 'cancelled' })
    expect(() => first.assertCurrent(session(), 0)).toThrow(RpaPlanningRequestError)
    expect(() => second.assertCurrent(session(), 0)).not.toThrow()
    second.accept(session(), 0)
  })

  it('does not let an older request that starts late replace a newer request', () => {
    const coordinator = new RpaPlanningRequestCoordinator()
    const newer = coordinator.start({
      requestId: 'request-2',
      sessionId: 'session-1',
      baseRevision: 1,
      expectedVersion: 3,
      supplementRevision: 0,
      requestedAt: 2,
      timeoutMs: 1_000
    })
    const older = coordinator.start({
      requestId: 'request-1',
      sessionId: 'session-1',
      baseRevision: 1,
      expectedVersion: 3,
      supplementRevision: 0,
      requestedAt: 1,
      timeoutMs: 1_000
    })

    expect(older.signal.reason).toMatchObject({ status: 'stale' })
    expect(() => newer.assertCurrent(session(), 0)).not.toThrow()
    newer.release()
  })

  it('rejects changed Session versions and base revisions', () => {
    const coordinator = new RpaPlanningRequestCoordinator()
    const request = coordinator.start({
      requestId: 'request-1',
      sessionId: 'session-1',
      baseRevision: 1,
      expectedVersion: 3,
      supplementRevision: 2,
      contextSnapshotId: 'snapshot-1',
      requestedAt: 1,
      timeoutMs: 1_000
    })

    expect(() => request.assertCurrent(session(4, 1), 2)).toThrow('expectedVersion is stale')
    expect(() => request.assertCurrent(session(3, 2), 2)).toThrow('baseRevision is stale')
    expect(() => request.assertCurrent(session(3, 1), 3)).toThrow('supplementRevision is stale')
    expect(() => request.assertCurrent(session(3, 1), 2, 'snapshot-2')).toThrow('Context Snapshot is stale')
    expect(() => request.assertCurrent(session(3, 1), 2, 'snapshot-1')).not.toThrow()
    request.release()
  })

  it('aborts timed-out requests with a typed status', async () => {
    vi.useFakeTimers()
    const coordinator = new RpaPlanningRequestCoordinator()
    const request = coordinator.start({
      requestId: 'request-1',
      sessionId: 'session-1',
      baseRevision: 1,
      expectedVersion: 3,
      supplementRevision: 0,
      requestedAt: 1,
      timeoutMs: 100
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(request.signal.reason).toMatchObject({ status: 'timed_out' })
    request.release()
    vi.useRealTimers()
  })

  it('supports explicit user cancellation while retaining restoration ownership', () => {
    const coordinator = new RpaPlanningRequestCoordinator()
    const request = coordinator.start({
      requestId: 'request-1',
      sessionId: 'session-1',
      baseRevision: 1,
      expectedVersion: 3,
      supplementRevision: 0,
      requestedAt: 1,
      timeoutMs: 1_000
    })

    expect(coordinator.cancel('session-1')).toBe(true)
    expect(request.signal.reason).toMatchObject({ status: 'cancelled' })
    expect(request.isCurrent()).toBe(true)
    request.release()
  })
})
