import { loggerService } from '@logger'
import type { DeviceInfo } from '@renderer/services/DeviceServiceProxy'
import { deviceServiceProxy } from '@renderer/services/DeviceServiceProxy'
import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import { defaultRpaModuleRegistry } from '@renderer/services/rpa/RpaDefaultRegistry'
import { RpaPlannerService } from '@renderer/services/rpa/RpaPlannerService'
import { RpaTaskValidator } from '@renderer/services/rpa/RpaTaskValidator'
import type { RpaTask, RpaValidationIssue } from '@renderer/services/rpa/RpaTypes'
import type { Assistant } from '@renderer/types'
import { Alert, Button, Checkbox, Input, message, Modal, Space, Typography } from 'antd'
import { Bot, Play, Save, Send, UserRound } from 'lucide-react'
import type { FC, KeyboardEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import RpaExecutionProgressModal from './RpaExecutionProgressModal'
import RpaTimelineEditor from './RpaTimelineEditor'

const logger = loggerService.withContext('RpaChatWorkspace')
const DRAFT_KEY = 'rpa.chat.workspace.draft'

interface Props {
  assistant: Assistant
}

interface WorkspaceMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

interface StoredDraft {
  task: RpaTask
  updatedAt: number
}

const planner = new RpaPlannerService({ registry: defaultRpaModuleRegistry })
const validator = new RpaTaskValidator(defaultRpaModuleRegistry)

const RpaChatWorkspace: FC<Props> = ({ assistant }) => {
  const { t } = useTranslation()
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [planning, setPlanning] = useState(false)
  const [messages, setMessages] = useState<WorkspaceMessage[]>([])
  const [task, setTask] = useState<RpaTask>()
  const [issues, setIssues] = useState<RpaValidationIssue[]>([])
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string>()
  const [executionRunId, setExecutionRunId] = useState<string>()
  const [executionOpen, setExecutionOpen] = useState(false)

  const onlineDevices = useMemo(() => devices.filter((device) => device.status === 'online'), [devices])

  useEffect(() => {
    void deviceServiceProxy
      .scanDevices()
      .then((result) => {
        setDevices(result)
        setSelectedDeviceIds((current) =>
          current.length ? current : result.filter((device) => device.status === 'online').map((device) => device.id)
        )
      })
      .catch((error) => logger.error('Failed to scan devices for RPA workspace', { error }))

    try {
      const stored = localStorage.getItem(DRAFT_KEY)
      if (stored) {
        const draft = JSON.parse(stored) as StoredDraft
        const validation = validator.validate(draft.task)
        if (validation.success && validation.task) {
          setTask(validation.task)
          setJsonText(JSON.stringify(validation.task, null, 2))
          setSelectedDeviceIds(validation.task.deviceIds)
        }
      }
    } catch (error) {
      logger.warn('Failed to restore RPA workspace draft', { error })
    }
  }, [])

  const updateTask = (nextTask: RpaTask) => {
    const withSharedModel = { ...nextTask, deviceIds: selectedDeviceIds, visionModel: assistant.model }
    setTask(withSharedModel)
    setJsonText(JSON.stringify(withSharedModel, null, 2))
    setIssues(validator.validate(withSharedModel).issues)
  }

  const generatePlan = async () => {
    const goal = input.trim()
    if (!goal || planning) return
    if (!assistant.model) {
      message.warning(t('device.rpa.model_required', { defaultValue: 'Select a chat model before planning.' }))
      return
    }
    if (selectedDeviceIds.length === 0) {
      message.warning(t('device.rpa.select_device', { defaultValue: 'Select at least one online device.' }))
      return
    }

    const userMessage: WorkspaceMessage = { id: `user-${Date.now()}`, role: 'user', text: goal }
    setMessages((current) => [...current, userMessage])
    setInput('')
    setPlanning(true)
    try {
      const result = await planner.plan({
        goal,
        deviceIds: selectedDeviceIds,
        taskId: `rpa-task-${Date.now()}`,
        taskName: goal.slice(0, 48),
        model: assistant.model
      })
      if (!result.success || !result.task) {
        setIssues(result.issues)
        throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ') || 'Plan invalid')
      }

      const plannedTask: RpaTask = {
        ...result.task,
        deviceIds: selectedDeviceIds,
        visionModel: assistant.model
      }
      setTask(plannedTask)
      setJsonText(JSON.stringify(plannedTask, null, 2))
      setIssues([])
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          text: t('device.rpa.plan_generated', {
            defaultValue: 'The RPA workflow has been generated. Review and edit the timeline before running it.'
          })
        }
      ])
    } catch (error) {
      logger.error('Failed to generate RPA workflow', { error })
      const errorText = error instanceof Error ? error.message : String(error)
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: 'assistant', text: errorText }])
      message.error(errorText)
    } finally {
      setPlanning(false)
    }
  }

  const saveDraft = () => {
    if (!task) return
    const nextTask = { ...task, deviceIds: selectedDeviceIds, visionModel: assistant.model }
    const validation = validator.validate(nextTask)
    setIssues(validation.issues)
    if (!validation.success || !validation.task) {
      message.error(t('device.rpa.fix_validation_errors', { defaultValue: 'Fix validation errors before saving.' }))
      return
    }
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ task: validation.task, updatedAt: Date.now() } satisfies StoredDraft)
    )
    setTask(validation.task)
    message.success(t('device.rpa.draft_saved', { defaultValue: 'RPA workflow draft saved.' }))
  }

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText) as RpaTask
      const validation = validator.validate({ ...parsed, deviceIds: selectedDeviceIds, visionModel: assistant.model })
      setIssues(validation.issues)
      if (!validation.success || !validation.task) throw new Error('DSL validation failed')
      setJsonError(undefined)
      setTask(validation.task)
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error))
    }
  }

  const confirmExecution = () => {
    if (!task) return
    const executionTask = { ...task, deviceIds: selectedDeviceIds, visionModel: assistant.model }
    const validation = validator.validate(executionTask)
    setIssues(validation.issues)
    if (!validation.success || !validation.task) {
      message.error(t('device.rpa.fix_validation_errors', { defaultValue: 'Fix validation errors before execution.' }))
      return
    }
    const validatedTask = validation.task

    Modal.confirm({
      title: t('device.rpa.confirm_execution', { defaultValue: 'Confirm RPA execution' }),
      content: t('device.rpa.confirm_execution_detail', {
        defaultValue: 'This workflow will execute {{steps}} steps on {{devices}} device(s).',
        steps: validatedTask.steps.length,
        devices: selectedDeviceIds.length
      }),
      okText: t('device.rpa.execute', { defaultValue: 'Execute' }),
      cancelText: t('common.cancel'),
      onOk: async () => {
        const run = await rpaBatchRunner.start({ task: validatedTask, deviceIds: selectedDeviceIds })
        setExecutionRunId(run.id)
        setExecutionOpen(true)
      }
    })
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void generatePlan()
    }
  }

  return (
    <Workspace>
      <Conversation>
        <Intro>
          <Bot size={24} />
          <div>
            <strong>{t('device.rpa.workspace_title', { defaultValue: 'RPA workflow planner' })}</strong>
            <Typography.Text type="secondary">
              {t('device.rpa.workspace_hint', {
                defaultValue:
                  'Describe the mobile task in the chat box. The current chat model will generate an editable workflow.'
              })}
            </Typography.Text>
          </div>
        </Intro>

        <DeviceSelector>
          <Typography.Text strong>{t('device.rpa.devices', { defaultValue: 'Target devices' })}</Typography.Text>
          <Checkbox.Group value={selectedDeviceIds} onChange={(values) => setSelectedDeviceIds(values.map(String))}>
            <Space wrap>
              {onlineDevices.map((device) => (
                <Checkbox key={device.id} value={device.id}>
                  {device.name || device.model || device.id}
                </Checkbox>
              ))}
            </Space>
          </Checkbox.Group>
          {onlineDevices.length === 0 && (
            <Alert
              type="warning"
              showIcon
              message={t('device.rpa.no_online_devices', { defaultValue: 'No online devices.' })}
            />
          )}
        </DeviceSelector>

        {messages.map((item) => (
          <MessageRow key={item.id} $role={item.role}>
            <MessageAvatar $role={item.role}>
              {item.role === 'user' ? <UserRound size={18} /> : <Bot size={18} />}
            </MessageAvatar>
            <MessageBody>
              <strong>
                {item.role === 'user'
                  ? t('common.you', { defaultValue: 'You' })
                  : assistant.model?.name || assistant.name}
              </strong>
              <div>{item.text}</div>
            </MessageBody>
          </MessageRow>
        ))}

        {task && (
          <WorkflowSection>
            <WorkflowHeader>
              <div>
                <Typography.Title level={4}>{task.name}</Typography.Title>
                <Typography.Text type="secondary">{task.goal}</Typography.Text>
              </div>
              <Space>
                <Button icon={<Save size={16} />} onClick={saveDraft}>
                  {t('common.save')}
                </Button>
                <Button type="primary" icon={<Play size={16} />} onClick={confirmExecution}>
                  {t('device.rpa.confirm_and_execute', { defaultValue: 'Confirm and execute' })}
                </Button>
              </Space>
            </WorkflowHeader>
            <RpaTimelineEditor task={task} issues={issues} onChange={updateTask} />
            <AdvancedDetails>
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
          </WorkflowSection>
        )}
      </Conversation>

      <Composer>
        <Input.TextArea
          autoSize={{ minRows: 2, maxRows: 6 }}
          value={input}
          placeholder={t('device.rpa.chat_placeholder', {
            defaultValue: 'Describe the task to perform on the selected devices. Press Enter to generate the workflow.'
          })}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleInputKeyDown}
        />
        <Button
          type="primary"
          shape="circle"
          icon={<Send size={17} />}
          loading={planning}
          disabled={!input.trim() || selectedDeviceIds.length === 0}
          onClick={() => void generatePlan()}
        />
      </Composer>

      <RpaExecutionProgressModal runId={executionRunId} open={executionOpen} onClose={() => setExecutionOpen(false)} />
    </Workspace>
  )
}

