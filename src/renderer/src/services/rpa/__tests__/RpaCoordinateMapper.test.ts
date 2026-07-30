import { describe, expect, it } from 'vitest'

import { parseAndroidBounds, RpaCoordinateMapper } from '../RpaCoordinateMapper'

describe('RpaCoordinateMapper', () => {
  it('maps physical UI bounds into screenshot coordinates', () => {
    const mapper = new RpaCoordinateMapper({
      physical: { width: 1080, height: 2400 },
      screenshot: { width: 540, height: 1200 }
    })

    const bounds = mapper.normalizePhysicalBounds({ left: 100, top: 200, right: 500, bottom: 600 })

    expect(bounds.physical).toMatchObject({ left: 100, top: 200, right: 500, bottom: 600 })
    expect(bounds.screenshot).toMatchObject({ left: 50, top: 100, right: 250, bottom: 300 })
  })

  it('parses Android bounds and rejects invalid rectangles', () => {
    expect(parseAndroidBounds('[10,20][110,220]')).toEqual({ left: 10, top: 20, right: 110, bottom: 220 })
    expect(parseAndroidBounds('[10,20][10,220]')).toBeUndefined()
    expect(parseAndroidBounds('invalid')).toBeUndefined()
  })
})
