import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaTemplateStorageService } from '../RpaTemplateStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(
    process.cwd(),
    '.tmp-rpa-template-storage',
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaTemplateStorageService', () => {
  it('creates an empty template file when missing', async () => {
    const filePath = path.join(tempDir, 'templates.json')
    const service = new RpaTemplateStorageService(filePath)
    await expect(service.loadTemplates()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('[]')
  })

  it('saves template records atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'templates.json')
    const service = new RpaTemplateStorageService(filePath)
    const records = [{ id: 'template-1', version: 1 }]
    await service.saveTemplates(records)
    await expect(service.loadTemplates()).resolves.toEqual(records)
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a corrupt file for manual recovery', async () => {
    const filePath = path.join(tempDir, 'templates.json')
    await fs.writeFile(filePath, '{bad json', 'utf-8')
    const service = new RpaTemplateStorageService(filePath)
    await expect(service.loadTemplates()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('{bad json')
  })
})
