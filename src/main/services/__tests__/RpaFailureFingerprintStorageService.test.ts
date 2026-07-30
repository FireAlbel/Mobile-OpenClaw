import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaFailureFingerprintStorageService } from '../RpaFailureFingerprintStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(
    process.cwd(),
    '.tmp-rpa-failure-fingerprint-storage',
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaFailureFingerprintStorageService', () => {
  it('creates an empty fingerprint file when missing', async () => {
    const filePath = path.join(tempDir, 'fingerprints.json')
    const service = new RpaFailureFingerprintStorageService(filePath)
    await expect(service.loadFingerprints()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('[]')
  })

  it('saves fingerprint records atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'fingerprints.json')
    const service = new RpaFailureFingerprintStorageService(filePath)
    const records = [{ id: 'fingerprint-1', count: 2 }]
    await service.saveFingerprints(records)
    await expect(service.loadFingerprints()).resolves.toEqual(records)
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves corrupt fingerprint evidence for manual recovery', async () => {
    const filePath = path.join(tempDir, 'fingerprints.json')
    await fs.writeFile(filePath, '{bad json', 'utf-8')
    const service = new RpaFailureFingerprintStorageService(filePath)
    await expect(service.loadFingerprints()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('{bad json')
  })
})
