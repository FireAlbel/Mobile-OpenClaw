import fs from 'node:fs/promises'
import path from 'node:path'

import type { RpaDebugExportPayload } from '@shared/types/RpaDebugExport'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaDebugExportService } from '../RpaDebugExportService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(process.cwd(), '.tmp-rpa-debug-export', `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaDebugExportService', () => {
  it('writes a compressed ZIP archive', async () => {
    const outputPath = path.join(tempDir, 'debug.zip')
    const payload: RpaDebugExportPayload = {
      fileName: 'debug.zip',
      entries: [
        { path: 'manifest.json', content: '{"schemaVersion":1}', encoding: 'utf8' },
        { path: 'screenshots/frame.png', content: 'YWJj', encoding: 'base64' }
      ]
    }

    await new RpaDebugExportService().writeArchive(outputPath, payload)

    const output = await fs.readFile(outputPath)
    expect(output.subarray(0, 2).toString()).toBe('PK')
    expect(output.byteLength).toBeGreaterThan(20)
  })

  it('rejects archive path traversal', async () => {
    const payload: RpaDebugExportPayload = {
      fileName: 'debug.zip',
      entries: [{ path: '../secret.txt', content: 'secret', encoding: 'utf8' }]
    }

    await expect(new RpaDebugExportService().writeArchive(path.join(tempDir, 'debug.zip'), payload)).rejects.toThrow(
      'Unsafe debug export entry path'
    )
  })
})