const Workspace = styled.div`
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  background: var(--color-background);
`

const Conversation = styled.div`
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px clamp(20px, 5vw, 64px) 24px;
`

const Intro = styled.div`
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 18px;

  > div {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
`

const DeviceSelector = styled.div`
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 0 16px;
  border-bottom: 1px solid var(--color-border);
`

const MessageRow = styled.div<{ $role: 'user' | 'assistant' }>`
  display: flex;
  gap: 12px;
  margin: 22px 0;
  padding-left: ${({ $role }) => ($role === 'user' ? '8%' : '0')};
`

const MessageAvatar = styled.div<{ $role: 'user' | 'assistant' }>`
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  color: white;
  background: ${({ $role }) => ($role === 'user' ? '#16a66a' : '#e47d55')};
`

const MessageBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 7px;
  line-height: 1.65;
`

const WorkflowSection = styled.section`
  border-top: 1px solid var(--color-border);
  padding-top: 18px;
`

const WorkflowHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 18px;

  .ant-typography {
    margin: 0;
  }
`

const AdvancedDetails = styled.details`
  margin-top: 12px;

  summary {
    cursor: pointer;
    margin-bottom: 10px;
    color: var(--color-text-2);
  }
`

const Composer = styled.div`
  margin: 0 clamp(18px, 4vw, 52px) 18px;
  padding: 12px;
  display: grid;
  grid-template-columns: 1fr 40px;
  gap: 10px;
  align-items: end;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-soft);
`

export default RpaChatWorkspace
