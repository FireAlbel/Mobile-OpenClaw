import type { RpaDebugExportEntry, RpaDebugExportPayload } from '@shared/types/RpaDebugExport'

import type { RpaReplayFrame } from './RpaReplayService'
import { rpaReplayService } from './RpaReplayService'
import type { RpaBatchRunRecord } from './RpaRunStorage'
import type { RpaTask } from './RpaTypes'

const REDACTED = '[REDACTED]'
const MAX_EVENTS_PER_DEVICE = 2_000
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024
const MAX_SCREENSHOT_TOTAL_BYTES = 32 * 1024 * 1024
const SENSITIVE_KEY = /api[-_]?key|token|password|secret|authorization|cookie|credential|session|prompt/i
const SECRET_VALUE = /(bearer\s+)[a-z0-9._~+/-]+=*|\bsk-[a-z0-9_-]{12,}\b/gi

export interface RpaDebugBundleBuildResult {
  payload: RpaDebugExportPayload
  omittedArtifacts: string[]
  redactedFields: number
}

export class RpaDebugBundleService {
  build(run: RpaBatchRunRecord, now = Date.now()): RpaDebugBundleBuildResult {
    const entries: RpaDebugExportEntry[] = []
    const omittedArtifacts: string[] = []
    const screenshotInventory: Array<{ path: string; deviceId: string; stepId: string; timestamp: number }> = []
    let screenshotBytes = 0
    let redactedFields = 0
    let screenshotIndex = 0

    const limitedRun: RpaBatchRunRecord = {
      ...run,
      deviceRuns: run.deviceRuns.map((deviceRun) => {
        const omittedCount = Math.max(0, deviceRun.events.length - MAX_EVENTS_PER_DEVICE)
        if (omittedCount > 0) omittedArtifacts.push(`${deviceRun.id}: ${omittedCount} older events omitted`)
        return { ...deviceRun, events: deviceRun.events.slice(-MAX_EVENTS_PER_DEVICE) }
      })
    }

    const sanitize = (value: unknown, path: string[] = []): unknown => {
      if (Array.isArray(value)) return value.map((item, index) => sanitize(item, [...path, String(index)]))
      if (!value || typeof value !== 'object') {
        if (typeof value !== 'string') return value
        const sanitized = value.replace(
          SECRET_VALUE,
          (_match, bearerPrefix?: string) => `${bearerPrefix ?? ''}${REDACTED}`
        )
        if (sanitized !== value) redactedFields += 1
        return sanitized
      }

      const record = value as Record<string, unknown>
      const output: Record<string, unknown> = {}
      for (const [key, nested] of Object.entries(record)) {
        if (SENSITIVE_KEY.test(key)) {
          output[key] = REDACTED
          redactedFields += 1
          continue
        }
        if (key === 'imageBase64' && typeof nested === 'string') {
          const decoded = decodeScreenshot(nested)
          const extension = extensionForMime(typeof record.mime === 'string' ? record.mime : decoded.mime)
          const artifactPath = `screenshots/${String(screenshotIndex + 1).padStart(4, '0')}-${safeName(
            findNearbyString(path, limitedRun, 'deviceId') ?? 'device'
          )}.${extension}`
          screenshotIndex += 1
          if (!decoded.content || decoded.bytes > MAX_SCREENSHOT_BYTES) {
            output[key] = '[OMITTED: screenshot exceeds per-file limit]'
            omittedArtifacts.push(`${artifactPath}: screenshot exceeds per-file limit`)
            continue
          }
          if (screenshotBytes + decoded.bytes > MAX_SCREENSHOT_TOTAL_BYTES) {
            output[key] = '[OMITTED: screenshot bundle limit reached]'
            omittedArtifacts.push(`${artifactPath}: screenshot bundle limit reached`)
            continue
          }
          screenshotBytes += decoded.bytes
          entries.push({ path: artifactPath, content: decoded.content, encoding: 'base64' })
          screenshotInventory.push({
            path: artifactPath,
            deviceId: findNearbyString(path, limitedRun, 'deviceId') ?? 'unknown',
            stepId: findNearbyString(path, limitedRun, 'stepId') ?? 'unknown',
            timestamp: findNearbyNumber(path, limitedRun, 'timestamp') ?? 0
          })
          output[key] = `[EXTRACTED:${artifactPath}]`
          continue
        }
        output[key] = sanitize(nested, [...path, key])
      }
      return output
    }

    const sanitizedRun = sanitize(limitedRun)
    const replay = rpaReplayService.load(limitedRun)
    const timeline = replay.frames.map(stripReplayArtifacts)
    const manifest = {
      schemaVersion: 1,
      runId: run.id,
      exportedAt: now,
      compressed: true,
      retentionPolicy: { maxStoredRuns: 100, maxEventsPerDevice: MAX_EVENTS_PER_DEVICE },
      limits: { maxScreenshotBytes: MAX_SCREENSHOT_BYTES, maxScreenshotTotalBytes: MAX_SCREENSHOT_TOTAL_BYTES },
      redactedFields,
      omittedArtifacts,
      screenshots: screenshotInventory
    }

    entries.unshift(
      jsonEntry('manifest.json', manifest),
      jsonEntry('task.dsl.json', sanitize(limitedRun.task)),
      jsonEntry('run.sanitized.json', sanitizedRun),
      jsonEntry('timeline.json', timeline)
    )

    return {
      payload: { fileName: `rpa-debug-${safeName(run.id)}.zip`, entries },
      omittedArtifacts,
      redactedFields
    }
  }

