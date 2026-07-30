import { describe, expect, it } from 'vitest'

import {
  RpaSessionTelemetryService,
  type RpaSessionTelemetrySnapshot,
  type RpaSessionTelemetryStorage
} from '../RpaSessionTelemetryService'

class MemoryStorage implements RpaSessionTelemetryStorage {
  snapshot?: RpaSessionTelemetrySnapshot
  load() {
    return this.snapshot ? structuredClone(this.snapshot) : undefined
  }
  save(snapshot: RpaSessionTelemetrySnapshot) {
    this.snapshot = structuredClone(snapshot)
  }
}

describe('RpaSessionTelemetryService', () => {
  it('records bounded counters and sanitized recent audit context', () => {
    const storage = new MemoryStorage()
    let now = 10
    const service = new RpaSessionTelemetryService(storage, () => ++now, 2)
    service.record('compatibility_routing', { reason: ' pending gate ' })
    service.record('stale_revision', { sessionId: ` ${'s'.repeat(300)} `, requestId: 'request-1' })
    service.record('successful_dsl_revision', { sessionId: 'session-1' })

    expect(service.getSnapshot()).toMatchObject({
      counters: {
        compatibility_routing: 1,
        stale_revision: 1,
        successful_dsl_revision: 1
      },
      recentEvents: [
        expect.objectContaining({ type: 'stale_revision', requestId: 'request-1' }),
        expect.objectContaining({ type: 'successful_dsl_revision', sessionId: 'session-1' })
      ]
    })
    expect(service.getSnapshot().recentEvents[0].sessionId).toHaveLength(256)
  })

  it('keeps independent rollback and generic-fallback evidence', () => {
    const service = new RpaSessionTelemetryService(new MemoryStorage(), () => 20)
    service.record('rollback_routing', { reason: 'rollback active' })
    service.record('generic_fallback_attempt', { reason: 'Role input was blocked' })
    expect(service.getSnapshot().counters).toMatchObject({
      rollback_routing: 1,
      generic_fallback_attempt: 1
    })
  })
})
