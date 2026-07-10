import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeMock = vi.hoisted(() => vi.fn())
const requestPlanMock = vi.hoisted(() => vi.fn())

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    })
  }
}))

vi.mock('../DeviceActionRuntime', () => ({
  deviceActionRuntime: {
    execute: executeMock
  }
}))

vi.mock('../DeerFlowAdapter', () => ({
  deerFlowAdapter: {
    requestPlan: requestPlanMock
  }
}))

import { DeviceTaskOrchestrator } from '../DeviceTaskOrchestrator'

describe('DeviceTaskOrchestrator', () => {
  beforeEach(() => {
    localStorage.clear()
    executeMock.mockReset()
    requestPlanMock.mockReset()
    executeMock.mockResolvedValue({
      type: 'tap',
      success: true,
      message: 'ok',
      startedAt: 1,
      finishedAt: 2
    })
  })

  it('runs queued tasks serially per device', async () => {
    const orchestrator = new DeviceTaskOrchestrator()

    const task = orchestrator.enqueue({
      deviceId: 'device-1',
      goal: 'tap',
      steps: [{ id: 'step-1', name: 'tap', action: { type: 'tap', params: { x: 1, y: 2 } } }]
    })

    await vi.waitFor(() => {
      expect(orchestrator.getTasks().find((item) => item.id === task.id)?.status).toBe('completed')
    })
    expect(executeMock).toHaveBeenCalledWith('device-1', { type: 'tap', params: { x: 1, y: 2 } })
  })

  it('can pause and resume a pending task', () => {
    const orchestrator = new DeviceTaskOrchestrator()
    const task = orchestrator.enqueue({
      deviceId: 'device-1',
      goal: 'tap',
      steps: [{ id: 'step-1', name: 'tap', action: { type: 'tap', params: { x: 1, y: 2 } } }]
    })

    expect(orchestrator.pause(task.id)).toBe(true)
    expect(orchestrator.getTasks().find((item) => item.id === task.id)?.status).toBe('paused')
    expect(orchestrator.resume(task.id)).toBe(true)
  })

  it('records DeerFlow adapter messages without blocking local execution', async () => {
    requestPlanMock.mockResolvedValue({ available: false, message: 'not configured' })
    const orchestrator = new DeviceTaskOrchestrator()
    const task = orchestrator.enqueue({
      deviceId: 'device-1',
      goal: 'do something',
      useDeerFlow: true,
      steps: [{ id: 'step-1', name: 'tap', action: { type: 'tap', params: { x: 1, y: 2 } } }]
    })

    await vi.waitFor(() => {
      expect(requestPlanMock).toHaveBeenCalled()
      expect(orchestrator.getLogs(task.id).some((log) => log.message === 'not configured')).toBe(true)
    })
  })
})
