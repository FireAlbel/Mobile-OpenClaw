export interface DeviceMetadata {
  title: string
  remark: string
  groupId?: string
}

export interface DeviceGroup {
  id: string
  name: string
}

export const DEVICE_GROUPS_CONFIG_KEY = 'device.groups'
export const DEVICE_INFO_CONFIG_KEY = 'device.info'

export const isDeviceGroup = (item: unknown): item is DeviceGroup => {
  return Boolean(
    item &&
      typeof item === 'object' &&
      typeof (item as DeviceGroup).id === 'string' &&
      typeof (item as DeviceGroup).name === 'string' &&
      (item as DeviceGroup).name.trim()
  )
}

export const sanitizeDeviceGroups = (value: unknown): DeviceGroup[] => {
  if (!Array.isArray(value)) return []

  return value
    .filter(isDeviceGroup)
    .map((item) => ({ id: item.id.trim(), name: item.name.trim() }))
    .filter((item) => item.id && item.name)
    .filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index)
}

export const sanitizeDeviceMetadataMap = (value: unknown): Record<string, DeviceMetadata> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return Object.entries(value).reduce<Record<string, DeviceMetadata>>((result, [deviceId, metadata]) => {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return result
    }

    const item = metadata as Partial<DeviceMetadata>
    result[deviceId] = {
      title: typeof item.title === 'string' ? item.title : '',
      remark: typeof item.remark === 'string' ? item.remark : '',
      groupId: typeof item.groupId === 'string' && item.groupId ? item.groupId : undefined
    }
    return result
  }, {})
}

export const removeGroupAssignments = (
  deviceInfo: Record<string, DeviceMetadata>,
  groupId: string
): Record<string, DeviceMetadata> => {
  return Object.fromEntries(
    Object.entries(deviceInfo).map(([deviceId, metadata]) => [
      deviceId,
      metadata.groupId === groupId ? { ...metadata, groupId: undefined } : metadata
    ])
  )
}
