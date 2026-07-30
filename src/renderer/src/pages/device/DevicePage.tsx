import { SearchOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { type DeviceInfo, deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'
import {
  Button,
  Card,
  Collapse,
  Dropdown,
  Input,
  type MenuProps,
  message,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography
} from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import BatchControlPanel from './BatchControlPanel'
import BatchInstallPanel from './BatchInstallPanel'
import DeviceControlPanel from './DeviceControlPanel'
import {
  DEVICE_GROUPS_CONFIG_KEY,
  DEVICE_INFO_CONFIG_KEY,
  type DeviceGroup,
  type DeviceMetadata,
  removeGroupAssignments,
  sanitizeDeviceGroups,
  sanitizeDeviceMetadataMap
} from './deviceMetadata'

const logger = loggerService.withContext('DevicePage')

interface DeviceEditDraft {
  deviceId: string
  title: string
  remark: string
  groupId: string
}

interface DevicePageProps {
  initialScanDelayMs?: number
  refreshIntervalMs?: number
}

const NO_GROUP_VALUE = '__none__'
const DEFAULT_REFRESH_INTERVAL_MS = 5000

const DevicePage: React.FC<DevicePageProps> = ({
  initialScanDelayMs = 300,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS
}) => {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [scanning, setScanning] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [scrcpyError, setScrcpyError] = useState<string | null>(null)
  const [showControlPanel, setShowControlPanel] = useState<boolean>(false)
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null)
  const [showBatchInstallPanel, setShowBatchInstallPanel] = useState<boolean>(false)
  const [showBatchControlPanel, setShowBatchControlPanel] = useState<boolean>(false)
  const [searchKeyword, setSearchKeyword] = useState<string>('')
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [deviceInfo, setDeviceInfo] = useState<Record<string, DeviceMetadata>>({})
  const [connectingDevice, setConnectingDevice] = useState<string | null>(null)
  const [connectedDevices, setConnectedDevices] = useState<Set<string>>(() => new Set())
  const [showScrcpyErrorModal, setShowScrcpyErrorModal] = useState<boolean>(false)
  const [editDraft, setEditDraft] = useState<DeviceEditDraft | null>(null)

  const { t } = useTranslation()
  const tr = useCallback(
    (key: string, defaultValue: string, options?: Record<string, unknown>) => {
      return t(key, { defaultValue, ...options })
    },
    [t]
  )

  const renderStatusTag = (status: DeviceInfo['status']) => {
    switch (status) {
      case 'online':
        return <Tag color="green">{t('device.status.online')}</Tag>
      case 'offline':
        return <Tag color="red">{t('device.status.offline')}</Tag>
      case 'unauthorized':
        return <Tag color="orange">{t('device.status.unauthorized')}</Tag>
    }
  }

  const getDevicePort = (deviceId: string) => {
    const match = deviceId.match(/:(\d+)$/)
    return match?.[1] ?? '--'
  }

  const getDeviceRemarkFallback = (device: DeviceInfo) => {
    return device.model || device.brand || t('device.default_device')
  }

  const loadGroups = useCallback(async () => {
    try {
      const stored = await window.api.config.get(DEVICE_GROUPS_CONFIG_KEY)
      setGroups(sanitizeDeviceGroups(stored))
    } catch (loadError) {
      logger.error('Failed to load device groups', { error: loadError })
      setGroups([])
    }
  }, [])

  const loadDeviceInfo = useCallback(async () => {
    try {
      const stored = await window.api.config.get(DEVICE_INFO_CONFIG_KEY)
      setDeviceInfo(sanitizeDeviceMetadataMap(stored))
    } catch (loadError) {
      logger.error('Failed to load device metadata', { error: loadError })
      setDeviceInfo({})
    }
  }, [])

  const fetchDevices = useCallback(
    async (showLoading = false) => {
      try {
        if (showLoading) {
          setLoading(true)
        } else {
          setScanning(true)
        }
        setError(null)

        const newDevices = await deviceServiceProxy.scanDevices()
        setDevices((prev) => (JSON.stringify(prev) === JSON.stringify(newDevices) ? prev : newDevices))
        setLastRefresh(new Date())
      } catch (scanError) {
        logger.error('Failed to fetch devices', { error: scanError })
        setError(
          tr(
            'device.error.fetch_failed',
            'Failed to scan devices. Please check whether ADB is available and USB debugging is enabled.'
          )
        )
      } finally {
        setLoading(false)
        setScanning(false)
      }
    },
    [tr]
  )

  useEffect(() => {
    loadGroups()
    loadDeviceInfo()

    const timer = setTimeout(() => fetchDevices(true), initialScanDelayMs)
    const interval = refreshIntervalMs > 0 ? setInterval(() => fetchDevices(false), refreshIntervalMs) : undefined

    return () => {
      clearTimeout(timer)
      if (interval) {
        clearInterval(interval)
      }
    }
  }, [fetchDevices, initialScanDelayMs, loadDeviceInfo, loadGroups, refreshIntervalMs])

  useEffect(() => {
    return deviceServiceProxy.onScrcpyStopped(({ deviceId }) => {
      setConnectedDevices((prev) => {
        if (!prev.has(deviceId)) return prev
        const next = new Set(prev)
        next.delete(deviceId)
        return next
      })
    })
  }, [])

  useEffect(() => {
    const currentDeviceIds = new Set(devices.map((device) => device.id))
    setConnectedDevices((prev) => {
      const next = new Set([...prev].filter((deviceId) => currentDeviceIds.has(deviceId)))
      return next.size === prev.size ? prev : next
    })
  }, [devices])

  const saveGroups = async (nextGroups: DeviceGroup[]) => {
    setGroups(nextGroups)
    await window.api.config.set(DEVICE_GROUPS_CONFIG_KEY, nextGroups)
  }

  const saveDeviceInfo = async (info: Record<string, DeviceMetadata>) => {
    const sanitized = sanitizeDeviceMetadataMap(info)
    setDeviceInfo(sanitized)
    await window.api.config.set(DEVICE_INFO_CONFIG_KEY, sanitized)
  }

  const startScreenMirroring = async (serial: string) => {
    try {
      setScrcpyError(null)
      setConnectingDevice(serial)
      const result = await deviceServiceProxy.startScrcpy(serial)
      if (!result.port) {
        setScrcpyError(t('device.error.start_failed'))
        setShowScrcpyErrorModal(true)
        return
      }
      setConnectedDevices((prev) => new Set(prev).add(serial))
    } catch (startError: any) {
      const errorMessage = startError.message || String(startError)
      let userMessage = ''
      if (errorMessage.includes('INJECT_EVENTS')) {
        userMessage = t('device.error.inject_events')
      } else if (errorMessage.includes('permission')) {
        userMessage = t('device.error.permission')
      } else if (errorMessage.includes('exited')) {
        userMessage = t('device.error.exited')
      } else {
        userMessage = `${t('device.error.generic')}${errorMessage}${t('device.error.try_command')}`
      }

      logger.error('Failed to start screen mirroring', { error: startError, serial })
      setScrcpyError(userMessage)
      setShowScrcpyErrorModal(true)
    } finally {
      setConnectingDevice(null)
    }
  }

  const filteredDevices = useMemo(() => {
    const key = searchKeyword.trim().toLowerCase()
    if (!key) return devices

    return devices.filter((device) => {
      const metadata = deviceInfo[device.id]
      return [
        metadata?.title,
        metadata?.remark,
        device.name,
        device.id,
        device.model,
        device.brand,
        device.androidVersion
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(key)
    })
  }, [deviceInfo, devices, searchKeyword])

  const devicesByGroup = useMemo(() => {
    const grouped = new Map<string, DeviceInfo[]>()
    const ungrouped: DeviceInfo[] = []
    const groupIds = new Set(groups.map((group) => group.id))

    for (const device of filteredDevices) {
      const groupId = deviceInfo[device.id]?.groupId
      if (groupId && groupIds.has(groupId)) {
        grouped.set(groupId, [...(grouped.get(groupId) || []), device])
      } else {
        ungrouped.push(device)
      }
    }

    return { grouped, ungrouped }
  }, [deviceInfo, filteredDevices, groups])

  const batchMenuItems: MenuProps['items'] = [
    { key: 'control', label: t('device.batch_control.title') },
    { key: 'install', label: t('device.batch_install.title') }
  ]

  const handleBatchMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'install') {
      setShowBatchInstallPanel(true)
      return
    }
    setShowBatchControlPanel(true)
  }

  const handleCreateGroup = async () => {
    const groupName = await PromptPopup.show({
      title: t('device.group.create'),
      message: '',
      defaultValue: ''
    })

    const trimmedName = groupName?.trim()
    if (!trimmedName) return

    if (groups.some((group) => group.name === trimmedName)) {
      message.warning(t('device.group.name_exists'))
      return
    }

    const nextGroups = [...groups, { id: `device-group-${Date.now()}`, name: trimmedName }]
    try {
      await saveGroups(nextGroups)
      message.success(t('device.group.create_success'))
    } catch (saveError) {
      logger.error('Failed to save groups', { error: saveError })
      message.error(t('device.group.save_failed'))
    }
  }

  const handleEditGroup = async (group: DeviceGroup) => {
    const newName = await PromptPopup.show({
      title: t('device.group.edit'),
      message: '',
      defaultValue: group.name
    })

    const trimmedName = newName?.trim()
    if (!trimmedName || trimmedName === group.name) return

    if (groups.some((item) => item.id !== group.id && item.name === trimmedName)) {
      message.warning(t('device.group.name_exists'))
      return
    }

    const nextGroups = groups.map((item) => (item.id === group.id ? { ...item, name: trimmedName } : item))
    try {
      await saveGroups(nextGroups)
      message.success(t('device.group.update_success'))
    } catch (saveError) {
      logger.error('Failed to update group', { error: saveError, groupId: group.id })
      message.error(t('device.group.save_failed'))
    }
  }

  const handleDeleteGroup = async (group: DeviceGroup) => {
    const confirmed = await PromptPopup.show({
      title: t('device.group.delete'),
      message: t('device.group.delete_confirm', { groupName: group.name }),
      defaultValue: ''
    })

    if (confirmed?.trim() !== group.name) return

    const nextGroups = groups.filter((item) => item.id !== group.id)
    const nextDeviceInfo = removeGroupAssignments(deviceInfo, group.id)

    try {
      await saveGroups(nextGroups)
      await saveDeviceInfo(nextDeviceInfo)
      message.success(t('device.group.delete_success'))
    } catch (deleteError) {
      logger.error('Failed to delete group', { error: deleteError, groupId: group.id })
      message.error(t('device.group.delete_failed'))
    }
  }

  const openEditDeviceModal = (device: DeviceInfo) => {
    const metadata = deviceInfo[device.id]
    setEditDraft({
      deviceId: device.id,
      title: metadata?.title || device.name || '',
      remark: metadata?.remark || getDeviceRemarkFallback(device),
      groupId: metadata?.groupId || NO_GROUP_VALUE
    })
  }

  const saveEditDeviceModal = async () => {
    if (!editDraft) return

    const nextDeviceInfo = {
      ...deviceInfo,
      [editDraft.deviceId]: {
        title: editDraft.title.trim(),
        remark: editDraft.remark.trim(),
        groupId: editDraft.groupId === NO_GROUP_VALUE ? undefined : editDraft.groupId
      }
    }

    try {
      await saveDeviceInfo(nextDeviceInfo)
      setEditDraft(null)
      message.success(t('device.device_info.update_success'))
    } catch (saveError) {
      logger.error('Failed to update device metadata', { error: saveError, deviceId: editDraft.deviceId })
      message.error(t('device.device_info.update_failed'))
    }
  }

  const renderDeviceCard = (device: DeviceInfo) => {
    const metadata = deviceInfo[device.id]
    const customTitle = metadata?.title || device.name || t('device.unnamed_device')
    const customRemark = metadata?.remark || ''
    const isConnecting = connectingDevice === device.id
    const isConnected = connectedDevices.has(device.id)

    return (
      <Card
        key={device.id}
        actions={[
          <Button
            key="connect"
            type="link"
            disabled={isConnecting || isConnected}
            onClick={() => startScreenMirroring(device.id)}>
            {isConnecting
              ? tr('device.connecting', 'Connecting...')
              : isConnected
                ? tr('device.connected', 'Connected')
                : t('device.connect')}
          </Button>,
          <Button
            key="command"
            type="link"
            onClick={() => {
              setSelectedDevice(device.id)
              setShowControlPanel(true)
            }}>
            {t('device.command')}
          </Button>,
          <Button key="edit" type="link" onClick={() => openEditDeviceModal(device)}>
            {t('device.edit')}
          </Button>
        ]}>
        <DeviceCardHeader>
          <Card.Meta title={customTitle} />
          {renderStatusTag(device.status)}
        </DeviceCardHeader>
        <DeviceDetails>
          <DeviceIdBlock>
            <span>{t('device.device_id')}</span>
            <strong>{device.id}</strong>
          </DeviceIdBlock>
          <DetailGrid>
            <DetailItem>
              <span>{t('device.model')}</span>
              <strong>{device.model || t('device.unknown')}</strong>
            </DetailItem>
            <DetailItem>
              <span>{t('device.brand')}</span>
              <strong>{device.brand || t('device.unknown')}</strong>
            </DetailItem>
            <DetailItem>
              <span>{tr('device.android_version', 'Android Version')}</span>
              <strong>{device.androidVersion || t('device.unknown')}</strong>
            </DetailItem>
            <DetailItem>
              <span>{t('device.port')}</span>
              <strong>{getDevicePort(device.id)}</strong>
            </DetailItem>
            <DetailItemFull>
              <span>{t('device.remark')}</span>
              <strong>{customRemark || t('device.unknown')}</strong>
            </DetailItemFull>
          </DetailGrid>
          {device.status === 'unauthorized' && (
            <UnauthorizedHint>
              {tr('device.unauthorized_hint', 'Authorize USB debugging on the device, then refresh.')}
            </UnauthorizedHint>
          )}
        </DeviceDetails>
      </Card>
    )
  }

  return (
    <Container>
      <Toolbar>
        <SearchInput
          allowClear
          value={searchKeyword}
          onChange={(event) => setSearchKeyword(event.target.value)}
          placeholder={t('device.search_placeholder')}
          prefix={<SearchOutlined />}
        />
        <Button type="primary" onClick={handleCreateGroup}>
          {t('device.create_group')}
        </Button>
        <Dropdown menu={{ items: batchMenuItems, onClick: handleBatchMenuClick }} trigger={['click']}>
          <Button>{t('device.batch_operations')}</Button>
        </Dropdown>
        <Button loading={scanning} onClick={() => fetchDevices(true)}>
          {t('device.refresh')}
        </Button>
      </Toolbar>

      {error && (
        <ErrorState>
          <Typography.Text type="danger">{error}</Typography.Text>
          <Button onClick={() => fetchDevices(true)}>{t('device.refresh')}</Button>
        </ErrorState>
      )}

      <ContentArea>
        <Spin spinning={loading}>
          {filteredDevices.length === 0 ? (
            <EmptyState>
              <Typography.Text type="secondary">{t('device.no_devices')}</Typography.Text>
              <Button type="primary" onClick={() => fetchDevices(true)}>
                {t('device.refresh')}
              </Button>
            </EmptyState>
          ) : (
            <>
              {groups.length > 0 && (
                <GroupSection>
                  <GroupCollapse defaultActiveKey={groups.map((group) => group.id)} bordered={false}>
                    {groups.map((group) => {
                      const groupDevices = devicesByGroup.grouped.get(group.id) || []
                      return (
                        <Collapse.Panel
                          key={group.id}
                          header={`${group.name} (${groupDevices.length})`}
                          extra={
                            <Space size={8}>
                              <Button
                                size="small"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  handleEditGroup(group)
                                }}>
                                {t('device.edit')}
                              </Button>
                              <Button
                                danger
                                size="small"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  handleDeleteGroup(group)
                                }}>
                                {t('device.group.delete')}
                              </Button>
                            </Space>
                          }>
                          {groupDevices.length === 0 ? (
                            <GroupEmptyHint>{t('device.group.no_group_devices')}</GroupEmptyHint>
                          ) : (
                            <DeviceCardList>{groupDevices.map(renderDeviceCard)}</DeviceCardList>
                          )}
                        </Collapse.Panel>
                      )
                    })}
                  </GroupCollapse>
                </GroupSection>
              )}

              {devicesByGroup.ungrouped.length > 0 && (
                <SectionBlock>
                  {groups.length > 0 && (
                    <SectionTitle>{tr('device.group.ungrouped', 'Ungrouped Devices')}</SectionTitle>
                  )}
                  <DeviceCardList>{devicesByGroup.ungrouped.map(renderDeviceCard)}</DeviceCardList>
                </SectionBlock>
              )}
            </>
          )}
        </Spin>
      </ContentArea>

      <LastRefresh>
        {t('device.last_refresh')}: {lastRefresh.toLocaleTimeString()}
      </LastRefresh>

      <Modal
        title={t('device.connection_error_title')}
        open={showScrcpyErrorModal}
        onCancel={() => setShowScrcpyErrorModal(false)}
        footer={[
          <Button key="close" onClick={() => setShowScrcpyErrorModal(false)}>
            {t('common.close')}
          </Button>
        ]}
        centered
        width={520}>
        <Typography.Text type="danger">{scrcpyError}</Typography.Text>
      </Modal>

      <Modal
        title={t('device.device_info.edit_title')}
        open={Boolean(editDraft)}
        onCancel={() => setEditDraft(null)}
        onOk={saveEditDeviceModal}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        centered
        width={520}>
        {editDraft && (
          <EditForm>
            <Field>
              <Label>{t('device.device_info.edit_title')}</Label>
              <Input
                value={editDraft.title}
                onChange={(event) => setEditDraft((prev) => (prev ? { ...prev, title: event.target.value } : prev))}
              />
            </Field>
            <Field>
              <Label>{t('device.device_info.edit_remark')}</Label>
              <Input.TextArea
                rows={3}
                value={editDraft.remark}
                onChange={(event) => setEditDraft((prev) => (prev ? { ...prev, remark: event.target.value } : prev))}
              />
            </Field>
            <Field>
              <Label>{t('device.device_info.select_group')}</Label>
              <Select
                value={editDraft.groupId}
                onChange={(groupId) => setEditDraft((prev) => (prev ? { ...prev, groupId } : prev))}
                options={[
                  { value: NO_GROUP_VALUE, label: t('device.device_info.no_group') },
                  ...groups.map((group) => ({ value: group.id, label: group.name }))
                ]}
              />
            </Field>
          </EditForm>
        )}
      </Modal>

      {showBatchControlPanel && <BatchControlPanel onClose={() => setShowBatchControlPanel(false)} />}

      {showControlPanel && selectedDevice && (
        <DeviceControlPanel
          serial={selectedDevice}
          onClose={() => {
            setShowControlPanel(false)
            setSelectedDevice(null)
          }}
        />
      )}

      {showBatchInstallPanel && <BatchInstallPanel onClose={() => setShowBatchInstallPanel(false)} />}
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;
  overflow: hidden;
