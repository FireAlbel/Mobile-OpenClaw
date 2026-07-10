import { describe, expect, it } from 'vitest'

import { isDeviceGroup, removeGroupAssignments, sanitizeDeviceMetadataMap } from '../deviceMetadata'

describe('device metadata utilities', () => {
  it('validates device groups', () => {
    expect(isDeviceGroup({ id: 'group-1', name: 'QA Devices' })).toBe(true)
    expect(isDeviceGroup({ id: 'group-1', name: '' })).toBe(false)
    expect(isDeviceGroup({ id: 1, name: 'QA Devices' })).toBe(false)
    expect(isDeviceGroup(null)).toBe(false)
  })

  it('sanitizes stored device metadata', () => {
    expect(
      sanitizeDeviceMetadataMap({
        'device-1': { title: 'Pixel', remark: 'Main', groupId: 'group-1' },
        'device-2': { title: 1, remark: null, groupId: '' },
        'device-3': 'invalid'
      })
    ).toEqual({
      'device-1': { title: 'Pixel', remark: 'Main', groupId: 'group-1' },
      'device-2': { title: '', remark: '', groupId: undefined }
    })
  })

  it('removes a deleted group assignment without losing metadata', () => {
    expect(
      removeGroupAssignments(
        {
          'device-1': { title: 'One', remark: 'Keep', groupId: 'group-1' },
          'device-2': { title: 'Two', remark: 'Keep', groupId: 'group-2' }
        },
        'group-1'
      )
    ).toEqual({
      'device-1': { title: 'One', remark: 'Keep', groupId: undefined },
      'device-2': { title: 'Two', remark: 'Keep', groupId: 'group-2' }
    })
  })
})
