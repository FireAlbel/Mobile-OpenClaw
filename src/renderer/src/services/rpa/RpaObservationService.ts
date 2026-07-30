import { loggerService } from '@logger'

import { type RpaArtifactStore, rpaArtifactStore } from './RpaArtifactStore'
import { redactRpaKnowledgeText } from './RpaKnowledge'
import type { RpaOcrObservationService } from './RpaOcrObservationService'
import { rpaOcrObservationService } from './RpaOcrObservationService'
import type { RpaDeviceObservation, RpaDeviceRuntime, RpaObservationOptions, RpaObservationWarning } from './RpaTypes'
import type { RpaUiTreeService } from './RpaUiTreeService'
import { rpaUiTreeService } from './RpaUiTreeService'

const logger = loggerService.withContext('RpaObservationService')

type ResolvedRpaObservationOptions = Required<Omit<RpaObservationOptions, 'artifactContext'>> &
  Pick<RpaObservationOptions, 'artifactContext'>

const defaultObservationOptions: ResolvedRpaObservationOptions = {
  includeScreenshot: true,
  includeForegroundApp: true,
  includeScreenSize: true,
  includeUiTree: false,
  includeOcr: false,
  targetTexts: [],
  persistEvidence: false,
  artifactContext: undefined
}

export interface RpaObservationServiceDependencies {
  uiTreeService?: RpaUiTreeService
  ocrService?: RpaOcrObservationService
  artifactStore?: RpaArtifactStore
  persistTextFile?: (content: string, extension: '.xml' | '.json') => Promise<string>
}

export class RpaObservationService {
  private readonly uiTreeService: RpaUiTreeService
  private readonly ocrService: RpaOcrObservationService
  private readonly artifactStore: RpaArtifactStore
  private readonly persistTextFile: (content: string, extension: '.xml' | '.json') => Promise<string>

  constructor(
    private readonly runtime: RpaDeviceRuntime,
    dependencies: RpaObservationServiceDependencies = {}
  ) {
    this.uiTreeService = dependencies.uiTreeService ?? rpaUiTreeService
    this.ocrService = dependencies.ocrService ?? rpaOcrObservationService
    this.artifactStore = dependencies.artifactStore ?? rpaArtifactStore
    this.persistTextFile = dependencies.persistTextFile ?? this.persistTextFileToLibrary.bind(this)
  }

  async capture(deviceId: string, options: RpaObservationOptions = {}): Promise<RpaDeviceObservation> {
    const resolvedOptions: ResolvedRpaObservationOptions = {
      ...defaultObservationOptions,
      ...options,
      targetTexts: options.targetTexts ?? defaultObservationOptions.targetTexts
    }
    const warnings: RpaObservationWarning[] = []
    const artifacts: Record<string, unknown> = {}
    const observation: RpaDeviceObservation = {
      deviceId,
      capturedAt: Date.now(),
      warnings,
      artifacts
    }

    if (resolvedOptions.includeScreenshot) {
      const screenshot = await this.runtime.screenshot(deviceId)
      if (screenshot.success && screenshot.data) {
        observation.screenshot = screenshot.data
        artifacts.screenshot = screenshot.data
      } else {
        this.addWarning(warnings, 'screenshot', screenshot.message)
      }
    }

    if (resolvedOptions.includeForegroundApp) {
      const foregroundApp = await this.runtime.getForegroundApp(deviceId)
      if (foregroundApp.success && foregroundApp.data) {
        observation.foregroundApp = foregroundApp.data
      } else {
        this.addWarning(warnings, 'foreground_app', foregroundApp.message)
      }
    }

    if (resolvedOptions.includeScreenSize) {
      const screenSize = await this.runtime.getScreenSize(deviceId)
      if (screenSize.success && screenSize.data) {
        observation.screenSize = screenSize.data
      } else {
        this.addWarning(warnings, 'screen_size', screenSize.message)
      }
    }

    const screenshotSize = resolveScreenshotSize(observation.screenshot)
    const physicalSize = observation.screenSize ?? screenshotSize

    if (resolvedOptions.includeUiTree) {
      const uiTree = this.runtime.getUiTree
        ? await this.runtime.getUiTree(deviceId)
        : { success: false, message: 'UI tree runtime is unavailable', startedAt: Date.now(), finishedAt: Date.now() }
      if (uiTree.success && uiTree.data && physicalSize) {
        try {
          observation.uiTree = this.uiTreeService.parse(uiTree.data, {
            physicalSize,
            screenshotSize,
            capturedAt: observation.capturedAt
          })
          artifacts.uiTree = observation.uiTree
        } catch (error) {
          this.addWarning(warnings, 'ui_tree', error instanceof Error ? error.message : String(error))
        }
      } else {
        this.addWarning(
          warnings,
          physicalSize ? 'ui_tree' : 'coordinate_mapping',
          physicalSize ? uiTree.message : 'Screen dimensions unavailable for UI tree normalization'
        )
      }
    }

    if (resolvedOptions.includeOcr) {
      const screenshot = resolveScreenshot(observation.screenshot)
      if (screenshot && physicalSize) {
        try {
          observation.ocr = await this.ocrService.capture({ screenshot, physicalSize })
          artifacts.ocr = observation.ocr
        } catch (error) {
          this.addWarning(warnings, 'ocr', error instanceof Error ? error.message : String(error))
        }
      } else {
        this.addWarning(
          warnings,
          screenshot ? 'coordinate_mapping' : 'ocr',
          screenshot ? 'Screen dimensions unavailable for OCR normalization' : 'Screenshot unavailable for OCR'
        )
      }
    }

    observation.textCandidates = this.collectTextCandidates(observation, resolvedOptions.targetTexts)

    if (resolvedOptions.persistEvidence) {
      await this.persistEvidence(observation, resolvedOptions).catch((error) => {
        this.addWarning(warnings, 'artifact', error instanceof Error ? error.message : String(error))
      })
    }

    if (warnings.length) {
      logger.warn('RPA observation captured with warnings', { deviceId, warnings })
    }

    return observation
  }

