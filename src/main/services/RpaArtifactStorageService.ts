import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { getConfigDir } from '@main/utils/file'

const logger = loggerService.withContext('RpaArtifactStorageService')

export class RpaArtifactStorageService {
  constructor(private readonly filePath = path.join(getConfigDir(), 'rpa', 'artifacts.json')) {}

  async loadArtifacts(): Promise<unknown[]> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(content)
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        await this.saveArtifacts([])
        return []
      }
      logger.warn('Failed to load RPA artifacts', { error })
      return []
    }
  }

  async saveArtifacts(artifacts: unknown[]): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const tempPath = `${this.filePath}.tmp`
      await fs.writeFile(tempPath, JSON.stringify(Array.isArray(artifacts) ? artifacts : [], null, 2), 'utf-8')
      await fs.rename(tempPath, this.filePath)
    } catch (error) {
      logger.error('Failed to save RPA artifacts', { error })
      throw error
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export const rpaArtifactStorageService = new RpaArtifactStorageService()
