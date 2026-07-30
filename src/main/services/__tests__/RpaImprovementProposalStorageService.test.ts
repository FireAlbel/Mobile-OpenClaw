import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaImprovementProposalStorageService } from '../RpaImprovementProposalStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(
    process.cwd(),
    '.tmp-rpa-improvement-proposal-storage',
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaImprovementProposalStorageService', () => {
  it('creates an empty proposal file when missing', async () => {
    const filePath = path.join(tempDir, 'proposals.json')
    const service = new RpaImprovementProposalStorageService(filePath)

    await expect(service.loadProposals()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('[]')
  })

  it('saves proposal records atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'proposals.json')
    const service = new RpaImprovementProposalStorageService(filePath)
    const records = [{ id: 'proposal-1', status: 'awaiting_review' }]

    await service.saveProposals(records)

    await expect(service.loadProposals()).resolves.toEqual(records)
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a corrupt proposal file for manual recovery', async () => {
    const filePath = path.join(tempDir, 'proposals.json')
    await fs.writeFile(filePath, '{bad json', 'utf-8')
    const service = new RpaImprovementProposalStorageService(filePath)

    await expect(service.loadProposals()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('{bad json')
  })
})
