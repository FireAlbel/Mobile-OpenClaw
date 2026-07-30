import { loggerService } from '@logger'
import type { DeviceInfo } from '@renderer/services/DeviceServiceProxy'
import { deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'
import {
  createDefaultRpaExecutionTargetIntent,
  resolveRpaExecutionTargets,
  type RpaExecutionTargetIntent,
  type RpaExecutionTargetMode,
  type RpaExecutionTargetSelection,
  updateTargetIntentFromDeviceSelection
} from '@renderer/services/rpa/RpaExecutionTarget'
import type { RpaTask, RpaTaskRiskSummary } from '@renderer/services/rpa/RpaTypes'
import { Alert, Button, Checkbox, message, Modal, Segmented, Space, Spin, Typography } from 'antd'
import { RefreshCw, Settings2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import DeviceManagementModal from './DeviceManagementModal'
import {
  DEVICE_GROUPS_CONFIG_KEY,
  DEVICE_INFO_CONFIG_KEY,
  type DeviceGroup,
  type DeviceMetadata,
  sanitizeDeviceGroups,
  sanitizeDeviceMetadataMap
} from './deviceMetadata'

const logger = loggerService.withContext('RpaExecutionConfirmModal')

interface DeviceInventory {
  devices: DeviceInfo[]
  groups: DeviceGroup[]
  deviceInfo: Record<string, DeviceMetadata>
  scannedAt: number
}

interface Props {
  open: boolean
  task: RpaTask
  riskSummary: RpaTaskRiskSummary
  onCancel: () => void
  onExecute: (selection: RpaExecutionTargetSelection) => Promise<void>
}

const EMPTY_INVENTORY: DeviceInventory = { devices: [], groups: [], deviceInfo: {}, scannedAt: 0 }

const RpaExecutionConfirmModal: FC<Props> = ({ open, task, riskSummary, onCancel, onExecute }) => {
  const { t } = useTranslation()
  const [inventory, setInventory] = useState<DeviceInventory>(EMPTY_INVENTORY)
  const [intent, setIntent] = useState<RpaExecutionTargetIntent>(createDefaultRpaExecutionTargetIntent)
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [scanError, setScanError] = useState<string>()
  const [allowPartialGroup, setAllowPartialGroup] = useState(false)
  const [deviceManagementOpen, setDeviceManagementOpen] = useState(false)

  const selection = useMemo(
    () =>
      resolveRpaExecutionTargets({
        ...inventory,
        intent
      }),
    [intent, inventory]
  )
  const onlineDevices = useMemo(
    () => inventory.devices.filter((device) => device.status === 'online'),
    [inventory.devices]
  )
  const unavailableGroupDevices = intent.mode === 'groups' ? selection.unavailableDeviceIds : []
  const hasPartialGroupSelection = unavailableGroupDevices.length > 0 || selection.emptyGroupIds.length > 0
  const requiresHighRiskConfirmation = riskSummary.highRiskTargets.length > 0

  const fetchInventory = useCallback(async (): Promise<DeviceInventory> => {
    const [devices, storedGroups, storedDeviceInfo] = await Promise.all([
      deviceServiceProxy.scanDevices(),
      window.api.config.get(DEVICE_GROUPS_CONFIG_KEY),
      window.api.config.get(DEVICE_INFO_CONFIG_KEY)
    ])
    return {
      devices,
      groups: sanitizeDeviceGroups(storedGroups),
      deviceInfo: sanitizeDeviceMetadataMap(storedDeviceInfo),
      scannedAt: Date.now()
    }
  }, [])

  const refreshInventory = useCallback(async () => {
    setLoading(true)
    setScanError(undefined)
    try {
      setInventory(await fetchInventory())
    } catch (error) {
      logger.error('Failed to refresh RPA execution devices', { error })
      setScanError(
        t('device.rpa.target_scan_failed', {
          defaultValue: 'Failed to scan devices. Keep this dialog open and try again.'
        })
      )
    } finally {
      setLoading(false)
    }
  }, [fetchInventory, t])

  useEffect(() => {
    if (!open) return
    setIntent(createDefaultRpaExecutionTargetIntent())
    setInventory(EMPTY_INVENTORY)
    setAllowPartialGroup(false)
    setScanError(undefined)
    void refreshInventory()
  }, [open, refreshInventory])

  const setMode = (mode: RpaExecutionTargetMode) => {
    setIntent({ ...createDefaultRpaExecutionTargetIntent(), mode })
    setAllowPartialGroup(false)
  }

  const setGroupIds = (groupIds: string[]) => {
    setIntent({ ...intent, groupIds, includedDeviceIds: [], excludedDeviceIds: [] })
    setAllowPartialGroup(false)
  }

  const setSelectedDeviceIds = (deviceIds: string[]) => {
    setIntent(
      updateTargetIntentFromDeviceSelection(
        {
          ...inventory,
          intent
        },
        deviceIds
      )
    )
    setAllowPartialGroup(false)
  }

  const execute = async () => {
    if (selection.deviceIds.length === 0) {
      message.error(t('device.rpa.select_device'))
      return
    }
    if (hasPartialGroupSelection && !allowPartialGroup) {
      message.warning(
        t('device.rpa.confirm_partial_group', {
          defaultValue: 'Review unavailable group devices and confirm execution with the online subset.'
        })
      )
      return
    }

    setSubmitting(true)
    setScanError(undefined)
    let latestInventory: DeviceInventory
    try {
      latestInventory = await fetchInventory()
    } catch (error) {
      logger.error('Failed to preflight RPA execution targets', { error, taskId: task.id })
      setScanError(
        t('device.rpa.target_scan_failed', {
          defaultValue: 'Failed to scan devices. Keep this dialog open and try again.'
        })
      )
      setSubmitting(false)
      return
    }

    const latestSelection = resolveRpaExecutionTargets({ ...latestInventory, intent })
    if (!sameIds(selection.deviceIds, latestSelection.deviceIds)) {
      const added = latestSelection.deviceIds.filter((deviceId) => !selection.deviceIds.includes(deviceId))
      const removed = selection.deviceIds.filter((deviceId) => !latestSelection.deviceIds.includes(deviceId))
      setInventory(latestInventory)
      setAllowPartialGroup(false)
      message.warning(
        t('device.rpa.target_selection_changed', {
          defaultValue: 'Device status changed. Added: {{added}}; removed: {{removed}}. Review and confirm again.',
          added: added.join(', ') || '-',
          removed: removed.join(', ') || '-'
        })
      )
      setSubmitting(false)
      return
    }
    if (latestSelection.deviceIds.length === 0) {
      setInventory(latestInventory)
      message.error(t('device.rpa.select_device'))
      setSubmitting(false)
      return
    }

    try {
      await onExecute(latestSelection)
    } catch (error) {
      logger.error('Failed to start confirmed RPA execution', { error, taskId: task.id })
      setScanError(
        t('device.rpa.execution_failed', {
          defaultValue: 'Failed to start the RPA workflow. Review the task and try again.'
        })
      )
    } finally {
      setSubmitting(false)
    }
  }

  const getDeviceLabel = (deviceId: string) => {
    const device = inventory.devices.find((item) => item.id === deviceId)
    const metadata = inventory.deviceInfo[deviceId]
    return metadata?.title || device?.name || device?.model || deviceId
  }

  const getUnavailableDeviceLabel = (deviceId: string) => {
    const status = inventory.devices.find((item) => item.id === deviceId)?.status
    const statusLabel =
      status === 'offline'
        ? t('device.status.offline')
        : status === 'unauthorized'
          ? t('device.status.unauthorized')
          : status === 'online'
            ? t('device.status.online')
            : t('device.rpa.target_status_missing', { defaultValue: 'Missing' })
    return `${getDeviceLabel(deviceId)} (${statusLabel})`
  }

  return (
    <>
      <Modal
        title={
          requiresHighRiskConfirmation ? t('device.rpa.confirm_high_risk_execution') : t('device.rpa.confirm_execution')
        }
        open={open}
        onCancel={onCancel}
        onOk={() => void execute()}
        okText={t('device.rpa.execute')}
        cancelText={t('common.cancel')}
        confirmLoading={submitting}
        okButtonProps={{
          danger: requiresHighRiskConfirmation,
          disabled: loading || selection.deviceIds.length === 0 || (hasPartialGroupSelection && !allowPartialGroup)
        }}
        width={720}>
        <ModalContent>
          <Typography.Text>
            {t('device.rpa.confirm_execution_detail', {
              steps: task.steps.length,
              devices: selection.deviceIds.length
            })}
          </Typography.Text>
          <Alert
            type={requiresHighRiskConfirmation ? 'warning' : 'info'}
            showIcon
            message={t('device.rpa.risk_summary', { risk: riskSummary.highestRisk })}
            description={
              requiresHighRiskConfirmation
                ? t('device.rpa.high_risk_targets', { targets: riskSummary.highRiskTargets.join(', ') })
                : undefined
            }
          />

          <TargetHeader>
            <Typography.Text strong>{t('device.rpa.select_execution_targets')}</Typography.Text>
            <Space size={4}>
              <Button
                type="text"
                icon={<RefreshCw size={16} />}
                loading={loading}
                aria-label={t('device.refresh')}
                onClick={() => void refreshInventory()}
              />
              <Button
                type="text"
                icon={<Settings2 size={16} />}
                aria-label={t('device.management_title')}
                onClick={() => setDeviceManagementOpen(true)}
              />
            </Space>
          </TargetHeader>

          <Segmented
            block
            value={intent.mode}
            options={[
              { value: 'manual', label: t('device.rpa.target_mode_manual') },
              { value: 'groups', label: t('device.rpa.target_mode_groups') },
              { value: 'all_online', label: t('device.rpa.target_mode_all_online') }
            ]}
            onChange={(value) => setMode(value as RpaExecutionTargetMode)}
          />

          {scanError && <Alert type="error" showIcon message={scanError} />}
          <Spin spinning={loading}>
            {intent.mode === 'groups' && (
              <SelectionBlock>
                <Typography.Text type="secondary">{t('device.rpa.select_device_groups')}</Typography.Text>
                {inventory.groups.length > 0 ? (
                  <Checkbox.Group value={intent.groupIds} onChange={(values) => setGroupIds(values.map(String))}>
                    <CheckboxList>
                      {inventory.groups.map((group) => {
                        const count = Object.values(inventory.deviceInfo).filter(
                          (metadata) => metadata.groupId === group.id
                        ).length
                        return (
                          <Checkbox key={group.id} value={group.id}>
                            {group.name} ({count})
                          </Checkbox>
                        )
                      })}
                    </CheckboxList>
                  </Checkbox.Group>
                ) : (
                  <Typography.Text type="secondary">{t('device.rpa.no_device_groups')}</Typography.Text>
                )}
              </SelectionBlock>
            )}

            <SelectionBlock>
              <Typography.Text type="secondary">{t('device.rpa.online_devices')}</Typography.Text>
              {onlineDevices.length > 0 ? (
                <Checkbox.Group
                  value={selection.deviceIds}
                  onChange={(values) => setSelectedDeviceIds(values.map(String))}>
                  <CheckboxList>
                    {onlineDevices.map((device) => (
                      <Checkbox key={device.id} value={device.id}>
                        {getDeviceLabel(device.id)}
                      </Checkbox>
                    ))}
                  </CheckboxList>
                </Checkbox.Group>
              ) : (
                <Typography.Text type="secondary">{t('device.rpa.no_online_devices')}</Typography.Text>
              )}
            </SelectionBlock>
          </Spin>

          {intent.mode === 'groups' && unavailableGroupDevices.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={t('device.rpa.group_devices_unavailable', {
                devices: unavailableGroupDevices.map(getUnavailableDeviceLabel).join(', ')
              })}
            />
          )}
          {intent.mode === 'groups' && selection.emptyGroupIds.length > 0 && (
            <Alert
              type="warning"
              showIcon
              message={t('device.rpa.empty_groups_selected', {
                groups: inventory.groups
                  .filter((group) => selection.emptyGroupIds.includes(group.id))
                  .map((group) => group.name)
                  .join(', ')
              })}
            />
          )}
          {hasPartialGroupSelection && (
            <Checkbox checked={allowPartialGroup} onChange={(event) => setAllowPartialGroup(event.target.checked)}>
              {t('device.rpa.continue_with_online_subset')}
            </Checkbox>
          )}

          <Summary>
            {t('device.rpa.execution_target_summary', {
              devices: selection.deviceIds.length,
              groups: selection.groupIds.length
            })}
          </Summary>
        </ModalContent>
      </Modal>

      <DeviceManagementModal
        open={deviceManagementOpen}
        onClose={() => {
          setDeviceManagementOpen(false)
          void refreshInventory()
        }}
      />
    </>
  )
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

const ModalContent = styled.div`
  display: flex;
  flex-direction: column;
  gap: 14px;
`

const TargetHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: -6px;
`

const SelectionBlock = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
`

const CheckboxList = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 16px;

  @media (max-width: 620px) {
    grid-template-columns: 1fr;
  }
`

const Summary = styled.div`
  padding-top: 10px;
  border-top: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 12px;
`

export default RpaExecutionConfirmModal
