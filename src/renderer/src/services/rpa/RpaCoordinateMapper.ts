import type { RpaBounds, RpaNormalizedBounds, RpaPoint } from './RpaTypes'

export interface RpaCoordinateSpace {
  width: number
  height: number
}

export interface RpaCoordinateMappingInput {
  physical: RpaCoordinateSpace
  screenshot?: RpaCoordinateSpace
}

export class RpaCoordinateMapper {
  constructor(private readonly spaces: RpaCoordinateMappingInput) {
    assertSpace(spaces.physical, 'physical')
    if (spaces.screenshot) assertSpace(spaces.screenshot, 'screenshot')
  }

  normalizePhysicalBounds(bounds: Pick<RpaBounds, 'left' | 'top' | 'right' | 'bottom'>): RpaNormalizedBounds {
    const physical = createBounds(bounds, this.spaces.physical)
    return {
      physical,
      screenshot: this.spaces.screenshot
        ? createBounds(
            {
              left: scale(physical.left, this.spaces.physical.width, this.spaces.screenshot.width),
              top: scale(physical.top, this.spaces.physical.height, this.spaces.screenshot.height),
              right: scale(physical.right, this.spaces.physical.width, this.spaces.screenshot.width),
              bottom: scale(physical.bottom, this.spaces.physical.height, this.spaces.screenshot.height)
            },
            this.spaces.screenshot
          )
        : undefined
    }
  }

  screenshotPointToPhysical(point: RpaPoint): RpaPoint {
    if (!this.spaces.screenshot) return clampPoint(point, this.spaces.physical)
    return clampPoint(
      {
        x: scale(point.x, this.spaces.screenshot.width, this.spaces.physical.width),
        y: scale(point.y, this.spaces.screenshot.height, this.spaces.physical.height)
      },
      this.spaces.physical
    )
  }

  normalizeScreenshotBounds(bounds: Pick<RpaBounds, 'left' | 'top' | 'right' | 'bottom'>): RpaNormalizedBounds {
    if (!this.spaces.screenshot) return this.normalizePhysicalBounds(bounds)
    const screenshot = createBounds(bounds, this.spaces.screenshot)
    const physical = createBounds(
      {
        left: scale(screenshot.left, this.spaces.screenshot.width, this.spaces.physical.width),
        top: scale(screenshot.top, this.spaces.screenshot.height, this.spaces.physical.height),
        right: scale(screenshot.right, this.spaces.screenshot.width, this.spaces.physical.width),
        bottom: scale(screenshot.bottom, this.spaces.screenshot.height, this.spaces.physical.height)
      },
      this.spaces.physical
    )
    return { physical, screenshot }
  }
}

export function parseAndroidBounds(value: string): Pick<RpaBounds, 'left' | 'top' | 'right' | 'bottom'> | undefined {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(value.trim())
  if (!match) return undefined
  const left = Number(match[1])
  const top = Number(match[2])
  const right = Number(match[3])
  const bottom = Number(match[4])
  if (right <= left || bottom <= top) return undefined
  return { left, top, right, bottom }
}

function createBounds(
  bounds: Pick<RpaBounds, 'left' | 'top' | 'right' | 'bottom'>,
  space: RpaCoordinateSpace
): RpaBounds {
  const left = clamp(Math.round(bounds.left), 0, Math.max(0, space.width - 1))
  const top = clamp(Math.round(bounds.top), 0, Math.max(0, space.height - 1))
  const right = clamp(Math.round(bounds.right), left + 1, space.width)
  const bottom = clamp(Math.round(bounds.bottom), top + 1, space.height)
  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    centerX: Math.round((left + right) / 2),
    centerY: Math.round((top + bottom) / 2)
  }
}

function clampPoint(point: RpaPoint, space: RpaCoordinateSpace): RpaPoint {
  return {
    x: clamp(Math.round(point.x), 0, Math.max(0, space.width - 1)),
    y: clamp(Math.round(point.y), 0, Math.max(0, space.height - 1))
  }
}

function scale(value: number, source: number, target: number): number {
  return (value / source) * target
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function assertSpace(space: RpaCoordinateSpace, name: string): void {
  if (!Number.isFinite(space.width) || !Number.isFinite(space.height) || space.width <= 0 || space.height <= 0) {
    throw new Error(`Invalid ${name} coordinate space`)
  }
}
