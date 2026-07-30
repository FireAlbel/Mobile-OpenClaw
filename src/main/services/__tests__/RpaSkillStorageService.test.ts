import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaSkillStorageService } from '../RpaSkillStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(process.cwd(), '.tmp-rpa-skill-storage', `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaSkillStorageService', () => {
  it('creates an empty Skill file when missing', async () => {
    const filePath = path.join(tempDir, 'skills.json')
    const service = new RpaSkillStorageService(filePath)
    await expect(service.loadSkills()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('[]')
  })

  it('saves Skill records atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'skills.json')
    const service = new RpaSkillStorageService(filePath)
    const records = [{ id: 'skill-1', version: '1.0.0' }]
    await service.saveSkills(records)
    await expect(service.loadSkills()).resolves.toEqual(records)
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves a corrupt Skill file for manual recovery', async () => {
    const filePath = path.join(tempDir, 'skills.json')
    await fs.writeFile(filePath, '{bad json', 'utf-8')
    const service = new RpaSkillStorageService(filePath)
    await expect(service.loadSkills()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('{bad json')
  })
})
