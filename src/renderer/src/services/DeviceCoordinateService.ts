import type { DeviceScreenSize, ScrcpyWindowInfo } from './DeviceServiceProxy'

export interface DevicePoint {
  x: number
  y: number
}

export interface DeviceRectAction {
  x1: number
  y1: number
  x2: number
  y2: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max)
}

function parseAxisCoordinate(value: string, max: number): number | null {
  const normalized = value.trim()
  if (!normalized) {
    return null
  }

  if (normalized.endsWith('%')) {
    const percent = Number(normalized.slice(0, -1))
    if (!Number.isFinite(percent)) {
      return null
    }
    return clamp((percent / 100) * max, 0, max - 1)
  }

  const numeric = Number(normalized)
  if (!Number.isFinite(numeric)) {
    return null
  }

  return clamp(numeric, 0, max - 1)
}

export class DeviceCoordinateService {
  parsePoint(x: string, y: string, screen: DeviceScreenSize): DevicePoint | null {
    const parsedX = parseAxisCoordinate(x, screen.width)
    const parsedY = parseAxisCoordinate(y, screen.height)
    if (parsedX === null || parsedY === null) {
      return null
    }

    return {
      x: parsedX,
      y: parsedY
    }
  }

  parseRectAction(x1: string, y1: string, x2: string, y2: string, screen: DeviceScreenSize): DeviceRectAction | null {
    const start = this.parsePoint(x1, y1, screen)
    const end = this.parsePoint(x2, y2, screen)
    if (!start || !end) {
      return null
    }

    return {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y
    }
  }

  mapWindowPointToDevice(
    point: DevicePoint,
    windowInfo: Pick<ScrcpyWindowInfo, 'width' | 'height'>,
    screen: DeviceScreenSize
  ): DevicePoint {
    return {
      x: clamp((point.x / windowInfo.width) * screen.width, 0, screen.width - 1),
      y: clamp((point.y / windowInfo.height) * screen.height, 0, screen.height - 1)
    }
  }
}

export const deviceCoordinateService = new DeviceCoordinateService()
