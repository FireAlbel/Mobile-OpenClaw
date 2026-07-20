import { loggerService } from '@logger'
import type { DeviceInfo } from '@renderer/services/DeviceServiceProxy'
import { deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'
import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import { defaultRpaModuleRegistry } from '@renderer/services/rpa/RpaDefaultRegistry'
import { rpaSafetyPolicyEngine } from '@renderer/services/rpa/RpaSafetyPolicyEngine'
import { RpaTaskValidator } from '@renderer/services/rpa/RpaTaskValidator'
import type { RpaTask, RpaValidationIssue } from '@renderer/services/rpa/RpaTypes'
import { useAppDispatch } from '@renderer/store'
import { updateOneBlock } from '@renderer/store/messageBlock'
import { updateMessageAndBlocksThunk } from '@renderer/store/thunk/messageThunk'
import type { MainTextMessageBlock, Message } from '@renderer/types/newMessage'
import { Alert, Button, Checkbox, Input, message as antMessage, Modal, Space, Typography } from 'antd'
import { Play, Save } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import RpaExecutionProgressModal from './RpaExecutionProgressModal'
import RpaRunHistory from './RpaRunHistory'
import RpaTimelineEditor from './RpaTimelineEditor'

const logger = loggerService.withContext('RpaInlineWorkflow')
const draftValidator = new RpaTaskValidator(defaultRpaModuleRegistry, { requireDeviceIds: false })
const executionValidator = new RpaTaskValidator(defaultRpaModuleRegistry)

interface Props {
  block: MainTextMessageBlock
  message: Message
}

const RpaInlineWorkflow: FC<Props> = ({ block, message }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const storedTask = block.metadata?.rpaTask as RpaTask
  const [task, setTask] = useState<RpaTask>(storedTask)
  const [issues, setIssues] = useState<RpaValidationIssue[]>([])
  const [jsonText, setJsonText] = useState(() => JSON.stringify(storedTask, null, 2))
  const [jsonError, setJsonError] = useState<string>()
  const [executionRunId, setExecutionRunId] = useState<string>()
  const [executionOpen, setExecutionOpen] = useState(false)
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [scanning, setScanning] = useState(false)
  const onlineDevices = useMemo(() => devices.filter((device) => device.status === 'online'), [devices])

  const scanDevices = useCallback(async () => {
    setScanning(true)
    try {
      const result = await deviceServiceProxy.scanDevices()
      setDevices(result)
      return result
    } catch (error) {
      logger.error('Failed to scan devices for inline RPA workflow', {
        error,
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      return []
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    setTask(storedTask)
    setJsonText(JSON.stringify(storedTask, null, 2))
  }, [storedTask])

  useEffect(() => {
    void scanDevices()
  }, [scanDevices])

  const updateTask = (nextTask: RpaTask) => {
    setTask(nextTask)
    setJsonText(JSON.stringify(nextTask, null, 2))
    setIssues(draftValidator.validate(nextTask).issues)
  }

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText) as RpaTask
      const validation = draftValidator.validate(parsed)
      setIssues(validation.issues)
      if (!validation.success || !validation.task) throw new Error('DSL validation failed')
      setJsonError(undefined)
      setTask(validation.task)
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error))
    }
  }

  const saveTask = async () => {
    const validation = draftValidator.validate(task)
    setIssues(validation.issues)
    if (!validation.success || !validation.task) {
      antMessage.error(t('device.rpa.fix_validation_errors', { defaultValue: 'Fix validation errors before saving.' }))
      return
    }

    const updatedBlock: MainTextMessageBlock = {
      ...block,
      metadata: { ...block.metadata, rpaTask: validation.task },
      updatedAt: new Date().toISOString()
    }

    try {
      dispatch(updateOneBlock({ id: block.id, changes: updatedBlock }))
      await dispatch(updateMessageAndBlocksThunk(message.topicId, null, [updatedBlock]))
      setTask(validation.task)
      setJsonText(JSON.stringify(validation.task, null, 2))
      antMessage.success(t('device.rpa.draft_saved', { defaultValue: 'RPA workflow draft saved.' }))
    } catch (error) {
      logger.error('Failed to save inline RPA workflow', { error, blockId: block.id })
      antMessage.error(t('device.rpa.save_failed', { defaultValue: 'Failed to save the RPA workflow.' }))
    }
  }

  const confirmExecution = async () => {
    const latestDevices = await scanDevices()
    const onlineDeviceIds = new Set(
      latestDevices.filter((device) => device.status === 'online').map((device) => device.id)
    )
    const selectedOnlineDeviceIds = task.deviceIds.filter((deviceId) => onlineDeviceIds.has(deviceId))
    if (selectedOnlineDeviceIds.length === 0) {
      antMessage.error(t('device.rpa.select_device', { defaultValue: 'Select at least one online device.' }))
      return
    }

    const executionTask = { ...task, deviceIds: selectedOnlineDeviceIds }
    const validation = executionValidator.validate(executionTask)
    setIssues(validation.issues)
    if (!validation.success || !validation.task) {
      antMessage.error(
        t('device.rpa.fix_validation_errors', { defaultValue: 'Fix validation errors before execution.' })
      )
      return
    }
    const validatedTask = validation.task
    const riskSummary = rpaSafetyPolicyEngine.analyzeTask(validatedTask, defaultRpaModuleRegistry.listMetadata())
    const requiresHighRiskConfirmation = riskSummary.highRiskTargets.length > 0

    Modal.confirm({
      title: requiresHighRiskConfirmation
        ? t('device.rpa.confirm_high_risk_execution', { defaultValue: 'Confirm high-risk RPA execution' })
        : t('device.rpa.confirm_execution', { defaultValue: 'Confirm RPA execution' }),
      content: (
        <Space direction="vertical" size={10}>
          <Typography.Text>
            {t('device.rpa.confirm_execution_detail', {
              defaultValue: 'This workflow will execute {{steps}} steps on {{devices}} device(s).',
              steps: validatedTask.steps.length,
              devices: validatedTask.deviceIds.length
            })}
          </Typography.Text>
          <Alert
            type={requiresHighRiskConfirmation ? 'warning' : 'info'}
            showIcon
            message={t('device.rpa.risk_summary', {
              defaultValue: 'Risk level: {{risk}}',
              risk: riskSummary.highestRisk
            })}
            description={
              requiresHighRiskConfirmation
                ? t('device.rpa.high_risk_targets', {
                    defaultValue: 'Requires explicit confirmation: {{targets}}',
                    targets: riskSummary.highRiskTargets.join(', ')
                  })
                : undefined
            }
          />
        </Space>
      ),
      okText: t('device.rpa.execute', { defaultValue: 'Execute' }),
      okButtonProps: { danger: requiresHighRiskConfirmation },
      cancelText: t('common.cancel'),
      onOk: async () => {
        const safetyApproval = requiresHighRiskConfirmation
          ? rpaSafetyPolicyEngine.createApproval(validatedTask, riskSummary.highRiskTargets)
          : undefined
        const run = await rpaBatchRunner.start({
          task: validatedTask,
          deviceIds: validatedTask.deviceIds,
          safetyApproval
        })
        setExecutionRunId(run.id)
        setExecutionOpen(true)
      }
    })
  }

  return (
    <Workflow>
      <Header>
        <div>
          <Typography.Title level={4}>{task.name}</Typography.Title>
          <Typography.Text type="secondary">{task.goal}</Typography.Text>
        </div>
        <Space wrap>
          <Button icon={<Save size={16} />} onClick={() => void saveTask()}>
            {t('common.save')}
          </Button>
          <Button type="primary" icon={<Play size={16} />} onClick={() => void confirmExecution()}>
            {t('device.rpa.confirm_and_execute', { defaultValue: 'Confirm and execute' })}
          </Button>
        </Space>
      </Header>

      <DeviceSelector>
        <DeviceSelectorHeader>
          <Typography.Text strong>{t('device.rpa.devices', { defaultValue: 'Target devices' })}</Typography.Text>
          <Button size="small" loading={scanning} onClick={() => void scanDevices()}>
            {t('device.refresh')}
          </Button>
        </DeviceSelectorHeader>
        {onlineDevices.length > 0 ? (
          <Checkbox.Group
            value={task.deviceIds}
            onChange={(values) => updateTask({ ...task, deviceIds: values.map(String) })}>
            <Space wrap>
              {onlineDevices.map((device) => (
                <Checkbox key={device.id} value={device.id}>
                  {device.name || device.model || device.id}
                </Checkbox>
              ))}
            </Space>
          </Checkbox.Group>
        ) : (
          <Alert
            type="warning"
            showIcon
            message={t('device.rpa.no_online_devices', { defaultValue: 'No online devices.' })}
          />
        )}
      </DeviceSelector>

      <RpaTimelineEditor task={task} issues={issues} onChange={updateTask} />

      <AdvancedDetails open>
        <summary>{t('device.rpa.advanced_dsl', { defaultValue: 'Advanced DSL editor' })}</summary>
        <Input.TextArea
          rows={14}
          value={jsonText}
          status={jsonError ? 'error' : undefined}
          onChange={(event) => setJsonText(event.target.value)}
          onBlur={applyJson}
        />
        {jsonError && <Typography.Text type="danger">{jsonError}</Typography.Text>}
      </AdvancedDetails>

      <RpaRunHistory onUseTemplate={updateTask} />

      <RpaExecutionProgressModal runId={executionRunId} open={executionOpen} onClose={() => setExecutionOpen(false)} />
    </Workflow>
  )
}

const Workflow = styled.section`
  width: 100%;
  margin-top: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--color-border);
`

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;

  .ant-typography {
    margin: 0;
  }
`

const DeviceSelector = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
`

const DeviceSelectorHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`

const AdvancedDetails = styled.details`
  margin-top: 12px;

  summary {
    cursor: pointer;
    margin-bottom: 10px;
    color: var(--color-text-2);
  }
`

export default RpaInlineWorkflow
