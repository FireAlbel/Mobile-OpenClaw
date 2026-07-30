import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaArtifactStorageService } from '../RpaArtifactStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(
    process.cwd(),
    '.tmp-rpa-artifact-storage',
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaArtifactStorageService', () => {
  it('creates an empty artifact file when missing', async () => {
    const filePath = path.join(tempDir, 'artifacts.json')
    const service = new RpaArtifactStorageService(filePath)

    await expect(service.loadArtifacts()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('[]')
  })

  it('saves and loads artifact metadata atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'artifacts.json')
    const service = new RpaArtifactStorageService(filePath)
    const artifacts = [{ id: 'artifact-1', category: 'run_log' }]

    await service.saveArtifacts(artifacts)

    await expect(service.loadArtifacts()).resolves.toEqual(artifacts)
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not overwrite corrupt artifact evidence', async () => {
    const filePath = path.join(tempDir, 'artifacts.json')
    await fs.writeFile(filePath, '{bad json', 'utf-8')
    const service = new RpaArtifactStorageService(filePath)

    await expect(service.loadArtifacts()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('{bad json')
  })
})
