import { describe, expect, it } from 'vitest'

import { RpaHumanizedInputPolicy } from '../RpaHumanizedInputPolicy'

describe('RpaHumanizedInputPolicy', () => {
  it('creates reproducible bounded tap coordinates', () => {
    const first = new RpaHumanizedInputPolicy().createTap('device-1', { x: 100, y: 200 }, { seed: 42 })
    const second = new RpaHumanizedInputPolicy().createTap('device-1', { x: 100, y: 200 }, { seed: 42 })

    expect(first).toEqual(second)
    expect(Math.hypot(first.actual.x - 100, first.actual.y - 200)).toBeLessThanOrEqual(8)
  })

  it('creates a reproducible eased Bezier path with fixed endpoints', () => {
    const trace = new RpaHumanizedInputPolicy().createSwipe('device-1', { x: 500, y: 1800 }, { x: 500, y: 500 }, 600, {
      seed: 'run-1',
      pathSamples: 10
    })

    expect(trace.path).toHaveLength(10)
    expect(trace.path[0]).toEqual({ x: 500, y: 1800 })
    expect(trace.path.at(-1)).toEqual({ x: 500, y: 500 })
    expect(trace.controlPoints.some((point) => point.x !== 500)).toBe(true)
  })
})
