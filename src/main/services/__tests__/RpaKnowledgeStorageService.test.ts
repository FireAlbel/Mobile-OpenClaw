import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaKnowledgeStorageService } from '../RpaKnowledgeStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(
    process.cwd(),
    '.tmp-rpa-knowledge-storage',
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaKnowledgeStorageService', () => {
  it('creates an empty entry file when missing', async () => {
    const filePath = path.join(tempDir, 'knowledge-entries.json')
    const service = new RpaKnowledgeStorageService(filePath)

    await expect(service.loadEntries()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('[]')
  })

  it('saves and loads entries atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'knowledge-entries.json')
    const service = new RpaKnowledgeStorageService(filePath)
    const entries = [{ id: 'entry-1', category: 'app_sop' }]

    await service.saveEntries(entries)

    await expect(service.loadEntries()).resolves.toEqual(entries)
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not overwrite corrupt evidence', async () => {
    const filePath = path.join(tempDir, 'knowledge-entries.json')
    await fs.writeFile(filePath, '{bad json', 'utf-8')
    const service = new RpaKnowledgeStorageService(filePath)

    await expect(service.loadEntries()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('{bad json')
  })
})
