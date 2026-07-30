import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaDslSessionStorageService } from '../RpaDslSessionStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(
    process.cwd(),
    '.tmp-rpa-dsl-session-storage',
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaDslSessionStorageService', () => {
  it('persists session revisions atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'sessions.json')
    const service = new RpaDslSessionStorageService(filePath)
    const sessions = [{ id: 'session-1', version: 2 }]

    await service.saveSessions(sessions)

    await expect(service.loadSessions()).resolves.toEqual(sessions)
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
