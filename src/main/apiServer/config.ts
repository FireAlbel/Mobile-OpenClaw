import { API_SERVER_DEFAULTS } from '@shared/config/constant'
import type { ApiServerConfig } from '@types'
import { v4 as uuidv4 } from 'uuid'

import { loggerService } from '../services/LoggerService'
import { reduxService } from '../services/ReduxService'

const logger = loggerService.withContext('ApiServerConfig')

class ConfigManager {
  private _config: ApiServerConfig | null = null

  private generateApiKey(): string {
    return `cs-sk-${uuidv4()}`
  }

  async load(): Promise<ApiServerConfig> {
    try {
      // 增加重试机制，避免Redux store未准备好时立即失败
      let settings = null
      let attempts = 0
      const maxAttempts = 3

      while (attempts < maxAttempts) {
        try {
          settings = await reduxService.select('state.settings')
          break
        } catch (error) {
          attempts++
          if (attempts >= maxAttempts) {
            throw error
          }
          // 等待一段时间后重试
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempts))
        }
      }

      const serverSettings = (settings as any)?.apiServer
      let apiKey = serverSettings?.apiKey
      if (!apiKey || apiKey.trim() === '') {
        apiKey = this.generateApiKey()
        await reduxService.dispatch({
          type: 'settings/setApiServerApiKey',
          payload: apiKey
        })
      }
      this._config = {
        enabled: serverSettings?.enabled ?? false,
        port: serverSettings?.port ?? API_SERVER_DEFAULTS.PORT,
        host: serverSettings?.host ?? API_SERVER_DEFAULTS.HOST,
        apiKey: apiKey
      }
      return this._config
    } catch (error: any) {
      logger.warn('Failed to load config from Redux, using defaults', { error })
      this._config = {
        enabled: false,
        port: API_SERVER_DEFAULTS.PORT,
        host: API_SERVER_DEFAULTS.HOST,
        apiKey: this.generateApiKey()
      }
      return this._config
    }
  }

  async get(): Promise<ApiServerConfig> {
    if (!this._config) {
      await this.load()
    }
    if (!this._config) {
      throw new Error('Failed to load API server configuration')
    }
    return this._config
  }

  async reload(): Promise<ApiServerConfig> {
    return await this.load()
  }
}

export const config = new ConfigManager()
