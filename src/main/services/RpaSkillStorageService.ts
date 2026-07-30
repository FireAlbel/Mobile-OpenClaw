import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { getConfigDir } from '@main/utils/file'

const logger = loggerService.withContext('RpaSkillStorageService')

export class RpaSkillStorageService {
  constructor(private readonly filePath = path.join(getConfigDir(), 'rpa', 'skills.json')) {}

  async loadSkills(): Promise<unknown[]> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(content)
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        await this.saveSkills([])
        return []
      }
      logger.warn('Failed to load RPA skills', { error })
      return []
    }
  }

  async saveSkills(skills: unknown[]): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const tempPath = `${this.filePath}.tmp`
      await fs.writeFile(tempPath, JSON.stringify(Array.isArray(skills) ? skills : [], null, 2), 'utf-8')
      await fs.rename(tempPath, this.filePath)
    } catch (error) {
      logger.error('Failed to save RPA skills', { error })
      throw error
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export const rpaSkillStorageService = new RpaSkillStorageService()
