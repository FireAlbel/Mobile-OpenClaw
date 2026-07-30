import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { getConfigDir } from '@main/utils/file'

const logger = loggerService.withContext('RpaKnowledgeStorageService')

export class RpaKnowledgeStorageService {
  constructor(private readonly filePath = path.join(getConfigDir(), 'rpa', 'knowledge-entries.json')) {}

  async loadEntries(): Promise<unknown[]> {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(content)
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        await this.saveEntries([])
        return []
      }
      logger.warn('Failed to load RPA knowledge entries', { error })
      return []
    }
  }

  async saveEntries(entries: unknown[]): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const tempPath = `${this.filePath}.tmp`
      await fs.writeFile(tempPath, JSON.stringify(Array.isArray(entries) ? entries : [], null, 2), 'utf-8')
      await fs.rename(tempPath, this.filePath)
    } catch (error) {
      logger.error('Failed to save RPA knowledge entries', { error })
      throw error
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export const rpaKnowledgeStorageService = new RpaKnowledgeStorageService()