  createTemplate(run: RpaBatchRunRecord, now = Date.now()): RpaTask {
    if (run.status !== 'completed' || run.deviceRuns.some((deviceRun) => deviceRun.status !== 'completed')) {
      throw new Error('Only fully completed runs can be converted into templates')
    }

    const deviceIds = new Set(run.deviceIds)
    const replaceDeviceValues = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(replaceDeviceValues)
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value).map(([key, nested]) => [
            key,
            SENSITIVE_KEY.test(key) ? REDACTED : replaceDeviceValues(nested)
          ])
        )
      }
      return typeof value === 'string' && deviceIds.has(value) ? '{{deviceId}}' : value
    }

    return {
      ...(replaceDeviceValues(run.task) as RpaTask),
      id: `rpa-template-${now}`,
      name: `${run.task.name} Template`,
      deviceIds: [],
      metadata: { template: true }
    }
  }
}

function jsonEntry(path: string, value: unknown): RpaDebugExportEntry {
  return { path, content: JSON.stringify(value, null, 2), encoding: 'utf8' }
}

function decodeScreenshot(value: string): { content: string; bytes: number; mime?: string } {
  const match = value.match(/^data:([^;,]+);base64,(.*)$/s)
  const content = match?.[2] ?? value
  if (!/^[a-z0-9+/]*={0,2}$/i.test(content)) return { content: '', bytes: 0, mime: match?.[1] }
  return { content, bytes: Math.floor((content.length * 3) / 4), mime: match?.[1] }
}

function extensionForMime(mime?: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  return 'png'
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'run'
}

function valueAtPath(root: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[segment]
  }, root)
}

function findNearbyString(path: string[], root: unknown, key: string): string | undefined {
  for (let length = path.length; length >= 0; length -= 1) {
    const value = valueAtPath(root, [...path.slice(0, length), key])
    if (typeof value === 'string') return value
  }
  return undefined
}

function findNearbyNumber(path: string[], root: unknown, key: string): number | undefined {
  for (let length = path.length; length >= 0; length -= 1) {
    const value = valueAtPath(root, [...path.slice(0, length), key])
    if (typeof value === 'number') return value
  }
  return undefined
}

export const rpaDebugBundleService = new RpaDebugBundleService()

function stripReplayArtifacts(frame: RpaReplayFrame): Omit<RpaReplayFrame, 'screenshot' | 'observation'> {
  const copy = { ...frame }
  delete copy.screenshot
  delete copy.observation
  return copy
}
