import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaRolePromptStorageService } from '../RpaRolePromptStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(
    process.cwd(),
    '.tmp-rpa-role-prompt-storage',
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaRolePromptStorageService', () => {
  it('creates an empty prompt file when missing', async () => {
    const filePath = path.join(tempDir, 'role-prompts.json')
    const service = new RpaRolePromptStorageService(filePath)

    await expect(service.loadPrompts()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('[]')
  })

  it('saves and loads prompts atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'role-prompts.json')
    const service = new RpaRolePromptStorageService(filePath)
    const prompts = [{ id: 'planner', roleId: 'role-1', version: '1' }]

    await service.savePrompts(prompts)

    await expect(service.loadPrompts()).resolves.toEqual(prompts)
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
