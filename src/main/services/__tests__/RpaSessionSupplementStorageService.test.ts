import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaSessionSupplementStorageService } from '../RpaSessionSupplementStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(process.cwd(), '.tmp-rpa-session-supplements', `${Date.now()}-${Math.random()}`)
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaSessionSupplementStorageService', () => {
  it('persists records atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'session-supplements.json')
    const service = new RpaSessionSupplementStorageService(filePath)
    const records = [{ sessionId: 'session-1', supplementRevision: 2 }]

    await service.saveRecords(records)

    await expect(service.loadRecords()).resolves.toEqual(records)
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
