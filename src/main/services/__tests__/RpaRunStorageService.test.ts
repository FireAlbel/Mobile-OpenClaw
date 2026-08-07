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

  it('defensively removes large binary and UI tree payloads before writing', async () => {
    const filePath = path.join(tempDir, 'runs.json')
    const service = new RpaRunStorageService(filePath)

    await service.saveRuns([
      {
        id: 'run-1',
        status: 'failed',
        evidenceArtifactId: 'artifact-1',
        observation: {
          screenshot: { imageBase64: 'b'.repeat(2_000_000), mime: 'image/png' },
          uiTree: {
            xml: '<node />'.repeat(100_000),
            nodes: Array.from({ length: 1_000 }, (_, index) => ({ text: `Node ${index}` }))
          },
          ocr: { blocks: Array.from({ length: 1_000 }, (_, index) => ({ text: `OCR ${index}` })) },
          textCandidates: Array.from({ length: 1_000 }, (_, index) => ({ text: `Candidate ${index}` }))
        }
      }
    ])

    const persisted = await fs.readFile(filePath, 'utf-8')
    expect(persisted).not.toContain('b'.repeat(1_000))
    expect(persisted).not.toContain('<node />'.repeat(100))
    expect(persisted).toContain('[BINARY_OMITTED:2000000]')
    expect(persisted).toContain('[TEXT_OMITTED:UI_TREE_XML:800000]')
    expect(persisted).toContain('[UI_TREE_NODES_OMITTED:1000]')
    expect(persisted).toContain('[OCR_BLOCKS_OMITTED:1000]')
    expect(persisted).toContain('[TEXT_CANDIDATES_OMITTED:1000]')
    expect(persisted).toContain('artifact-1')
    expect(persisted.length).toBeLessThan(100_000)
  })
})
