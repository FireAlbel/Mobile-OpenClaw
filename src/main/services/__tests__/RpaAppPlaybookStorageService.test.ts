import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaAppPlaybookStorageService } from '../RpaAppPlaybookStorageService'

let tempDir: string

beforeEach(() => {
  tempDir = path.join(
    process.cwd(),
    '.tmp-rpa-app-playbook-storage',
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaAppPlaybookStorageService', () => {
  it('creates the file and saves playbooks atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'app-playbooks.json')
    const service = new RpaAppPlaybookStorageService(filePath)

    await expect(service.loadPlaybooks()).resolves.toEqual([])
    await service.savePlaybooks([{ id: 'com.example.app', version: 1 }])

    await expect(service.loadPlaybooks()).resolves.toEqual([{ id: 'com.example.app', version: 1 }])
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
