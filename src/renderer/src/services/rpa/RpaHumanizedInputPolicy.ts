import type { RpaHumanizedInputOptions, RpaHumanizedSwipeTrace, RpaHumanizedTapTrace, RpaPoint } from './RpaTypes'

const DEFAULT_DELAY = { min: 35, max: 110 }

interface DevicePolicyState {
  seed: number
  sequence: number
}

export class RpaHumanizedInputPolicy {
  private readonly states = new Map<string, DevicePolicyState>()

  createTap(deviceId: string, requested: RpaPoint, options: RpaHumanizedInputOptions = {}): RpaHumanizedTapTrace {
    const state = this.nextState(deviceId, options.seed)
    const random = seededRandom(state.seed)
    const enabled = options.enabled !== false
    const radius = enabled ? clamp(options.randomRadiusPx ?? 7, 0, 24) : 0
    const angle = random() * Math.PI * 2
    const distance = Math.sqrt(random()) * radius
    const actual = {
      x: Math.max(0, Math.round(requested.x + Math.cos(angle) * distance)),
      y: Math.max(0, Math.round(requested.y + Math.sin(angle) * distance))
    }
    return {
      kind: 'tap',
      seed: state.seed,
      sequence: state.sequence,
      requested: roundPoint(requested),
      actual,
      delayBeforeMs: enabled ? randomInteger(random, options.delayBeforeMs ?? DEFAULT_DELAY) : 0,
      randomRadiusPx: radius
    }
  }

  createTapInBounds(
    deviceId: string,
    bounds: { left: number; top: number; right: number; bottom: number },
    options: RpaHumanizedInputOptions = {}
  ): RpaHumanizedTapTrace {
    const inset = Math.max(0, Math.round(options.safeInsetPx ?? 4))
    const left = Math.min(bounds.right, bounds.left + inset)
    const top = Math.min(bounds.bottom, bounds.top + inset)
    const right = Math.max(left, bounds.right - inset)
    const bottom = Math.max(top, bounds.bottom - inset)
    const center = { x: (left + right) / 2, y: (top + bottom) / 2 }
    const maxRadius = Math.max(0, Math.min((right - left) / 2, (bottom - top) / 2, options.randomRadiusPx ?? 7))
    return this.createTap(deviceId, center, { ...options, randomRadiusPx: maxRadius })
  }

  createSwipe(
    deviceId: string,
    start: RpaPoint,
    end: RpaPoint,
    durationMs: number,
    options: RpaHumanizedInputOptions = {}
  ): RpaHumanizedSwipeTrace {
    const state = this.nextState(deviceId, options.seed)
    const random = seededRandom(state.seed)
    const enabled = options.enabled !== false
    const samples = clamp(Math.round(options.pathSamples ?? 12), 4, 32)
    const dx = end.x - start.x
    const dy = end.y - start.y
    const distance = Math.max(1, Math.hypot(dx, dy))
    const normal = { x: -dy / distance, y: dx / distance }
    const curveStrength = enabled ? clamp(options.curveStrength ?? 0.055, 0, 0.16) : 0
    const bend = distance * curveStrength * (random() < 0.5 ? -1 : 1) * (0.7 + random() * 0.6)
    const control1 = {
      x: start.x + dx * (0.28 + random() * 0.08) + normal.x * bend,
      y: start.y + dy * (0.28 + random() * 0.08) + normal.y * bend
    }
    const control2 = {
      x: start.x + dx * (0.66 + random() * 0.08) + normal.x * bend * 0.7,
      y: start.y + dy * (0.66 + random() * 0.08) + normal.y * bend * 0.7
    }
    const path = Array.from({ length: samples }, (_, index) => {
      const progress = index / (samples - 1)
      const eased = easeInOutCubic(progress)
      return roundPoint(cubicBezier(start, control1, control2, end, eased))
    })
    return {
      kind: 'swipe',
      seed: state.seed,
      sequence: state.sequence,
      requested: { start: roundPoint(start), end: roundPoint(end), durationMs: Math.round(durationMs) },
      controlPoints: [roundPoint(control1), roundPoint(control2)],
      path,
      delayBeforeMs: enabled ? randomInteger(random, options.delayBeforeMs ?? DEFAULT_DELAY) : 0,
      durationMs: Math.max(100, Math.round(durationMs * (enabled ? 0.92 + random() * 0.16 : 1)))
    }
  }

  private nextState(deviceId: string, seedOverride?: number | string): DevicePolicyState {
    const current = this.states.get(deviceId) ?? { seed: hashSeed(deviceId), sequence: 0 }
    const sequence = current.sequence + 1
    const baseSeed = seedOverride === undefined ? current.seed : hashSeed(String(seedOverride))
    const next = { seed: mixSeed(baseSeed, sequence), sequence }
    this.states.set(deviceId, { seed: baseSeed, sequence })
    return next
  }
}

function cubicBezier(p0: RpaPoint, p1: RpaPoint, p2: RpaPoint, p3: RpaPoint, t: number): RpaPoint {
  const inverse = 1 - t
  return {
    x: inverse ** 3 * p0.x + 3 * inverse ** 2 * t * p1.x + 3 * inverse * t ** 2 * p2.x + t ** 3 * p3.x,
    y: inverse ** 3 * p0.y + 3 * inverse ** 2 * t * p1.y + 3 * inverse * t ** 2 * p2.y + t ** 3 * p3.y
  }
}

function easeInOutCubic(value: number): number {
  return value < 0.5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function hashSeed(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mixSeed(seed: number, sequence: number): number {
  return (seed ^ Math.imul(sequence, 0x9e3779b1)) >>> 0
}

function randomInteger(random: () => number, range: { min: number; max: number }): number {
  const min = Math.max(0, Math.round(Math.min(range.min, range.max)))
  const max = Math.max(min, Math.round(Math.max(range.min, range.max)))
  return Math.round(min + random() * (max - min))
}

function roundPoint(point: RpaPoint): RpaPoint {
  return { x: Math.max(0, Math.round(point.x)), y: Math.max(0, Math.round(point.y)) }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export const rpaHumanizedInputPolicy = new RpaHumanizedInputPolicy()
