import type { Assistant, Model } from '@renderer/types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Modal } from 'antd'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import RpaChatWorkspace from '../RpaChatWorkspace'

const planMock = vi.hoisted(() => vi.fn())
const scanDevicesMock = vi.hoisted(() => vi.fn())
const startMock = vi.hoisted(() => vi.fn())

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ error: vi.fn(), warn: vi.fn() })
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key
  })
}))

vi.mock('@renderer/services/DeviceServiceProxy', () => ({
  deviceServiceProxy: { scanDevices: scanDevicesMock }
}))

vi.mock('@renderer/services/rpa/RpaPlannerService', () => ({
  RpaPlannerService: class {
    plan = planMock
  }
}))

vi.mock('@renderer/services/rpa/RpaBatchRunner', () => ({
  rpaBatchRunner: {
    start: startMock,
    getRuns: vi.fn(() => []),
    initialize: vi.fn(),
    subscribe: vi.fn(() => vi.fn())
  }
}))

describe('RpaChatWorkspace', () => {
  const model = { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', provider: 'timecho', group: 'gpt-5' } as Model
  const assistant = { id: 'assistant-1', name: 'Assistant', model } as Assistant

  beforeEach(() => {
    localStorage.clear()
    planMock.mockReset()
    scanDevicesMock.mockReset()
    startMock.mockReset()
    scanDevicesMock.mockResolvedValue([{ id: 'device-1', name: 'Phone', status: 'online' }])
    planMock.mockResolvedValue({
      success: true,
      repaired: false,
      rawResponse: '{}',
      issues: [],
      task: {
        id: 'task-1',
        name: 'Open app',
        goal: 'Open app',
        deviceIds: ['device-1'],
        metadata: {},
        steps: [
          {
            id: 'step-1',
            name: 'Capture screen',
            moduleId: 'screenshot',
            params: {},
            continueOnFailure: false
          }
        ]
      }
    })
    startMock.mockResolvedValue({ id: 'run-1' })
  })

  it('uses the chat model to plan and waits for manual confirmation before execution', async () => {
    const confirmSpy = vi.spyOn(Modal, 'confirm').mockReturnValue(undefined as never)
    render(<RpaChatWorkspace assistant={assistant} />)

    const input = await screen.findByPlaceholderText(/Describe the task/)
    fireEvent.change(input, { target: { value: 'Open the app' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(planMock).toHaveBeenCalledWith(expect.objectContaining({ model })))
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and execute/ }))

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(startMock).not.toHaveBeenCalled()

    const options = confirmSpy.mock.calls[0][0]
    await options.onOk?.()
    expect(startMock).toHaveBeenCalledWith(
      expect.objectContaining({ task: expect.objectContaining({ visionModel: model }), deviceIds: ['device-1'] })
    )
  })
})
