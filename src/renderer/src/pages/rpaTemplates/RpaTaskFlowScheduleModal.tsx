import { loggerService } from '@logger'
import { deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'
import { rpaAppRoleRepository } from '@renderer/services/rpa/RpaAppRole'
import { rpaTaskFlowScheduleRepository } from '@renderer/services/rpa/RpaTaskFlowScheduleRepository'
import type { RpaTemplateRecord } from '@renderer/services/rpa/RpaTemplateRepository'
import type { RpaTaskFlowSchedule } from '@shared/types/RpaTaskFlowSchedule'
import { Alert, DatePicker, Form, Input, InputNumber, message, Modal, Select, Space, Switch, Typography } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import type { FC } from 'react'
import { useEffect, useState } from 'react'

import { DEVICE_GROUPS_CONFIG_KEY, type DeviceGroup, sanitizeDeviceGroups } from '../device/deviceMetadata'

const logger = loggerService.withContext('RpaTaskFlowScheduleModal')

interface Props {
  open: boolean
  taskFlow: RpaTemplateRecord
  onClose: () => void
  onSaved: () => void
}

interface FormValues {
  enabled: boolean
  roleId: string
  kind: RpaTaskFlowSchedule['kind']
  timezone: string
  runAt?: Dayjs
  intervalMinutes?: number
  cronExpression?: string
  targetMode: RpaTaskFlowSchedule['target']['mode']
  deviceIds: string[]
  groupIds: string[]
  overlapPolicy: RpaTaskFlowSchedule['overlapPolicy']
  missedRunPolicy: RpaTaskFlowSchedule['missedRunPolicy']
}

const RpaTaskFlowScheduleModal: FC<Props> = ({ open, taskFlow, onClose, onSaved }) => {
  const [form] = Form.useForm<FormValues>()
  const kind = Form.useWatch('kind', form)
  const targetMode = Form.useWatch('targetMode', form)
  const [schedule, setSchedule] = useState<RpaTaskFlowSchedule>()
  const [roles, setRoles] = useState<Array<{ value: string; label: string; version: number }>>([])
  const [devices, setDevices] = useState<Array<{ value: string; label: string }>>([])
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    void Promise.all([
      rpaTaskFlowScheduleRepository.getByTaskFlowId(taskFlow.id),
      rpaAppRoleRepository.getAll(),
      deviceServiceProxy.scanDevices(),
      window.api.config.get(DEVICE_GROUPS_CONFIG_KEY)
    ])
      .then(([existing, allRoles, allDevices, storedGroups]) => {
        const enabledRoles = allRoles.filter((role) => role.status === 'enabled')
        setSchedule(existing)
        setRoles(
          enabledRoles.map((role) => ({
            value: role.id,
            label: `${role.name} · v${role.version}`,
            version: role.version
          }))
        )
        setDevices(allDevices.map((device) => ({ value: device.id, label: `${device.name} · ${device.id}` })))
        setGroups(sanitizeDeviceGroups(storedGroups))
        form.setFieldsValue({
          enabled: existing?.enabled ?? false,
          roleId: existing?.role.id ?? taskFlow.role?.id ?? enabledRoles[0]?.id,
          kind: existing?.kind ?? 'one_time',
          timezone: existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Shanghai',
          runAt: existing?.runAt ? dayjs(existing.runAt) : dayjs().add(5, 'minute'),
          intervalMinutes: existing?.intervalMs ? Math.round(existing.intervalMs / 60_000) : 60,
          cronExpression: existing?.cronExpression ?? '0 9 * * *',
          targetMode: existing?.target.mode ?? 'manual',
          deviceIds: existing?.target.deviceIds ?? [],
          groupIds: existing?.target.groupIds ?? [],
          overlapPolicy: existing?.overlapPolicy ?? 'skip',
          missedRunPolicy: existing?.missedRunPolicy ?? 'skip'
        })
      })
      .catch((error) => {
        logger.error('Failed to load RPA task flow schedule editor', { error, taskFlowId: taskFlow.id })
        message.error('加载定时配置失败')
      })
      .finally(() => setLoading(false))
  }, [form, open, taskFlow.id, taskFlow.role?.id])

  const save = async () => {
    try {
      const values = await form.validateFields()
      const role = roles.find((item) => item.value === values.roleId)
      if (!role) throw new Error('请选择可用的 RPA Role')
      const now = Date.now()
      await rpaTaskFlowScheduleRepository.save({
        schemaVersion: 1,
        id: schedule?.id ?? `rpa-schedule-${now}-${Math.random().toString(36).slice(2, 8)}`,
        taskFlowId: taskFlow.id,
        role: { id: role.value, version: role.version },
        kind: values.kind,
        enabled: values.enabled,
        timezone: values.timezone,
        runAt: values.kind === 'one_time' || values.kind === 'interval' ? values.runAt?.valueOf() : undefined,
        intervalMs: values.kind === 'interval' ? Math.max(1, values.intervalMinutes ?? 1) * 60_000 : undefined,
        cronExpression: values.kind === 'cron' ? values.cronExpression?.trim() : undefined,
        target: { mode: values.targetMode, deviceIds: values.deviceIds ?? [], groupIds: values.groupIds ?? [] },
        overlapPolicy: values.overlapPolicy,
        missedRunPolicy: values.missedRunPolicy,
        nextRunAt: schedule?.nextRunAt,
        activeTriggerId: schedule?.activeTriggerId,
        triggerHistory: schedule?.triggerHistory ?? [],
        createdAt: schedule?.createdAt ?? now,
        updatedAt: now
      })
      message.success('任务流定时配置已保存')
      onSaved()
      onClose()
    } catch (error) {
      if (error instanceof Error) message.error(error.message)
      logger.warn('Failed to save RPA task flow schedule', { error, taskFlowId: taskFlow.id })
    }
  }

  return (
    <Modal
      title={`定时触发 · ${taskFlow.name}`}
      open={open}
      width={640}
      confirmLoading={loading}
      onOk={() => void save()}
      onCancel={onClose}>
      <Form form={form} layout="vertical" disabled={loading}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert type="info" showIcon message="任务流选择 Role，Role 不绑定任务流" />
          <Form.Item name="enabled" label="启用定时" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="roleId" label="执行 Role" rules={[{ required: true }]}>
            <Select options={roles} />
          </Form.Item>
          <Form.Item name="kind" label="触发方式" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'one_time', label: '单次' },
                { value: 'interval', label: '固定间隔' },
                { value: 'cron', label: 'Cron' }
              ]}
            />
          </Form.Item>
          {kind === 'one_time' && (
            <Form.Item name="runAt" label="执行时间" rules={[{ required: true }]}>
              <DatePicker showTime style={{ width: '100%' }} />
            </Form.Item>
          )}
          {kind === 'interval' && (
            <Space align="start" style={{ width: '100%' }}>
              <Form.Item name="runAt" label="首次执行">
                <DatePicker showTime />
              </Form.Item>
              <Form.Item name="intervalMinutes" label="间隔（分钟）" rules={[{ required: true }]}>
                <InputNumber min={1} />
              </Form.Item>
            </Space>
          )}
          {kind === 'cron' && (
            <Form.Item name="cronExpression" label="Cron 表达式" rules={[{ required: true }]}>
              <Input placeholder="0 9 * * *" />
            </Form.Item>
          )}
          <Form.Item name="timezone" label="时区" rules={[{ required: true }]}>
            <Input placeholder="Asia/Shanghai" />
          </Form.Item>
          <Form.Item name="targetMode" label="设备范围">
            <Select
              options={[
                { value: 'manual', label: '指定设备' },
                { value: 'groups', label: '设备分组' },
                { value: 'all_online', label: '全部在线设备' }
              ]}
            />
          </Form.Item>
          {targetMode === 'manual' && (
            <Form.Item name="deviceIds" label="设备">
              <Select mode="multiple" options={devices} />
            </Form.Item>
          )}
          {targetMode === 'groups' && (
            <Form.Item name="groupIds" label="设备分组">
              <Select mode="multiple" options={groups.map((group) => ({ value: group.id, label: group.name }))} />
            </Form.Item>
          )}
          <Form.Item name="overlapPolicy" label="并发策略">
            <Select
              options={[
                { value: 'skip', label: '跳过本次' },
                { value: 'queue', label: '排队' },
                { value: 'forbid_overlap', label: '禁止重叠' }
              ]}
            />
          </Form.Item>
          <Form.Item name="missedRunPolicy" label="错过执行">
            <Select
              options={[
                { value: 'skip', label: '跳过' },
                { value: 'run_once', label: '恢复后补执行一次' }
              ]}
            />
          </Form.Item>
          {schedule?.nextRunAt && (
            <Typography.Text type="secondary">
              下次执行：{new Date(schedule.nextRunAt).toLocaleString()}
            </Typography.Text>
          )}
        </Space>
      </Form>
    </Modal>
  )
}

export default RpaTaskFlowScheduleModal
