import type { DeviceInfo } from '@renderer/services/DeviceServiceProxy'
import { describe, expect, it } from 'vitest'

import {
  createDefaultRpaExecutionTargetIntent,
  resolveRpaExecutionTargets,
  updateTargetIntentFromDeviceSelection
} from '../RpaExecutionTarget'

const devices = [
  { id: 'device-1', status: 'online' },
  { id: 'device-2', status: 'offline' },
  { id: 'device-3', status: 'online' }
] as DeviceInfo[]

const inventory = {
  devices,
  groups: [
    { id: 'group-a', name: 'Group A' },
    { id: 'group-b', name: 'Group B' },
    { id: 'group-empty', name: 'Empty' }
  ],
  deviceInfo: {
    'device-1': { title: 'One', remark: '', groupId: 'group-a' },
    'device-2': { title: 'Two', remark: '', groupId: 'group-a' },
    'device-3': { title: 'Three', remark: '', groupId: 'group-b' }
  },
  scannedAt: 123
}

describe('RpaExecutionTarget', () => {
  it('resolves manual targets and ignores missing or offline devices', () => {
    const selection = resolveRpaExecutionTargets({
      ...inventory,
      intent: {
        ...createDefaultRpaExecutionTargetIntent(),
        includedDeviceIds: ['device-3', 'device-1', 'device-2', 'missing', 'device-1']
      }
    })

    expect(selection.deviceIds).toEqual(['device-1', 'device-3'])
    expect(selection.unavailableDeviceIds).toEqual(['device-2', 'missing'])
    expect(selection.includedDeviceIds).toEqual(['device-3', 'device-1', 'device-2'])
    expect(selection.scannedAt).toBe(123)
  })

  it('combines multiple groups, de-duplicates devices, and reports partial and empty groups', () => {
    const selection = resolveRpaExecutionTargets({
      ...inventory,
      intent: {
        mode: 'groups',
        groupIds: ['group-a', 'group-b', 'group-empty', 'group-a'],
        includedDeviceIds: [],
        excludedDeviceIds: []
      }
    })

    expect(selection.deviceIds).toEqual(['device-1', 'device-3'])
    expect(selection.unavailableDeviceIds).toEqual(['device-2'])
    expect(selection.partialGroupIds).toEqual(['group-a'])
    expect(selection.emptyGroupIds).toEqual(['group-empty'])
  })

  it('selects every online device and supports explicit exclusion', () => {
    const selection = resolveRpaExecutionTargets({
      ...inventory,
      intent: {
        mode: 'all_online',
        groupIds: [],
        includedDeviceIds: [],
        excludedDeviceIds: ['device-3']
      }
    })

    expect(selection.deviceIds).toEqual(['device-1'])
    expect(selection.unavailableDeviceIds).toEqual([])
  })

  it('returns no executable targets when every selected device is unavailable', () => {
    const selection = resolveRpaExecutionTargets({
      ...inventory,
      devices: [
        { id: 'device-2', name: 'Offline', status: 'offline' },
        { id: 'device-4', name: 'Unauthorized', status: 'unauthorized' }
      ],
      deviceInfo: {
        ...inventory.deviceInfo,
        'device-4': { title: 'Four', remark: '', groupId: 'group-a' }
      },
      intent: {
        mode: 'groups',
        groupIds: ['group-a'],
        includedDeviceIds: [],
        excludedDeviceIds: []
      }
    })

    expect(selection.deviceIds).toEqual([])
    expect(selection.unavailableDeviceIds).toEqual(['device-1', 'device-2', 'device-4'])
  })

  it('translates checkbox changes into group overrides', () => {
    const intent = {
      mode: 'groups' as const,
      groupIds: ['group-a'],
      includedDeviceIds: [],
      excludedDeviceIds: []
    }
    const updated = updateTargetIntentFromDeviceSelection({ ...inventory, intent }, ['device-2', 'device-3'])

    expect(updated.includedDeviceIds).toEqual(['device-3'])
    expect(updated.excludedDeviceIds).toEqual(['device-1'])
  })
})
