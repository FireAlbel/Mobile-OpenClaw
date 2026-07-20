import { describe, expect, it } from 'vitest'

import { RpaTextResponseCollector } from '../RpaModelClient'

describe('RpaTextResponseCollector', () => {
  it('uses the complete chunk as the authoritative response', () => {
    const collector = new RpaTextResponseCollector()

    collector.addDelta('{"id"')
    collector.addDelta(':"task-1"}')
    collector.complete('{"id":"task-1"}')

    expect(collector.text).toBe('{"id":"task-1"}')
  })

  it('supports providers that emit cumulative delta chunks', () => {
    const collector = new RpaTextResponseCollector()

    collector.addDelta('{"id"')
    collector.addDelta('{"id":"task-1"}')

    expect(collector.text).toBe('{"id":"task-1"}')
  })

  it('supports providers that emit incremental delta chunks', () => {
    const collector = new RpaTextResponseCollector()

    collector.addDelta('{"id"')
    collector.addDelta(':"task-1"}')

    expect(collector.text).toBe('{"id":"task-1"}')
  })
})
