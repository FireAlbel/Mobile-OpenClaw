import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaRunStorageService } from '../RpaRunStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(process.cwd(), '.tmp-rpa-run-storage', `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

describe('RpaRunStorageService', () => {
  it('creates an empty runs file when missing', async () => {
    const filePath = path.join(tempDir, 'runs.json')
    const service = new RpaRunStorageService(filePath)

    await expect(service.loadRuns()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('[]')
  })

  it('saves and loads run records atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'runs.json')
    const service = new RpaRunStorageService(filePath)
    const runs = [{ id: 'run-1', status: 'completed' }]

    await service.saveRuns(runs)

    await expect(service.loadRuns()).resolves.toEqual(runs)
  })

  it('returns an empty list for corrupt content', async () => {
    const filePath = path.join(tempDir, 'runs.json')
    await fs.writeFile(filePath, '{bad json', 'utf-8')
    const service = new RpaRunStorageService(filePath)

    await expect(service.loadRuns()).resolves.toEqual([])
  })
})
