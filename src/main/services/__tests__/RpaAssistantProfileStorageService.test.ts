import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaAssistantProfileStorageService } from '../RpaAssistantProfileStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(
    process.cwd(),
    '.tmp-rpa-assistant-profile-storage',
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

describe('RpaAssistantProfileStorageService', () => {
  it('creates an empty profile file when missing', async () => {
    const filePath = path.join(tempDir, 'assistant-profiles.json')
    const service = new RpaAssistantProfileStorageService(filePath)

    await expect(service.loadProfiles()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('[]')
  })

  it('saves and loads profile records atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'assistant-profiles.json')
    const service = new RpaAssistantProfileStorageService(filePath)
    const profiles = [{ assistantId: 'assistant-1', version: 1 }]

    await service.saveProfiles(profiles)

    await expect(service.loadProfiles()).resolves.toEqual(profiles)
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('returns an empty list for corrupt content without overwriting evidence', async () => {
    const filePath = path.join(tempDir, 'assistant-profiles.json')
    await fs.writeFile(filePath, '{bad json', 'utf-8')
    const service = new RpaAssistantProfileStorageService(filePath)

    await expect(service.loadProfiles()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('{bad json')
  })
})
