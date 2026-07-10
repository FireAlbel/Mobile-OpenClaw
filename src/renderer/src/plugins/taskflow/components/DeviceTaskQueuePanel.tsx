import { PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons'
import { type DeviceInfo, deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'
import {
  type DeviceTask,
  type DeviceTaskLog,
  deviceTaskOrchestrator,
  type DeviceTaskStatus
} from '@renderer/services/DeviceTaskOrchestrator'
import { Button, Card, Form, Input, message, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const statusColor: Record<DeviceTaskStatus, string> = {
  pending: 'default',
  running: 'processing',
  paused: 'warning',
  waiting_device: 'orange',
  cancelled: 'default',
  failed: 'error',
  completed: 'success'
}

const DeviceTaskQueuePanel = () => {
  const { t } = useTranslation()
  const [tasks, setTasks] = useState<DeviceTask[]>([])
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [loadingDevices, setLoadingDevices] = useState(false)
  const [form] = Form.useForm()

  const refreshTasks = () => {
    setTasks(deviceTaskOrchestrator.getTasks())
  }

  const refreshDevices = async () => {
    setLoadingDevices(true)
    try {
      const list = await deviceServiceProxy.scanDevices()
      setDevices(list.filter((device) => device.status === 'online'))
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingDevices(false)
    }
  }

  useEffect(() => {
    refreshTasks()
    void refreshDevices()
    return deviceTaskOrchestrator.subscribe(refreshTasks)
  }, [])

  const selectedLogs: DeviceTaskLog[] = selectedTaskId ? deviceTaskOrchestrator.getLogs(selectedTaskId) : []

  const enqueueTask = async (values: { deviceId: string; goal: string; useDeerFlow?: boolean }) => {
    try {
      const task = deviceTaskOrchestrator.enqueue({
        deviceId: values.deviceId,
        goal: values.goal,
        useDeerFlow: values.useDeerFlow
      })
      setSelectedTaskId(task.id)
      form.resetFields(['goal'])
      refreshTasks()
      message.success(t('taskflow.deviceQueue.enqueueSuccess'))
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const columns = [
    {
      title: t('taskflow.deviceQueue.columns.device'),
      dataIndex: 'deviceId',
      key: 'deviceId',
      width: 180
    },
    {
      title: t('taskflow.deviceQueue.columns.goal'),
      dataIndex: 'goal',
      key: 'goal',
      ellipsis: true
    },
    {
      title: t('taskflow.deviceQueue.columns.status'),
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: DeviceTaskStatus) => <Tag color={statusColor[status]}>{status}</Tag>
    },
    {
      title: t('taskflow.deviceQueue.columns.progress'),
      key: 'progress',
      width: 120,
      render: (_: unknown, task: DeviceTask) => `${task.currentStepIndex}/${task.steps.length}`
    },
    {
      title: t('taskflow.deviceQueue.columns.updated'),
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 180,
      render: (time: number) => new Date(time).toLocaleString()
    },
    {
      title: t('taskflow.deviceQueue.columns.actions'),
      key: 'actions',
      width: 230,
      render: (_: unknown, task: DeviceTask) => (
        <Space>
          <Button size="small" icon={<PauseCircleOutlined />} onClick={() => deviceTaskOrchestrator.pause(task.id)}>
            {t('taskflow.deviceQueue.actions.pause')}
          </Button>
          <Button size="small" icon={<PlayCircleOutlined />} onClick={() => deviceTaskOrchestrator.resume(task.id)}>
            {t('taskflow.deviceQueue.actions.resume')}
          </Button>
          <Button danger size="small" icon={<StopOutlined />} onClick={() => deviceTaskOrchestrator.cancel(task.id)}>
            {t('taskflow.deviceQueue.actions.cancel')}
          </Button>
        </Space>
      )
    }
  ]

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title={t('taskflow.deviceQueue.title')}>
        <Form form={form} layout="inline" onFinish={enqueueTask}>
          <Form.Item name="deviceId" rules={[{ required: true, message: t('taskflow.deviceQueue.validation.device') }]}>
            <Select
              style={{ width: 260 }}
              placeholder={t('taskflow.deviceQueue.onlineDevice')}
              loading={loadingDevices}
              options={devices.map((device) => ({
                value: device.id,
                label: `${device.name || device.id} (${device.id})`
              }))}
            />
          </Form.Item>
          <Form.Item
            name="goal"
            rules={[{ required: true, message: t('taskflow.deviceQueue.validation.goal') }]}
            style={{ flex: 1 }}>
            <Input placeholder={t('taskflow.deviceQueue.goalPlaceholder')} />
          </Form.Item>
          <Form.Item name="useDeerFlow">
            <Select
              style={{ width: 150 }}
              defaultValue={false}
              options={[
                { value: false, label: t('taskflow.deviceQueue.localVlm') },
                { value: true, label: t('taskflow.deviceQueue.tryDeerFlow') }
              ]}
            />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button icon={<ReloadOutlined />} onClick={refreshDevices}>
                {t('taskflow.deviceQueue.refresh')}
              </Button>
              <Button type="primary" htmlType="submit">
                {t('taskflow.deviceQueue.enqueue')}
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>

      <Table
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={tasks}
        onRow={(task) => ({
          onClick: () => setSelectedTaskId(task.id)
        })}
        pagination={{ pageSize: 8 }}
      />

      <Card size="small" title={t('taskflow.deviceQueue.selectedLogs')}>
        {selectedLogs.length === 0 ? (
          <Typography.Text type="secondary">{t('taskflow.deviceQueue.selectTaskLogs')}</Typography.Text>
        ) : (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {selectedLogs.slice(-80).map((log) => (
              <Typography.Text key={log.id} type={log.level === 'error' ? 'danger' : undefined}>
                [{new Date(log.timestamp).toLocaleTimeString()}] [{log.level}] {log.message}
              </Typography.Text>
            ))}
          </Space>
        )}
      </Card>
    </Space>
  )
}

export default DeviceTaskQueuePanel
