import type { DeviceInfo } from '@renderer/services/DeviceServiceProxy'

import type { DeviceGroup, DeviceMetadata } from '../../pages/device/deviceMetadata'

export type RpaExecutionTargetMode = 'manual' | 'groups' | 'all_online'

export interface RpaExecutionTargetIntent {
  mode: RpaExecutionTargetMode
  groupIds: string[]
  includedDeviceIds: string[]
  excludedDeviceIds: string[]
}

export interface RpaExecutionTargetSelection extends RpaExecutionTargetIntent {
  deviceIds: string[]
  unavailableDeviceIds: string[]
  partialGroupIds: string[]
  emptyGroupIds: string[]
  scannedAt: number
}

export interface ResolveRpaExecutionTargetInput {
  devices: DeviceInfo[]
  groups: DeviceGroup[]
  deviceInfo: Record<string, DeviceMetadata>
  intent: RpaExecutionTargetIntent
  scannedAt?: number
}

export function createDefaultRpaExecutionTargetIntent(): RpaExecutionTargetIntent {
  return { mode: 'manual', groupIds: [], includedDeviceIds: [], excludedDeviceIds: [] }
}

export function resolveRpaExecutionTargets(input: ResolveRpaExecutionTargetInput): RpaExecutionTargetSelection {
  const deviceById = new Map(input.devices.map((device) => [device.id, device]))
  const onlineIds = new Set(input.devices.filter((device) => device.status === 'online').map((device) => device.id))
  const knownGroupIds = new Set(input.groups.map((group) => group.id))
  const groupIds = uniqueIds(input.intent.groupIds).filter((groupId) => knownGroupIds.has(groupId))
  const includedIds = uniqueIds(input.intent.includedDeviceIds)
  const excludedIds = new Set(uniqueIds(input.intent.excludedDeviceIds))
  const groupMembers = new Map<string, string[]>()

  for (const [deviceId, metadata] of Object.entries(input.deviceInfo)) {
    if (!metadata.groupId || !knownGroupIds.has(metadata.groupId)) continue
    groupMembers.set(metadata.groupId, [...(groupMembers.get(metadata.groupId) ?? []), deviceId])
  }

  const baseIds = new Set<string>()
  if (input.intent.mode === 'all_online') {
    onlineIds.forEach((deviceId) => baseIds.add(deviceId))
  } else if (input.intent.mode === 'groups') {
    groupIds.forEach((groupId) => groupMembers.get(groupId)?.forEach((deviceId) => baseIds.add(deviceId)))
  }

  includedIds.forEach((deviceId) => baseIds.add(deviceId))

  const deviceIds = [...baseIds].filter((deviceId) => onlineIds.has(deviceId) && !excludedIds.has(deviceId)).sort()
  const unavailableDeviceIds = [...baseIds]
    .filter((deviceId) => !onlineIds.has(deviceId))
    .sort((left, right) => left.localeCompare(right))
  const emptyGroupIds = groupIds.filter((groupId) => (groupMembers.get(groupId) ?? []).length === 0)
  const partialGroupIds = groupIds.filter((groupId) => {
    const members = groupMembers.get(groupId) ?? []
    return members.some((deviceId) => onlineIds.has(deviceId)) && members.some((deviceId) => !onlineIds.has(deviceId))
  })

  return {
    mode: input.intent.mode,
    groupIds,
    includedDeviceIds: includedIds.filter((deviceId) => deviceById.has(deviceId) || input.deviceInfo[deviceId]),
    excludedDeviceIds: [...excludedIds].sort(),
    deviceIds,
    unavailableDeviceIds,
    partialGroupIds,
    emptyGroupIds,
    scannedAt: input.scannedAt ?? Date.now()
  }
}

export function updateTargetIntentFromDeviceSelection(
  input: ResolveRpaExecutionTargetInput,
  selectedDeviceIds: string[]
): RpaExecutionTargetIntent {
  const selected = new Set(uniqueIds(selectedDeviceIds))
  if (input.intent.mode === 'manual') {
    return { ...input.intent, includedDeviceIds: [...selected].sort(), excludedDeviceIds: [] }
  }

  const baseSelection = resolveRpaExecutionTargets({
    ...input,
    intent: { ...input.intent, includedDeviceIds: [], excludedDeviceIds: [] }
  })
  const baseIds = new Set([...baseSelection.deviceIds, ...baseSelection.unavailableDeviceIds])

  return {
    ...input.intent,
    includedDeviceIds: [...selected].filter((deviceId) => !baseIds.has(deviceId)).sort(),
    excludedDeviceIds: [...baseIds].filter((deviceId) => !selected.has(deviceId)).sort()
  }
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}
