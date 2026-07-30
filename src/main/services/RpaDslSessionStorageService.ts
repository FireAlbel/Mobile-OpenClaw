import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { getConfigDir } from '@main/utils/file'

const logger = loggerService.withContext('RpaDslSessionStorageService')

export class RpaDslSessionStorageService {
  constructor(private readonly filePath = path.join(getConfigDir(), 'rpa', 'dsl-sessions.json')) {}

  async loadSessions(): Promise<unknown[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
      return Array.isArray(parsed) ? parsed : []
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        await this.saveSessions([])
        return []
      }
      logger.warn('Failed to load RPA DSL sessions', { error })
      return []
    }
  }

  async saveSessions(sessions: unknown[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await fs.writeFile(temporary, JSON.stringify(Array.isArray(sessions) ? sessions : [], null, 2), 'utf-8')
    await fs.rename(temporary, this.filePath)
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export const rpaDslSessionStorageService = new RpaDslSessionStorageService()
