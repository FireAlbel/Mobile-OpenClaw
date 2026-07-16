import { describe, expect, it, vi } from 'vitest'

import { createDefaultRpaModuleRegistry } from '../RpaDefaultRegistry'
import type { RpaModelClient } from '../RpaModelClient'
import { RpaPlannerService } from '../RpaPlannerService'

function modelClient(responses: string[]): RpaModelClient {
  const complete = vi.fn()
  for (const response of responses) {
    complete.mockResolvedValueOnce(response)
  }
  return { complete }
}

function validTaskJson() {
  return JSON.stringify({
    id: 'task-1',
    name: 'Open app',
    goal: 'Open app',
    deviceIds: ['device-1'],
    metadata: {},
    steps: [
      {
        id: 'step-1',
        name: 'Launch',
        moduleId: 'launch_app',
        params: { packageName: 'com.example.app' },
        continueOnFailure: false
      }
    ]
  })
}

describe('RpaPlannerService', () => {
  it('returns a validated DSL task from model output', async () => {
    const client = modelClient([validTaskJson()])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: ['device-1'] })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(false)
    expect(result.task?.steps[0].moduleId).toBe('launch_app')
  })

  it('repairs invalid DSL once when validation fails', async () => {
    const client = modelClient([
      JSON.stringify({
        id: 'task-1',
        name: 'Bad task',
        goal: 'bad',
        deviceIds: ['device-1'],
        metadata: {},
        steps: [{ id: 'step-1', name: 'Bad', moduleId: 'missing_module', params: {}, continueOnFailure: false }]
      }),
      validTaskJson()
    ])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: ['device-1'] })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(true)
    expect(client.complete).toHaveBeenCalledTimes(2)
  })
})
