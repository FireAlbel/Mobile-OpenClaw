import { describe, expect, it, vi } from 'vitest'

import type { RpaArtifactStore } from '../RpaArtifactStore'
import { RpaObservationService } from '../RpaObservationService'
import { RpaOcrObservationService } from '../RpaOcrObservationService'
import type { RpaDeviceRuntime } from '../RpaTypes'

function runtime(overrides: Partial<RpaDeviceRuntime> = {}): RpaDeviceRuntime {
  return {
    screenshot: vi.fn().mockResolvedValue({ success: true, message: 'screenshot ok', data: { imageBase64: 'png' } }),
    tap: vi.fn(),
    swipe: vi.fn(),
    key: vi.fn(),
    startApp: vi.fn(),
    getForegroundApp: vi.fn().mockResolvedValue({
      success: true,
      message: 'foreground ok',
      data: { packageName: 'com.example.app' }
    }),
    getScreenSize: vi.fn().mockResolvedValue({
      success: true,
      message: 'size ok',
      data: { width: 1000, height: 2000 }
    }),
    handlePermissionDialog: vi.fn(),
    visionInstruction: vi.fn(),
    ...overrides
  } as RpaDeviceRuntime
}

describe('RpaObservationService', () => {
  it('uses an empty target list when targetTexts is explicitly undefined', async () => {
    const service = new RpaObservationService(runtime())

    const observation = await service.capture('device-1', {
      includeScreenshot: false,
      includeForegroundApp: false,
      includeScreenSize: false,
      targetTexts: undefined
    })

    expect(observation.textCandidates).toEqual([])
  })

  it('captures screenshot, foreground app, and screen size', async () => {
    const service = new RpaObservationService(runtime())

    const observation = await service.capture('device-1')

    expect(observation.deviceId).toBe('device-1')
    expect(observation.screenshot).toEqual({ imageBase64: 'png' })
    expect(observation.foregroundApp).toEqual({ packageName: 'com.example.app' })
    expect(observation.screenSize).toEqual({ width: 1000, height: 2000 })
    expect(observation.warnings).toEqual([])
  })

  it('returns partial observations with warnings when one source fails', async () => {
    const service = new RpaObservationService(
      runtime({
        screenshot: vi.fn().mockResolvedValue({ success: false, message: 'no screenshot' })
      })
    )

    const observation = await service.capture('device-1')

    expect(observation.screenshot).toBeUndefined()
    expect(observation.foregroundApp).toEqual({ packageName: 'com.example.app' })
    expect(observation.warnings).toEqual([{ source: 'screenshot', message: 'no screenshot' }])
  })

  it('captures UI tree and OCR text candidates without requiring VLM', async () => {
    const service = new RpaObservationService(
      runtime({
        screenshot: vi.fn().mockResolvedValue({
          success: true,
          message: 'screenshot ok',
          data: { imageBase64: 'png', mime: 'image/png', width: 500, height: 1000 }
        }),
        getUiTree: vi.fn().mockResolvedValue({
          success: true,
          message: 'ui tree ok',
          data: '<hierarchy><node text="金币" content-desc="" resource-id="coin" class="android.widget.TextView" package="app" clickable="true" enabled="true" bounds="[100,200][300,400]" /></hierarchy>'
        })
      }),
      {
        ocrService: new RpaOcrObservationService({
          recognize: vi.fn().mockResolvedValue({
            providerId: 'test',
            text: '任务列表',
            blocks: [
              {
                text: '任务列表',
                confidence: 0.92,
                bounds: { left: 50, top: 100, right: 250, bottom: 200 }
              }
            ]
          })
        })
      }
    )

    const observation = await service.capture('device-1', {
      includeUiTree: true,
      includeOcr: true,
      targetTexts: ['金币', '任务列表']
    })

    expect(observation.uiTree?.nodes[0].bounds.physical.centerX).toBe(200)
    expect(observation.ocr?.text).toBe('任务列表')
    expect(observation.ocr?.blocks[0]).toMatchObject({
      confidence: 0.92,
      bounds: { physical: { left: 100, top: 200, right: 500, bottom: 400 } }
    })
    expect(observation.textCandidates?.map((candidate) => candidate.source)).toEqual(['ui_tree', 'ocr'])
  })

  it('keeps in-memory evidence and records a warning when artifact persistence fails', async () => {
    const service = new RpaObservationService(
      runtime({
        getUiTree: vi.fn().mockResolvedValue({
          success: true,
          message: 'ui tree ok',
          data: '<hierarchy><node text="账号 13800138000" bounds="[0,0][100,100]" /></hierarchy>'
        })
      }),
      {
        artifactStore: {
          register: vi.fn().mockRejectedValue(new Error('artifact storage unavailable'))
        } as unknown as RpaArtifactStore,
        persistTextFile: vi.fn().mockResolvedValue('ui-tree-file')
      }
    )

    const observation = await service.capture('device-1', { includeUiTree: true, persistEvidence: true })

    expect(observation.uiTree?.nodes).toHaveLength(1)
    expect(observation.warnings).toContainEqual({ source: 'artifact', message: 'artifact storage unavailable' })
  })

  it('redacts sensitive UI text before persisting evidence', async () => {
    const persistTextFile = vi.fn().mockResolvedValue('ui-tree-file')
    const register = vi.fn().mockResolvedValue({ artifact: { id: 'artifact-1' } })
    const service = new RpaObservationService(
      runtime({
        getUiTree: vi.fn().mockResolvedValue({
          success: true,
          message: 'ui tree ok',
          data: '<hierarchy><node text="13800138000" bounds="[0,0][100,100]" /></hierarchy>'
        })
      }),
      {
        artifactStore: { register } as unknown as RpaArtifactStore,
        persistTextFile
      }
    )

    const observation = await service.capture('device-1', { includeUiTree: true, persistEvidence: true })

    expect(observation.uiTree?.xml).toContain('13800138000')
    expect(persistTextFile).toHaveBeenCalledWith(expect.stringContaining('[REDACTED:phone]'), '.xml')
    expect(observation.artifacts.uiTreeArtifactId).toBe('artifact-1')
  })
})
