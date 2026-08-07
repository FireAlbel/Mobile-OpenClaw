import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { getConfigDir } from '@main/utils/file'

const logger = loggerService.withContext('RpaAppPlaybookStorageService')

export class RpaAppPlaybookStorageService {
  constructor(private readonly filePath = path.join(getConfigDir(), 'rpa', 'app-playbooks.json')) {}

  async loadPlaybooks(): Promise<unknown[]> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(content)
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        await this.savePlaybooks([])
        return []
      }
      logger.warn('Failed to load RPA App Playbooks', { error })
      return []
    }
  }

  async savePlaybooks(playbooks: unknown[]): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const tempPath = `${this.filePath}.tmp`
      await fs.writeFile(tempPath, JSON.stringify(Array.isArray(playbooks) ? playbooks : [], null, 2), 'utf-8')
      await fs.rename(tempPath, this.filePath)
    } catch (error) {
      logger.error('Failed to save RPA App Playbooks', { error })
      throw error
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export const rpaAppPlaybookStorageService = new RpaAppPlaybookStorageService()