`

const Toolbar = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;

  > *:first-child {
    flex: 0 0 100%;
    max-width: 320px;
  }

  .ant-btn {
    border-radius: 8px;
    font-weight: 600;
  }
`

const SearchInput = styled(Input)`
  width: 100%;

  .ant-input-affix-wrapper {
    border-radius: 8px;
    min-height: 38px;
  }
`

const ContentArea = styled.div`
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
`

const GroupSection = styled.div`
  margin-bottom: 14px;
`

const GroupCollapse = styled(Collapse)`
  background: transparent;

  .ant-collapse-item {
    border: 1px solid var(--color-border);
    border-radius: 8px !important;
    background: var(--color-background);
    overflow: hidden;
    margin-bottom: 10px;
  }

  .ant-collapse-item:last-child {
    margin-bottom: 0;
  }

  .ant-collapse-header {
    align-items: center !important;
    min-height: 56px;
    border-bottom: 1px solid var(--color-border-soft);
  }

  .ant-collapse-content {
    border-top: none !important;
  }

  .ant-collapse-content-box {
    padding: 12px 16px !important;
  }
`

const GroupEmptyHint = styled.div`
  color: var(--color-text-secondary);
  font-size: 13px;
`

const SectionBlock = styled.div`
  margin-bottom: 14px;
`

