import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'

import { loggerService } from '@logger'
import type { RpaDebugExportPayload, RpaDebugExportResult } from '@shared/types/RpaDebugExport'
import archiver from 'archiver'
import { dialog } from 'electron'

const logger = loggerService.withContext('RpaDebugExportService')
const MAX_ENTRY_COUNT = 2_500
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

export class RpaDebugExportService {
  async exportBundle(payload: RpaDebugExportPayload): Promise<RpaDebugExportResult> {
    validatePayload(payload)
    const result = await dialog.showSaveDialog({
      title: 'Export RPA debug bundle',
      defaultPath: ensureZipExtension(payload.fileName),
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
    })
    if (result.canceled || !result.filePath) return { cancelled: true }

    const filePath = ensureZipExtension(result.filePath)
    try {
      await this.writeArchive(filePath, payload)
      const fileSize = (await fsPromises.stat(filePath)).size
      logger.info('RPA debug bundle exported', { filePath, entryCount: payload.entries.length })
      return { cancelled: false, filePath, fileSize }
    } catch (error) {
      await fsPromises.rm(filePath, { force: true }).catch(() => undefined)
      logger.error('Failed to export RPA debug bundle', { error, filePath })
      throw error
    }
  }

  async writeArchive(filePath: string, payload: RpaDebugExportPayload): Promise<void> {
    validatePayload(payload)
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true })

    const chunks = await new Promise<Buffer[]>((resolve, reject) => {
      const output = new PassThrough()
      const archive = archiver('zip', { zlib: { level: 9 } })
      const buffered: Buffer[] = []
      output.on('data', (chunk: Buffer) => buffered.push(chunk))
      output.once('end', () => resolve(buffered))
      output.once('error', reject)
      archive.once('error', reject)
      archive.pipe(output)
      for (const entry of payload.entries) {
        const content = entry.encoding === 'base64' ? Buffer.from(entry.content, 'base64') : entry.content
        archive.append(content, { name: normalizeEntryPath(entry.path) })
      }
      void archive.finalize()
    })
    await fsPromises.writeFile(filePath, Buffer.concat(chunks))
  }
}

function validatePayload(payload: RpaDebugExportPayload): void {
  if (!payload || !Array.isArray(payload.entries) || payload.entries.length === 0) {
    throw new Error('RPA debug export requires at least one entry')
  }
  if (payload.entries.length > MAX_ENTRY_COUNT) throw new Error('RPA debug export contains too many entries')

  let totalBytes = 0
  for (const entry of payload.entries) {
    normalizeEntryPath(entry.path)
    if (entry.encoding !== 'utf8' && entry.encoding !== 'base64') throw new Error('Invalid debug export encoding')
    totalBytes +=
      entry.encoding === 'base64' ? Math.floor((entry.content.length * 3) / 4) : Buffer.byteLength(entry.content)
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('RPA debug export exceeds the size limit')
  }
}

function normalizeEntryPath(entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((segment) => segment === '..')) {
    throw new Error(`Unsafe debug export entry path: ${entryPath}`)
  }
  return normalized
}

function ensureZipExtension(filePath: string): string {
  return filePath.toLowerCase().endsWith('.zip') ? filePath : `${filePath}.zip`
}

export const rpaDebugExportService = new RpaDebugExportService()
