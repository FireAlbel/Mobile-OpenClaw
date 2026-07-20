import type { Model } from '@renderer/types'
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
        verify: { type: 'foreground_app', packageName: 'com.example.app' },
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

  it('generates a draft when no device is connected', async () => {
    const client = modelClient([validTaskJson().replace('["device-1"]', '[]')])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: [] })

    expect(result.success).toBe(true)
    expect(result.task?.deviceIds).toEqual([])
  })

  it('repairs invalid DSL once when validation fails', async () => {
    const selectedModel = {
      id: 'gpt-5.6-sol',
      name: 'gpt-5.6-sol',
      provider: 'timecho',
      group: 'gpt-5'
    } as Model
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

    const result = await service.plan({ goal: 'open app', deviceIds: ['device-1'], model: selectedModel })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(true)
    expect(client.complete).toHaveBeenCalledTimes(2)
    expect(client.complete).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: selectedModel }))
    expect(client.complete).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: selectedModel }))
  })

  it('repairs malformed JSON before validating the DSL', async () => {
    const client = modelClient(['{{invalid json', validTaskJson()])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: ['device-1'] })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(true)
    expect(client.complete).toHaveBeenCalledTimes(2)
  })

  it('returns a terminal validation issue when repaired JSON is still malformed', async () => {
    const client = modelClient(['not json', 'still not json'])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: ['device-1'] })

    expect(result.success).toBe(false)
    expect(result.repaired).toBe(true)
    expect(result.issues[0]).toEqual(expect.objectContaining({ path: '$' }))
    expect(result.issues[0].message).toContain('Invalid JSON')
  })
})
