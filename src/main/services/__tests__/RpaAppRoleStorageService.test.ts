import fs from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RpaAppRoleStorageService } from '../RpaAppRoleStorageService'

let tempDir: string

beforeEach(async () => {
  tempDir = path.join(
    process.cwd(),
    '.tmp-rpa-app-role-storage',
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await fs.mkdir(tempDir, { recursive: true })
})

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
})

describe('RpaAppRoleStorageService', () => {
  it('creates an empty Role file when missing', async () => {
    const filePath = path.join(tempDir, 'app-roles.json')
    const service = new RpaAppRoleStorageService(filePath)

    await expect(service.loadRoles()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('[]')
  })

  it('saves and loads Role records atomically', async () => {
    const filePath = path.join(tempDir, 'nested', 'app-roles.json')
    const service = new RpaAppRoleStorageService(filePath)
    const roles = [{ id: 'role-1', version: 1 }]

    await service.saveRoles(roles)

    await expect(service.loadRoles()).resolves.toEqual(roles)
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves corrupt Role evidence for manual recovery', async () => {
    const filePath = path.join(tempDir, 'app-roles.json')
    await fs.writeFile(filePath, '{bad json', 'utf-8')
    const service = new RpaAppRoleStorageService(filePath)

    await expect(service.loadRoles()).resolves.toEqual([])
    await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe('{bad json')
  })
})
