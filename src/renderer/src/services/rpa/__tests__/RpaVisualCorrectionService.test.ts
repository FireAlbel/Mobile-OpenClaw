import { describe, expect, it, vi } from 'vitest'

import type { RpaModelClient } from '../RpaModelClient'
import type { RpaDeviceObservation } from '../RpaTypes'
import { RpaVisualCorrectionService } from '../RpaVisualCorrectionService'

function modelClient(response: string): RpaModelClient {
  return {
    complete: vi.fn().mockResolvedValue(response)
  }
}

function observation(): RpaDeviceObservation {
  return {
    deviceId: 'device-1',
    capturedAt: 1,
    screenshot: { imageBase64: 'png', mime: 'image/png' },
    screenSize: { width: 1000, height: 2000 },
    warnings: [],
    artifacts: {}
  }
}

describe('RpaVisualCorrectionService', () => {
  it('returns bbox center for confident visual target', async () => {
    const service = new RpaVisualCorrectionService({
      modelClient: modelClient(
        JSON.stringify({
          found: true,
          action: 'tap',
          bbox: { x: 10, y: 20, width: 100, height: 80 },
          confidence: 0.9,
          reason: 'target visible'
        })
      )
    })

    const result = await service.locate({ deviceId: 'device-1', target: 'coin', observation: observation() })

    expect(result.status).toBe('found')
    expect(result.point).toEqual({ x: 60, y: 60 })
  })

  it('marks low confidence responses as low_confidence', async () => {
    const service = new RpaVisualCorrectionService({
      modelClient: modelClient(
        JSON.stringify({
          found: true,
          action: 'tap',
          bbox: { x: 10, y: 20, width: 100, height: 80 },
          confidence: 0.2
        })
      )
    })

    const result = await service.locate({
      deviceId: 'device-1',
      target: 'coin',
      observation: observation(),
      minConfidence: 0.8
    })

    expect(result.status).toBe('low_confidence')
  })

  it('rejects invalid structured responses', async () => {
    const service = new RpaVisualCorrectionService({
      modelClient: modelClient(JSON.stringify({ found: true, confidence: 2 }))
    })

    const result = await service.locate({ deviceId: 'device-1', target: 'coin', observation: observation() })

    expect(result.status).toBe('invalid')
  })
})