const SectionTitle = styled.h3`
  margin: 0 0 10px;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 600;
`

const DeviceCardList = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;

  .ant-card {
    min-width: 0;
  }

  .ant-card-body {
    padding: 16px;
  }

  .ant-card-actions > li {
    margin: 8px 0;
  }
`

const DeviceCardHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;

  .ant-card-meta {
    min-width: 0;
  }

  .ant-card-meta-title {
    margin-bottom: 0 !important;
    white-space: normal;
    line-height: 1.35;
  }

  .ant-tag {
    flex: 0 0 auto;
    margin-inline-end: 0;
  }
`

const DeviceDetails = styled.div`
  display: grid;
  gap: 12px;
`

const DeviceIdBlock = styled.div`
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--color-border-soft);
  border-radius: 8px;
  background: var(--color-background-soft);

  span {
    color: var(--color-text-secondary);
    font-size: 12px;
  }

  strong {
    color: var(--color-text);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace);
    font-size: 13px;
    font-weight: 600;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
`

const DetailGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;

  @media (max-width: 360px) {
    grid-template-columns: 1fr;
  }
`

const DetailItem = styled.div`
  display: grid;
  min-width: 0;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--color-background-soft);
  font-size: 13px;

  span {
    color: var(--color-text-secondary);
    font-size: 12px;
  }

  strong {
    color: var(--color-text);
    font-weight: 600;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
`

const DetailItemFull = styled(DetailItem)`
  grid-column: 1 / -1;
`

const UnauthorizedHint = styled.div`
  margin-top: 6px;
  color: var(--color-warning);
  font-size: 12px;
`

const EmptyState = styled.div`
  height: 220px;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 12px;
`

const ErrorState = styled.div`
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-error-soft);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`

const LastRefresh = styled.div`
  margin-top: 10px;
  color: var(--color-text-tertiary);
  font-size: 12px;
`

const EditForm = styled.div`
  display: grid;
  gap: 14px;
`

const Field = styled.div`
  display: grid;
  gap: 6px;
`

const Label = styled.label`
  color: var(--color-text-secondary);
  font-size: 13px;
`

export default DevicePage
