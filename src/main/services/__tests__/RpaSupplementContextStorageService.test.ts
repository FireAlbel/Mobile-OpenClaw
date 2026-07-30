import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaSupplementContextStorageService } from '../RpaSupplementContextStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(process.cwd(), '.tmp-rpa-supplement-context', `${Date.now()}-${Math.random()}`)
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaSupplementContextStorageService', () => {
  it('creates an empty state and persists updates atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'supplement-context.json')
    const service = new RpaSupplementContextStorageService(filePath)

    await expect(service.loadState()).resolves.toEqual({
      schemaVersion: 1,
      indexes: [],
      snapshots: [],
      promotionProposals: []
    })

    const state = { schemaVersion: 1, indexes: [{ id: 'index-1' }], snapshots: [], promotionProposals: [] }
    await service.saveState(state)

    await expect(service.loadState()).resolves.toEqual(state)
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
