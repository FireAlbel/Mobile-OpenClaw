import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { getConfigDir } from '@main/utils/file'

const logger = loggerService.withContext('RpaSessionSupplementStorageService')

export class RpaSessionSupplementStorageService {
  constructor(private readonly filePath = path.join(getConfigDir(), 'rpa', 'session-supplements.json')) {}

  async loadRecords(): Promise<unknown[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        await this.saveRecords([])
        return []
      }
      logger.warn('Failed to load RPA Session Supplements', { error })
      return []
    }
  }

  async saveRecords(records: unknown[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await fs.writeFile(temporary, JSON.stringify(Array.isArray(records) ? records : [], null, 2), 'utf-8')
    await fs.rename(temporary, this.filePath)
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export const rpaSessionSupplementStorageService = new RpaSessionSupplementStorageService()