  private addWarning(
    warnings: RpaObservationWarning[],
    source: RpaObservationWarning['source'],
    message: string
  ): void {
    warnings.push({ source, message })
  }

  private collectTextCandidates(observation: RpaDeviceObservation, targets: string[]) {
    const normalizedTargets = targets.map(normalizeText).filter(Boolean)
    const matchesTarget = (text: string) =>
      normalizedTargets.length === 0 || normalizedTargets.some((target) => normalizeText(text).includes(target))
    return [
      ...(observation.uiTree?.nodes ?? [])
        .flatMap((node) => [node.text, node.contentDescription].filter(Boolean).map((text) => ({ node, text })))
        .filter(({ text }) => matchesTarget(text))
        .map(({ node, text }) => ({
          source: 'ui_tree' as const,
          text,
          confidence: 1,
          bounds: node.bounds,
          nodeId: node.id
        })),
      ...(observation.ocr?.blocks ?? [])
        .filter((block) => matchesTarget(block.text))
        .map((block) => ({
          source: 'ocr' as const,
          text: block.text,
          confidence: block.confidence,
          bounds: block.bounds,
          approximate: block.approximate
        }))
    ]
  }

  private async persistEvidence(
    observation: RpaDeviceObservation,
    options: ResolvedRpaObservationOptions
  ): Promise<void> {
    const links = options.artifactContext
      ? [
          {
            targetType: options.artifactContext.targetType,
            targetId: options.artifactContext.targetId,
            relation: options.artifactContext.relation ?? 'observation_evidence'
          }
        ]
      : []
    if (observation.uiTree) {
      const persistedXml = redactForEvidence(observation.uiTree.xml)
      const externalPath = await this.persistTextFile(persistedXml, '.xml')
      const result = await this.artifactStore.register({
        category: 'ui_tree',
        title: `UI tree ${observation.deviceId}`,
        sizeBytes: byteLength(persistedXml),
        source: 'observation',
        contentHash: contentHash(persistedXml),
        locator: { externalPath, extension: '.xml', mimeType: 'application/xml' },
        links,
        retentionPolicy: 'temporary',
        textForRedaction: observation.uiTree.xml
      })
      observation.artifacts.uiTreeArtifactId = result.artifact.id
    }
    if (observation.ocr) {
      const serialized = JSON.stringify(observation.ocr)
      const persistedOcr = redactForEvidence(serialized)
      const externalPath = await this.persistTextFile(persistedOcr, '.json')
      const result = await this.artifactStore.register({
        category: 'ocr_capture',
        title: `OCR capture ${observation.deviceId}`,
        sizeBytes: byteLength(persistedOcr),
        source: 'observation',
        contentHash: contentHash(persistedOcr),
        locator: { externalPath, extension: '.json', mimeType: 'application/json' },
        links,
        retentionPolicy: 'temporary',
        textForRedaction: serialized
      })
      observation.artifacts.ocrArtifactId = result.artifact.id
    }
  }

  private async persistTextFileToLibrary(content: string, extension: '.xml' | '.json'): Promise<string> {
    const fileId = contentHash(`${extension}:${content}`).replace('observation-', 'rpa-observation-')
    return await window.api.file.writeWithId(`${fileId}${extension}`, content)
  }
}

function resolveScreenshot(
  value: unknown
): { imageBase64: string; mime?: string; width?: number; height?: number } | undefined {
  if (!value || typeof value !== 'object' || !('imageBase64' in value) || typeof value.imageBase64 !== 'string') {
    return undefined
  }
  return value as { imageBase64: string; mime?: string; width?: number; height?: number }
}

function resolveScreenshotSize(value: unknown): { width: number; height: number } | undefined {
  const screenshot = resolveScreenshot(value)
  return screenshot && typeof screenshot.width === 'number' && typeof screenshot.height === 'number'
    ? { width: screenshot.width, height: screenshot.height }
    : undefined
}

function normalizeText(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function contentHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `observation-${(hash >>> 0).toString(16)}`
}

function redactForEvidence(value: string): string {
  return redactRpaKnowledgeText(value, value.length + 1).text
}
