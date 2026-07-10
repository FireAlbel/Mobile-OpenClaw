import { loggerService } from '@logger'

const logger = loggerService.withContext('DeerFlowAdapter')

export interface DeerFlowConfig {
  endpoint?: string
  apiKey?: string
  timeoutMs?: number
}

export interface DeerFlowPlanRequest {
  taskId: string
  deviceId: string
  goal: string
  context?: Record<string, unknown>
}

export interface DeerFlowPlanResult {
  available: boolean
  threadId?: string
  runId?: string
  plan?: unknown
  message: string
}

export class DeerFlowAdapter {
  constructor(private readonly config: DeerFlowConfig = {}) {}

  isConfigured(): boolean {
    return Boolean(this.config.endpoint?.trim())
  }

  async requestPlan(request: DeerFlowPlanRequest): Promise<DeerFlowPlanResult> {
    if (!this.isConfigured()) {
      return {
        available: false,
        message: 'DeerFlow endpoint is not configured'
      }
    }

    const endpoint = this.config.endpoint!.replace(/\/$/, '')
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 30000)

    try {
      const response = await fetch(`${endpoint}/api/device-plan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {})
        },
        body: JSON.stringify(request),
        signal: controller.signal
      })

      if (!response.ok) {
        throw new Error(`DeerFlow request failed with HTTP ${response.status}`)
      }

      const data = await response.json()
      return {
        available: true,
        threadId: typeof data.threadId === 'string' ? data.threadId : undefined,
        runId: typeof data.runId === 'string' ? data.runId : undefined,
        plan: data.plan ?? data,
        message: 'DeerFlow plan received'
      }
    } catch (error) {
      logger.warn('DeerFlow plan request failed', { error, taskId: request.taskId, deviceId: request.deviceId })
      return {
        available: false,
        message: error instanceof Error ? error.message : String(error)
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

export const deerFlowAdapter = new DeerFlowAdapter({
  endpoint: typeof localStorage !== 'undefined' ? localStorage.getItem('deerflow_endpoint') || undefined : undefined,
  apiKey: typeof localStorage !== 'undefined' ? localStorage.getItem('deerflow_api_key') || undefined : undefined
})
