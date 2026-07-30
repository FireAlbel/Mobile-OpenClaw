import { describe, expect, it } from 'vitest'

import { resolveStableRpaTaskSessionState, type RpaTaskInteractionEvent } from '../RpaTaskSessionProtocol'

describe('RpaTaskSessionProtocol', () => {
  it('restores the last non-planning state across overlapping requests', () => {
    const events: RpaTaskInteractionEvent[] = [
      {
        id: 'event-1',
        requestId: 'request-1',
        outcome: 'create_dsl',
        phase: 'received',
        input: 'First request',
        stateBefore: 'empty',
        stateAfter: 'planning',
        createdAt: 1
      },
      {
        id: 'event-2',
        requestId: 'request-2',
        outcome: 'create_dsl',
        phase: 'received',
        input: 'Second request',
        stateBefore: 'planning',
        stateAfter: 'planning',
        createdAt: 2
      }
    ]

    expect(resolveStableRpaTaskSessionState('planning', events)).toBe('empty')
    expect(resolveStableRpaTaskSessionState('ready', events)).toBe('ready')
  })
})
