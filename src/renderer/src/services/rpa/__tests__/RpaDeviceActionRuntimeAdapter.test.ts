import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RpaDeviceActionRuntimeAdapter } from '../RpaDeviceActionRuntimeAdapter'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  handlePermissionDialog: vi.fn()
}))

vi.mock('../../DeviceActionRuntime', () => ({
  deviceActionRuntime: { execute: mocks.execute }
}))

vi.mock('../../DeviceServiceProxy', () => ({
  deviceServiceProxy: {
    handlePermissionDialog: mocks.handlePermissionDialog
  }
}))

describe('RpaDeviceActionRuntimeAdapter', () => {
  beforeEach(() => {
    mocks.execute.mockReset()
    mocks.handlePermissionDialog.mockReset()
  })

  it('compiles a whitelisted tap into the device action runtime', async () => {
    mocks.execute.mockResolvedValue({
      success: true,
      message: 'tap complete',
      startedAt: 1,
      finishedAt: 2
    })
    const adapter = new RpaDeviceActionRuntimeAdapter()
    const action = { id: 'tap-close', type: 'tap' as const, x: 10, y: 20 }

    const result = await adapter.executeCorrectionAction('device-1', action)

    expect(mocks.execute).toHaveBeenCalledWith('device-1', { type: 'tap', params: { x: 10, y: 20 } })
    expect(result.data).toMatchObject({ transport: 'device_action_runtime', action })
  })

  it('requires a fresh scrcpy frame for RPA screenshots', async () => {
    mocks.execute.mockResolvedValue({ success: true, message: 'captured', startedAt: 1, finishedAt: 2 })
    const adapter = new RpaDeviceActionRuntimeAdapter()

    await adapter.screenshot('device-1')

    expect(mocks.execute).toHaveBeenCalledWith('device-1', {
      type: 'screenshot',
      params: { requireScrcpy: true, maxAgeMs: 1_000 }
    })
  })

  it('routes permission actions through the constrained permission service', async () => {
    mocks.handlePermissionDialog.mockResolvedValue(true)
    const adapter = new RpaDeviceActionRuntimeAdapter()

    const result = await adapter.executeCorrectionAction('device-1', {
      id: 'allow-dialog',
      type: 'permission_action',
      action: 'allow'
    })

    expect(mocks.handlePermissionDialog).toHaveBeenCalledWith('device-1', 'allow')
    expect(result.data).toMatchObject({ transport: 'android_permission_service' })
  })
})
