import { DEFAULT_OCR_PROVIDER } from '@renderer/config/ocr'
import { ocr } from '@renderer/services/ocr/OcrService'
import type { OcrProvider, OcrResultBlock } from '@renderer/types'

import { RpaCoordinateMapper } from './RpaCoordinateMapper'
import type { RpaOcrObservation } from './RpaTypes'

export interface RpaOcrCaptureInput {
  screenshot: { imageBase64: string; mime?: string; width?: number; height?: number }
  physicalSize: { width: number; height: number }
  provider?: OcrProvider
}

export interface RpaOcrObservationServiceOptions {
  recognize?: (input: RpaOcrCaptureInput) => Promise<{ providerId: string; text: string; blocks?: OcrResultBlock[] }>
}

export class RpaOcrObservationService {
  constructor(private readonly options: RpaOcrObservationServiceOptions = {}) {}

  async capture(input: RpaOcrCaptureInput): Promise<RpaOcrObservation> {
    const recognized = this.options.recognize
      ? await this.options.recognize(input)
      : await this.recognizeWithConfiguredProvider(input)
    const text = recognized.text.trim()
    const screenshotSize = resolveScreenshotSize(input)
    const mapper = new RpaCoordinateMapper({ physical: input.physicalSize, screenshot: screenshotSize })
    const fullScreenBounds = mapper.normalizePhysicalBounds({
      left: 0,
      top: 0,
      right: input.physicalSize.width,
      bottom: input.physicalSize.height
    })
    return {
      providerId: recognized.providerId,
      text,
      blocks: recognized.blocks?.length
        ? recognized.blocks
            .filter((block) => block.text.trim())
            .map((block, index) => ({
              id: `ocr-block-${index + 1}`,
              text: block.text.trim(),
              confidence: normalizeConfidence(block.confidence),
              bounds: mapper.normalizeScreenshotBounds(block.bounds)
            }))
        : text
          ? [
              {
                id: 'ocr-block-1',
                text,
                confidence: 0.5,
                bounds: fullScreenBounds,
                approximate: true
              }
            ]
          : [],
      capturedAt: Date.now()
    }
  }

  findByText(observation: RpaOcrObservation, target: string, exact = false) {
    const normalizedTarget = normalizeText(target)
    if (!normalizedTarget) return []
    return observation.blocks.filter((block) => {
      const normalizedText = normalizeText(block.text)
      return exact ? normalizedText === normalizedTarget : normalizedText.includes(normalizedTarget)
    })
  }

  private async recognizeWithConfiguredProvider(
    input: RpaOcrCaptureInput
  ): Promise<{ providerId: string; text: string; blocks?: OcrResultBlock[] }> {
    const provider = input.provider ?? DEFAULT_OCR_PROVIDER.image
    const data = input.screenshot.imageBase64.startsWith('data:')
      ? input.screenshot.imageBase64
      : `data:${input.screenshot.mime ?? 'image/png'};base64,${input.screenshot.imageBase64}`
    const file = await window.api.file.saveBase64Image(data)
    try {
      const result = await ocr(file, provider)
      return { providerId: provider.id, text: result.text, blocks: result.blocks }
    } finally {
      if (file.path) await window.api.file.deleteExternalFile(file.path).catch(() => undefined)
    }
  }
}

function resolveScreenshotSize(input: RpaOcrCaptureInput): { width: number; height: number } | undefined {
  return typeof input.screenshot.width === 'number' && typeof input.screenshot.height === 'number'
    ? { width: input.screenshot.width, height: input.screenshot.height }
    : undefined
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0, value > 1 ? value / 100 : value))
}

export const rpaOcrObservationService = new RpaOcrObservationService()
