import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { getConfigDir } from '@main/utils/file'

const logger = loggerService.withContext('RpaRunStorageService')
const MAX_PERSISTED_DEPTH = 12
const MAX_PERSISTED_OBJECT_KEYS = 256
const MAX_PERSISTED_ARRAY_ITEMS = 2_000
const MAX_PERSISTED_STRING_LENGTH = 16_384

export class RpaRunStorageService {
  private readonly filePath: string

  constructor(filePath = path.join(getConfigDir(), 'rpa', 'runs.json')) {
    this.filePath = filePath
  }

  async loadRuns(): Promise<unknown[]> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(content)
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        await this.saveRuns([])
        return []
      }

      logger.warn('Failed to load RPA run records', { error })
      return []
    }
  }

  async saveRuns(runs: unknown[]): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const tempPath = `${this.filePath}.tmp`
      await fs.writeFile(tempPath, JSON.stringify(sanitizeRuns(runs), null, 2), 'utf-8')
      await fs.rename(tempPath, this.filePath)
    } catch (error) {
      logger.error('Failed to save RPA run records', { error })
      throw error
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function sanitizeRuns(runs: unknown[]): unknown[] {
  return sanitizePersistedValue(Array.isArray(runs) ? runs : [], 0, []) as unknown[]
}

function sanitizePersistedValue(value: unknown, depth: number, path: string[]): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value

  if (typeof value === 'string') {
    const key = path.at(-1)?.toLocaleLowerCase() ?? ''
    if (['imagebase64', 'base64', 'imagedata', 'screenshotbase64'].includes(key)) {
      return `[BINARY_OMITTED:${value.length}]`
    }
    if (key === 'xml' && path.some((part) => part.toLocaleLowerCase() === 'uitree')) {
      return `[TEXT_OMITTED:UI_TREE_XML:${value.length}]`
    }
    if (value.length > MAX_PERSISTED_STRING_LENGTH) {
      return `${value.slice(0, MAX_PERSISTED_STRING_LENGTH)}\n[TEXT_OMITTED:${value.length - MAX_PERSISTED_STRING_LENGTH}]`
    }
    return value
  }

  if (depth >= MAX_PERSISTED_DEPTH) return '[DEPTH_LIMIT_REACHED]'
  if (Array.isArray(value)) {
    const omittedCollection = summarizeObservationCollection(path, value.length)
    if (omittedCollection) return omittedCollection
    const items = value
      .slice(0, MAX_PERSISTED_ARRAY_ITEMS)
      .map((item, index) => sanitizePersistedValue(item, depth + 1, [...path, String(index)]))
    if (value.length > MAX_PERSISTED_ARRAY_ITEMS) {
      items.push(`[ARRAY_ITEMS_OMITTED:${value.length - MAX_PERSISTED_ARRAY_ITEMS}]`)
    }
    return items
  }
  if (typeof value !== 'object') return String(value)

  const entries = Object.entries(value as Record<string, unknown>)
  const output: Record<string, unknown> = {}
  for (const [key, nested] of entries.slice(0, MAX_PERSISTED_OBJECT_KEYS)) {
    output[key] = sanitizePersistedValue(nested, depth + 1, [...path, key])
  }
  if (entries.length > MAX_PERSISTED_OBJECT_KEYS)
    output.__omittedObjectKeys = entries.length - MAX_PERSISTED_OBJECT_KEYS
  return output
}

function summarizeObservationCollection(path: string[], count: number): string | undefined {
  const normalized = path.map((part) => part.toLocaleLowerCase())
  const key = normalized.at(-1)
  if (key === 'textcandidates') return `[TEXT_CANDIDATES_OMITTED:${count}]`
  if (key === 'nodes' && normalized.includes('uitree')) return `[UI_TREE_NODES_OMITTED:${count}]`
  if (key === 'texts' && normalized.includes('uitree')) return `[UI_TREE_TEXTS_OMITTED:${count}]`
  if (key === 'blocks' && normalized.includes('ocr')) return `[OCR_BLOCKS_OMITTED:${count}]`
  return undefined
}

export const rpaRunStorageService = new RpaRunStorageService()
