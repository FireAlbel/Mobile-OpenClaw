import fs from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { getConfigDir } from '@main/utils/file'

const logger = loggerService.withContext('RpaSupplementContextStorageService')

const EMPTY_STATE = { schemaVersion: 1, indexes: [], snapshots: [], promotionProposals: [] }

export class RpaSupplementContextStorageService {
  constructor(private readonly filePath = path.join(getConfigDir(), 'rpa', 'supplement-context.json')) {}

  async loadState(): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        await this.saveState(EMPTY_STATE)
        return structuredClone(EMPTY_STATE)
      }
      logger.warn('Failed to load RPA Supplement Context state', { error })
      return structuredClone(EMPTY_STATE)
    }
  }

  async saveState(state: unknown): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.tmp`
    await fs.writeFile(temporary, JSON.stringify(state ?? EMPTY_STATE, null, 2), 'utf-8')
    await fs.rename(temporary, this.filePath)
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export const rpaSupplementContextStorageService = new RpaSupplementContextStorageService()
