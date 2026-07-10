import { describe, expect, it } from 'vitest'

import { deviceCoordinateService } from '../DeviceCoordinateService'

describe('DeviceCoordinateService', () => {
  const screen = { width: 1000, height: 2000 }

  it('parses absolute point coordinates', () => {
    expect(deviceCoordinateService.parsePoint('100', '300', screen)).toEqual({ x: 100, y: 300 })
  })

  it('parses percentage point coordinates', () => {
    expect(deviceCoordinateService.parsePoint('50%', '80%', screen)).toEqual({ x: 500, y: 1600 })
  })

  it('clamps coordinates to screen bounds', () => {
    expect(deviceCoordinateService.parsePoint('2000', '-10', screen)).toEqual({ x: 999, y: 0 })
  })

  it('maps scrcpy window coordinates to device coordinates', () => {
    expect(
      deviceCoordinateService.mapWindowPointToDevice({ x: 250, y: 400 }, { width: 500, height: 800 }, screen)
    ).toEqual({ x: 500, y: 1000 })
  })

  it('returns null for invalid coordinates', () => {
    expect(deviceCoordinateService.parsePoint('left', '80%', screen)).toBeNull()
  })
})
