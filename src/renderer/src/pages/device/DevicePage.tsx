import { SearchOutlined } from '@ant-design/icons'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import { type DeviceInfo, deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'
import { Button, Card, Collapse, Dropdown, Input, type MenuProps, message, Space, Spin, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import BatchControlPanel from './BatchControlPanel'
import BatchInstallPanel from './BatchInstallPanel'
import DeviceControlPanel from './DeviceControlPanel'

interface DeviceGroup {
  id: string
  name: string
}

const DEVICE_GROUPS_CONFIG_KEY = 'device.groups'

const DevicePage: React.FC = () => {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [scrcpyError, setScrcpyError] = useState<string | null>(null)
  const [showControlPanel, setShowControlPanel] = useState<boolean>(false)
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null)
  const [showBatchInstallPanel, setShowBatchInstallPanel] = useState<boolean>(false)
  const [showBatchControlPanel, setShowBatchControlPanel] = useState<boolean>(false)
  const [searchKeyword, setSearchKeyword] = useState<string>('')
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [deviceInfo, setDeviceInfo] = useState<Record<string, { title: string; remark: string; groupId?: string }>>({})
  const [connectingDevice, setConnectingDevice] = useState<string | null>(null)

  const { t } = useTranslation()

  const renderStatusTag = (status: DeviceInfo['status']) => {
    switch (status) {
      case 'online':
        return <Tag color="green">{t('device.status.online')}</Tag>
      case 'offline':
        return <Tag color="red">{t('device.status.offline')}</Tag>
      default:
        return <Tag color="orange">{t('device.status.unauthorized')}</Tag>
    }
  }

  const getDevicePort = (deviceId: string) => {
    // 从deviceId中提取端口号
    // 对于ADB设备，通常是5555或其他端口号
    const match = deviceId.match(/:(\d+)$/)
    return match?.[1] ?? '--'
  }

  const getDeviceRemark = (device: DeviceInfo) => {
    return device.model || device.brand || '默认设备'
  }

  const fetchDevices = async (showLoading = false) => {
    try {
      if (showLoading) {
        setLoading(true)
      }
      setError(null)

      const newDevices = await deviceServiceProxy.scanDevices()
      setDevices((prev) => {
        const changed = JSON.stringify(prev) !== JSON.stringify(newDevices)
        return changed || showLoading ? newDevices : prev
      })
      setLastRefresh(new Date())
    } catch (err) {
      setError(t('device.error.fetch_failed') || '获取设备列表失败')
      console.error('Failed to fetch devices:', err)
    } finally {
      if (showLoading) {
        setLoading(false)
      }
    }
  }

  const loadGroups = async () => {
    try {
      const stored = await window.api.config.get(DEVICE_GROUPS_CONFIG_KEY)
      if (!Array.isArray(stored)) {
        setGroups([])
        return
      }
      const validGroups = stored
        .filter((item): item is DeviceGroup =>
          Boolean(item && typeof item.id === 'string' && typeof item.name === 'string')
        )
        .map((item) => ({ id: item.id, name: item.name.trim() }))
        .filter((item) => item.name.length > 0)
      setGroups(validGroups)
    } catch (loadError) {
      console.error('Failed to load device groups:', loadError)
      setGroups([])
    }
  }

  const saveGroups = async (nextGroups: DeviceGroup[]) => {
    setGroups(nextGroups)
    await window.api.config.set(DEVICE_GROUPS_CONFIG_KEY, nextGroups)
  }

  useEffect(() => {
    loadGroups()
    loadDeviceInfo()

    const timer = setTimeout(() => {
      fetchDevices(true)
    }, 1000)

    const interval = setInterval(() => {
      fetchDevices(false)
    }, 5000)

    return () => {
      clearTimeout(timer)
      clearInterval(interval)
    }
  }, [])

  const DEVICE_INFO_CONFIG_KEY = 'device.info'

  const loadDeviceInfo = async () => {
    try {
      const stored = await window.api.config.get(DEVICE_INFO_CONFIG_KEY)
      if (stored && typeof stored === 'object') {
        setDeviceInfo(stored)
      }
    } catch (error) {
      console.error('Failed to load device info:', error)
    }
  }

  const saveDeviceInfo = async (info: Record<string, { title: string; remark: string }>) => {
    try {
      setDeviceInfo(info)
      await window.api.config.set(DEVICE_INFO_CONFIG_KEY, info)
    } catch (error) {
      console.error('Failed to save device info:', error)
    }
  }

  const startScreenMirroring = async (serial: string) => {
    try {
      setScrcpyError(null)
      setConnectingDevice(serial)
      const result = await deviceServiceProxy.startScrcpy(serial)
      if (!result.port) {
        setScrcpyError('启动投屏失败')
      }
    } catch (startError: any) {
      const errorMessage = startError.message || String(startError)
      let userMessage = ''
      if (errorMessage.includes('INJECT_EVENTS')) {
        userMessage =
          '设备权限不足：请在设备开发者选项中启用"USB调试(安全设置)"，然后重启设备。如果仍有问题，请尝试重新插拔USB线'
      } else if (errorMessage.includes('permission')) {
        userMessage = '设备权限问题：请检查USB调试权限，可能需要重新授权或更换USB端口'
      } else if (errorMessage.includes('exited')) {
        userMessage = '进程异常退出：scrcpy 启动后立即退出，可能是设备兼容性问题或权限不足'
      } else {
        userMessage = '启动投屏时发生错误：' + errorMessage + '。请尝试在命令行中直接运行scrcpy命令进行对比测试。'
      }
      console.error('Failed to start screen mirroring:', startError)
      setScrcpyError(userMessage)
    } finally {
      setConnectingDevice(null)
    }
  }

  const filteredDevices = useMemo(() => {
    const key = searchKeyword.trim().toLowerCase()
    if (!key) {
      return devices
    }
    return devices.filter((device) =>
      [device.name, device.id, device.model, device.brand].filter(Boolean).join(' ').toLowerCase().includes(key)
    )
  }, [devices, searchKeyword])

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
    if (!trimmedName) {
      return
    }

    if (groups.some((group) => group.name === trimmedName)) {
      message.warning(t('device.group.name_exists'))
      return
    }

    const nextGroups = [...groups, { id: `device-group-${Date.now()}`, name: trimmedName }]
    try {
      await saveGroups(nextGroups)
      message.success(t('device.group.create_success'))
    } catch (saveError) {
      console.error('Failed to save groups:', saveError)
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
    if (!trimmedName || trimmedName === group.name) {
      return
    }

    if (groups.some((item) => item.id !== group.id && item.name === trimmedName)) {
      message.warning(t('device.group.name_exists'))
      return
    }

    const nextGroups = groups.map((item) => (item.id === group.id ? { ...item, name: trimmedName } : item))
    try {
      await saveGroups(nextGroups)
      message.success(t('device.group.update_success'))
    } catch (saveError) {
      console.error('Failed to update groups:', saveError)
      message.error(t('device.group.save_failed'))
    }
  }

  const handleDeleteGroup = async (group: DeviceGroup) => {
    const confirmed = await PromptPopup.show({
      title: t('device.group.delete'),
      message: t('device.group.delete_confirm', { groupName: group.name }),
      defaultValue: ''
    })

    if (confirmed?.trim() !== group.name) {
      return
    }

    const nextGroups = groups.filter((item) => item.id !== group.id)
    try {
      await saveGroups(nextGroups)
      message.success(t('device.group.delete_success'))
    } catch (saveError) {
      console.error('Failed to delete groups:', saveError)
      message.error(t('device.group.delete_failed'))
    }
  }

  const handleEditDeviceInfo = async (device: DeviceInfo) => {
    const title = await PromptPopup.show({
      title: '编辑设备标题',
      message: '请输入设备标题',
      defaultValue: deviceInfo[device.id]?.title || device.name || ''
    })

    if (title === null) {
      return // 用户取消
    }

    const remark = await PromptPopup.show({
      title: '编辑设备备注',
      message: '请输入设备备注',
      defaultValue: deviceInfo[device.id]?.remark || getDeviceRemark(device)
    })

    if (remark === null) {
      return // 用户取消
    }

    // 创建分组选择选项
    const groupOptions = groups.map((group) => ({
      label: group.name,
      value: group.id
    }))

    // 添加"无分组"选项
    groupOptions.unshift({
      label: '无分组',
      value: 'none'
    })

    // 如果没有分组，跳过分组选择
    if (groups.length === 0) {
      const updatedInfo = {
        ...deviceInfo,
        [device.id]: {
          title: title.trim(),
          remark: remark.trim()
        }
      }

      try {
        await saveDeviceInfo(updatedInfo)
        message.success('设备信息已更新')
      } catch (error) {
        console.error('Failed to update device info:', error)
        message.error('设备信息更新失败')
      }
      return
    }

    // 显示分组选择弹窗
    const groupNames = groupOptions.map((opt) => opt.label)
    const currentGroupId = deviceInfo[device.id]?.groupId || 'none'
    const currentGroupIndex = groupOptions.findIndex((opt) => opt.value === currentGroupId)

    const selectedGroupIndex = await PromptPopup.show({
      title: t('device.device_info.select_group'),
      message: t('device.device_info.select_group'),
      defaultValue: currentGroupIndex >= 0 ? groupNames[currentGroupIndex] : groupNames[0],
      inputProps: {
        rows: 1,
        placeholder: t('device.device_info.select_group')
      }
    })

    if (selectedGroupIndex === null) {
      return // 用户取消
    }

    // 查找选择的分组
    const selectedGroupName = selectedGroupIndex.trim()
    const selectedGroup = groupOptions.find((opt) => opt.label === selectedGroupName)
    const groupId = selectedGroup && selectedGroup.value !== 'none' ? selectedGroup.value : undefined

    const updatedInfo = {
      ...deviceInfo,
      [device.id]: {
        title: title.trim(),
        remark: remark.trim(),
        groupId: groupId
      }
    }

    try {
      await saveDeviceInfo(updatedInfo)
      message.success('设备信息已更新')
    } catch (error) {
      console.error('Failed to update device info:', error)
      message.error('设备信息更新失败')
    }
  }

  const renderDeviceCard = (device: DeviceInfo) => {
    const customTitle = deviceInfo[device.id]?.title || device.name || '未命名设备'
    const customRemark = deviceInfo[device.id]?.remark || ''
    const isConnecting = connectingDevice === device.id

    return (
      <Card
        actions={[
          <Button key="connect" type="link" onClick={() => startScreenMirroring(device.id)}>
            {isConnecting ? '连接中...' : '连接'}
          </Button>,
          <Button
            key="command"
            type="link"
            onClick={() => {
              setSelectedDevice(device.id)
              setShowControlPanel(true)
            }}>
            指令
          </Button>,
          <Button key="edit" type="link" onClick={() => handleEditDeviceInfo(device)}>
            编辑
          </Button>
        ]}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <Card.Meta title={customTitle} />
          <div>{renderStatusTag(device.status)}</div>
        </div>
        <Card.Meta
          description={
            <div>
              <p>设备ID: {device.id}</p>
              <p>端口: {getDevicePort(device.id)}</p>
              <p>型号: {device.model || '未知'}</p>
              <p>品牌: {device.brand || '未知'}</p>
              <p>备注: {customRemark}</p>
            </div>
          }
        />
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
      </Toolbar>

      {error && (
        <ErrorState>
          <Typography.Text type="danger">{error}</Typography.Text>
          <Button onClick={() => fetchDevices(true)}>{t('device.refresh')}</Button>
        </ErrorState>
      )}

      <ContentArea>
        <Spin spinning={loading}>
          {groups.length > 0 && (
            <GroupSection>
              <GroupCollapse defaultActiveKey={[groups[0]?.id]} bordered={false}>
                {groups.map((group) => (
                  <Collapse.Panel
                    key={group.id}
                    header={group.name}
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
                    <GroupEmptyHint>{t('device.group.no_group_devices')}</GroupEmptyHint>
                  </Collapse.Panel>
                ))}
              </GroupCollapse>
            </GroupSection>
          )}

          {filteredDevices.length === 0 ? (
            groups.length === 0 ? (
              <EmptyState>
                <Typography.Text type="secondary">{t('device.no_devices')}</Typography.Text>
                <Button type="primary" onClick={() => fetchDevices(true)}>
                  {t('device.refresh')}
                </Button>
              </EmptyState>
            ) : null
          ) : (
            <DeviceCardList>{filteredDevices.map(renderDeviceCard)}</DeviceCardList>
          )}
        </Spin>
      </ContentArea>

      <LastRefresh>
        {t('device.last_refresh')}: {lastRefresh.toLocaleTimeString()}
      </LastRefresh>

      {scrcpyError && <ScrcpyError>{scrcpyError}</ScrcpyError>}

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
    max-width: 280px;
  }

  .ant-btn {
    border-radius: 10px;
    font-weight: 600;
  }
`

const SearchInput = styled(Input)`
  width: 100%;

  .ant-input-affix-wrapper {
    border-radius: 10px;
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
    border-radius: 16px !important;
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

const DeviceCardList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 14px;
`

const EmptyState = styled.div`
  height: 220px;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 12px;
`

const ErrorState = styled.div`
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--color-error-soft);
  display: flex;
  align-items: center;
  justify-content: space-between;
`

const LastRefresh = styled.div`
  margin-top: 10px;
  color: var(--color-text-tertiary);
  font-size: 12px;
`

const ScrcpyError = styled.div`
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  color: var(--color-error);
  background: var(--color-error-soft);
`

export default DevicePage
