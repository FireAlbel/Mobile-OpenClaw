import { loggerService } from '@logger'
import ModelAvatar from '@renderer/components/Avatar/ModelAvatar'
import { SelectModelPopup } from '@renderer/components/Popups/SelectModelPopup'
import { isVisionModel } from '@renderer/config/models'
import { getDefaultModel } from '@renderer/services/AssistantService'
import type { DeviceInfo } from '@renderer/services/DeviceServiceProxy'
import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import type { RpaBatchRunRecord } from '@renderer/services/rpa/RpaRunStorage'
import type { RpaTask } from '@renderer/services/rpa/RpaTypes'
import type { Model } from '@renderer/types'
import { Button, Checkbox, Input, message, Modal, Space, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('RpaTaskRunnerPanel')

const TERMINAL_DEVICE_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const RPA_VISION_MODEL_STORAGE_KEY = 'rpa_vision_model'

interface RpaTaskRunnerPanelProps {
  devices: DeviceInfo[]
  onClose: () => void
}

function buildSampleTask(deviceIds: string[]): RpaTask {
  return {
    id: `rpa-task-${Date.now()}`,
    name: 'Screenshot task',
    goal: 'Capture screenshots on selected devices',
    deviceIds,
    metadata: {},
    steps: [
      {
        id: 'screenshot',
        name: 'Capture screenshot',
        moduleId: 'screenshot',
        params: {},
        verify: { type: 'screenshot_exists' },
        continueOnFailure: false
      }
    ]
  }
}

function loadVisionModel(): Model | undefined {
  try {
    const stored = localStorage.getItem(RPA_VISION_MODEL_STORAGE_KEY)
    if (stored) {
      const model = JSON.parse(stored) as Model
      if (isVisionModel(model)) return model
    }
  } catch (error) {
    logger.warn('Failed to load the RPA vision model selection', { error })
  }

  const defaultModel = getDefaultModel()
  return defaultModel && isVisionModel(defaultModel) ? defaultModel : undefined
}

const RpaTaskRunnerPanel: React.FC<RpaTaskRunnerPanelProps> = ({ devices, onClose }) => {
  const { t } = useTranslation()
  const onlineDevices = useMemo(() => devices.filter((device) => device.status === 'online'), [devices])
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>(() => onlineDevices.map((device) => device.id))
  const [taskJson, setTaskJson] = useState(() => JSON.stringify(buildSampleTask(selectedDeviceIds), null, 2))
  const [visionModel, setVisionModel] = useState<Model | undefined>(loadVisionModel)
  const [runs, setRuns] = useState<RpaBatchRunRecord[]>([])
  const [starting, setStarting] = useState(false)

  const refreshRuns = useCallback(() => {
    setRuns(rpaBatchRunner.getRuns())
  }, [])

  useEffect(() => {
    void rpaBatchRunner.initialize().then(refreshRuns)
    return rpaBatchRunner.subscribe(refreshRuns)
  }, [refreshRuns])

  useEffect(() => {
    setSelectedDeviceIds((prev) => {
      const available = new Set(onlineDevices.map((device) => device.id))
      const next = prev.filter((deviceId) => available.has(deviceId))
      return next.length > 0 ? next : onlineDevices.map((device) => device.id)
    })
  }, [onlineDevices])

  const startRun = async () => {
    try {
      setStarting(true)
      if (selectedDeviceIds.length === 0) {
        message.warning(t('device.rpa.select_device', { defaultValue: 'Select at least one online device.' }))
        return
      }
      if (!visionModel || !isVisionModel(visionModel)) {
        message.warning(
          t('device.rpa.select_vision_model', { defaultValue: 'Select a vision-capable model before starting.' })
        )
        return
      }

      const parsedTask = JSON.parse(taskJson) as RpaTask
      await rpaBatchRunner.start({
        task: {
          ...parsedTask,
          deviceIds: selectedDeviceIds,
          visionModel
        },
        deviceIds: selectedDeviceIds
      })
      message.success(t('device.rpa.started', { defaultValue: 'RPA batch run started.' }))
    } catch (error) {
      logger.error('Failed to start RPA batch run', { error })
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setStarting(false)
    }
  }

  const resetSample = () => {
    setTaskJson(JSON.stringify(buildSampleTask(selectedDeviceIds), null, 2))
  }

  const selectVisionModel = async () => {
    const selected = await SelectModelPopup.show({ model: visionModel, filter: isVisionModel, showTagFilter: false })
    if (!selected) return
    setVisionModel(selected)
    localStorage.setItem(RPA_VISION_MODEL_STORAGE_KEY, JSON.stringify(selected))
  }

  return (
    <Modal
      title={t('device.rpa.title', { defaultValue: 'RPA Runner' })}
      open
      onCancel={onClose}
      footer={null}
      width={920}
      centered>
      <PanelBody>
        <Section>
          <SectionTitle>{t('device.rpa.devices', { defaultValue: 'Devices' })}</SectionTitle>
          <Checkbox.Group value={selectedDeviceIds} onChange={(values) => setSelectedDeviceIds(values.map(String))}>
            <DeviceOptionGrid>
              {onlineDevices.map((device) => (
                <Checkbox key={device.id} value={device.id}>
                  {device.name || device.id}
                </Checkbox>
              ))}
            </DeviceOptionGrid>
          </Checkbox.Group>
          {onlineDevices.length === 0 && (
            <Typography.Text type="secondary">
              {t('device.rpa.no_online_devices', { defaultValue: 'No online devices are available.' })}
            </Typography.Text>
          )}
        </Section>

        <Section>
          <SectionTitle>{t('device.rpa.vision_model', { defaultValue: 'Vision model' })}</SectionTitle>
          <VisionModelButton onClick={() => void selectVisionModel()}>
            {visionModel ? (
              <>
                <ModelAvatar model={visionModel} size={20} />
                <span>{visionModel.name}</span>
              </>
            ) : (
              t('device.rpa.select_vision_model', { defaultValue: 'Select a vision-capable model' })
            )}
          </VisionModelButton>
          {!visionModel && (
            <Typography.Text type="warning">
              {t('device.rpa.vision_model_required', {
                defaultValue: 'The current default model cannot process screenshots.'
              })}
            </Typography.Text>
          )}
        </Section>

        <Section>
          <SectionHeader>
            <SectionTitle>{t('device.rpa.dsl', { defaultValue: 'Task DSL' })}</SectionTitle>
            <Space>
              <Button onClick={resetSample}>{t('device.rpa.reset_sample', { defaultValue: 'Sample' })}</Button>
              <Button type="primary" loading={starting} onClick={startRun}>
                {t('device.rpa.start', { defaultValue: 'Start' })}
              </Button>
            </Space>
          </SectionHeader>
          <Input.TextArea value={taskJson} onChange={(event) => setTaskJson(event.target.value)} rows={12} />
        </Section>

        <Section>
          <SectionTitle>{t('device.rpa.runs', { defaultValue: 'Runs' })}</SectionTitle>
          <RunList>
            {runs.length === 0 ? (
              <Typography.Text type="secondary">
                {t('device.rpa.no_runs', { defaultValue: 'No RPA runs yet.' })}
              </Typography.Text>
            ) : (
              runs.slice(0, 8).map((run) => (
                <RunItem key={run.id}>
                  <RunHeader>
                    <div>
                      <strong>{run.task.name}</strong>
                      <Typography.Text type="secondary">{run.id}</Typography.Text>
                    </div>
                    <Space>
                      <StatusTag status={run.status} />
                      <Button size="small" danger onClick={() => void rpaBatchRunner.cancelBatchRun(run.id)}>
                        {t('common.cancel')}
                      </Button>
                    </Space>
                  </RunHeader>
                  <DeviceRunGrid>
                    {run.deviceRuns.map((deviceRun) => {
                      const lastEvent = deviceRun.events.at(-1)
                      const screenshot = findLatestScreenshot(deviceRun.events)
                      return (
                        <DeviceRunItem key={deviceRun.id}>
                          <DeviceRunHeader>
                            <strong>{deviceRun.deviceId}</strong>
                            <StatusTag status={deviceRun.status} />
                          </DeviceRunHeader>
                          <Typography.Text type={deviceRun.error ? 'danger' : 'secondary'}>
                            {deviceRun.error || lastEvent?.message || deviceRun.currentStepId || '-'}
                          </Typography.Text>
                          {deviceRun.events.length > 0 && (
                            <EventDetails>
                              <summary>
                                {t('device.rpa.execution_details', {
                                  defaultValue: 'Execution details ({{count}})',
                                  count: deviceRun.events.length
                                })}
                              </summary>
                              <EventList>
                                {deviceRun.events.map((event, index) => (
                                  <EventItem key={`${event.stepId}-${event.attempt}-${event.timestamp}-${index}`}>
                                    <EventHeader>
                                      <span>{event.stepName}</span>
                                      <Space size={6}>
                                        <Typography.Text type="secondary">
                                          {t('device.rpa.attempt', {
                                            defaultValue: 'Attempt {{attempt}}',
                                            attempt: event.attempt
                                          })}
                                        </Typography.Text>
                                        <StatusTag status={event.status} />
                                      </Space>
                                    </EventHeader>
                                    <EventMessage type={event.status === 'failed' ? 'danger' : 'secondary'}>
                                      {event.message}
                                    </EventMessage>
                                    {findRecoveryDecision(event.data) && (
                                      <InterventionDetails>
                                        <summary>
                                          {t('device.rpa.recovery_decision', { defaultValue: 'VLM recovery decision' })}
                                        </summary>
                                        <EvidenceLabel>
                                          {t('device.rpa.decision', { defaultValue: 'Decision' })}
                                        </EvidenceLabel>
                                        <EvidenceText>{findRecoveryDecision(event.data)?.status}</EvidenceText>
                                        <EvidenceLabel>
                                          {t('device.rpa.reason', { defaultValue: 'Reason' })}
                                        </EvidenceLabel>
                                        <EvidenceText>{findRecoveryDecision(event.data)?.message}</EvidenceText>
                                        <EvidenceLabel>
                                          {t('device.rpa.confidence', { defaultValue: 'Confidence' })}
                                        </EvidenceLabel>
                                        <EvidenceText>
                                          {findRecoveryDecision(event.data)?.confidence.toFixed(2)}
                                        </EvidenceText>
                                        {(findRecoveryDecision(event.data)?.steps.length ?? 0) > 0 && (
                                          <>
                                            <EvidenceLabel>
                                              {t('device.rpa.temporary_steps', { defaultValue: 'Temporary steps' })}
                                            </EvidenceLabel>
                                            <EvidenceText>
                                              {JSON.stringify(findRecoveryDecision(event.data)?.steps, null, 2)}
                                            </EvidenceText>
                                          </>
                                        )}
                                      </InterventionDetails>
                                    )}
                                    {findVisionIntervention(event.data) && (
                                      <InterventionDetails>
                                        <summary>
                                          {t('device.rpa.correction_evidence', { defaultValue: 'Correction evidence' })}
                                        </summary>
                                        <EvidenceLabel>
                                          {t('device.rpa.raw_vlm_response', { defaultValue: 'Raw VLM response' })}
                                        </EvidenceLabel>
                                        <EvidenceText>{findVisionIntervention(event.data)?.rawResponse}</EvidenceText>
                                        {findVisionIntervention(event.data)?.repairResponse && (
                                          <>
                                            <EvidenceLabel>
                                              {t('device.rpa.repair_response', { defaultValue: 'Repair response' })}
                                            </EvidenceLabel>
                                            <EvidenceText>
                                              {findVisionIntervention(event.data)?.repairResponse}
                                            </EvidenceText>
                                          </>
                                        )}
                                        {findVisionIntervention(event.data)?.takeoverResponse && (
                                          <>
                                            <EvidenceLabel>
                                              {t('device.rpa.takeover_response', {
                                                defaultValue: 'VLM takeover response'
                                              })}
                                            </EvidenceLabel>
                                            <EvidenceText>
                                              {findVisionIntervention(event.data)?.takeoverResponse}
                                            </EvidenceText>
                                          </>
                                        )}
                                      </InterventionDetails>
                                    )}
                                  </EventItem>
                                ))}
                              </EventList>
                            </EventDetails>
                          )}
                          {screenshot && (
                            <ScreenshotDetails>
                              <summary>
                                {t('device.rpa.latest_screenshot', { defaultValue: 'Latest screenshot' })}
                              </summary>
                              <ScreenshotPreview src={screenshot} alt="RPA device screenshot" />
                            </ScreenshotDetails>
                          )}
                          <Space size={8}>
                            <Button
                              size="small"
                              disabled={deviceRun.status !== 'running' && deviceRun.status !== 'pending'}
                              onClick={() => void rpaBatchRunner.pauseDeviceRun(deviceRun.id)}>
                              {t('device.rpa.pause', { defaultValue: 'Pause' })}
                            </Button>
                            <Button
                              size="small"
                              disabled={deviceRun.status !== 'paused' && deviceRun.status !== 'needs_human'}
                              onClick={() => void rpaBatchRunner.resumeDeviceRun(deviceRun.id)}>
                              {deviceRun.status === 'needs_human'
                                ? t('device.rpa.retry_after_human', { defaultValue: 'Retry after manual handling' })
                                : t('device.rpa.resume', { defaultValue: 'Resume' })}
                            </Button>
                            <Button
                              size="small"
                              danger
                              disabled={TERMINAL_DEVICE_STATUSES.has(deviceRun.status)}
                              onClick={() => void rpaBatchRunner.cancelDeviceRun(deviceRun.id)}>
                              {t('common.cancel')}
                            </Button>
                          </Space>
                        </DeviceRunItem>
                      )
                    })}
                  </DeviceRunGrid>
                </RunItem>
              ))
            )}
          </RunList>
        </Section>
      </PanelBody>
    </Modal>
  )
}

const StatusTag: React.FC<{ status: string }> = ({ status }) => {
  const { t } = useTranslation()
  const color =
    status === 'completed' ? 'green' : status === 'failed' ? 'red' : status === 'running' ? 'blue' : 'default'
  const label =
    status === 'cancelled'
      ? t('device.rpa.status.cancelled')
      : status === 'completed'
        ? t('device.rpa.status.completed')
        : status === 'failed'
          ? t('device.rpa.status.failed')
          : status === 'needs_human'
            ? t('device.rpa.status.needs_human')
            : status === 'passed'
              ? t('device.rpa.status.passed')
              : status === 'paused'
                ? t('device.rpa.status.paused')
                : status === 'pending'
                  ? t('device.rpa.status.pending')
                  : status === 'running'
                    ? t('device.rpa.status.running')
                    : status === 'timeout'
                      ? t('device.rpa.status.timeout')
                      : status
  return <Tag color={color}>{label}</Tag>
}

function findLatestScreenshot(events: RpaBatchRunRecord['deviceRuns'][number]['events']): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const data = events[index].data as
      | {
          observation?: { screenshot?: unknown }
          result?: {
            data?: {
              imageBase64?: unknown
              mime?: unknown
              screenshot?: { imageBase64?: unknown; mime?: unknown }
            }
          }
        }
      | undefined
    const resultData = data?.result?.data
    const screenshot = toScreenshotDataUrl(data?.observation?.screenshot ?? resultData?.screenshot ?? resultData)
    if (screenshot) return screenshot
  }
  return undefined
}

function toScreenshotDataUrl(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('imageBase64' in value)) return undefined
  const imageBase64 = value.imageBase64
  if (typeof imageBase64 !== 'string' || !imageBase64) return undefined
  const mime = 'mime' in value && typeof value.mime === 'string' ? value.mime : 'image/png'
  return imageBase64.startsWith('data:') ? imageBase64 : `data:${mime};base64,${imageBase64}`
}

function findRecoveryDecision(
  data: unknown
): { status: string; message: string; confidence: number; steps: unknown[] } | undefined {
  if (!data || typeof data !== 'object' || !('decision' in data)) return undefined
  const decision = data.decision
  if (!decision || typeof decision !== 'object') return undefined
  if (!('status' in decision) || typeof decision.status !== 'string') return undefined
  if (!('message' in decision) || typeof decision.message !== 'string') return undefined
  if (!('confidence' in decision) || typeof decision.confidence !== 'number') return undefined
  return {
    status: decision.status,
    message: decision.message,
    confidence: decision.confidence,
    steps: 'steps' in decision && Array.isArray(decision.steps) ? decision.steps : []
  }
}

function findVisionIntervention(
  data: unknown
): { rawResponse: string; repairResponse?: string; takeoverResponse?: string } | undefined {
  if (!data || typeof data !== 'object' || !('result' in data)) return undefined
  const result = data.result
  if (!result || typeof result !== 'object' || !('data' in result)) return undefined
  const resultData = result.data
  if (!resultData || typeof resultData !== 'object' || !('rawResponse' in resultData)) return undefined
  if (typeof resultData.rawResponse !== 'string') return undefined
  return {
    rawResponse: resultData.rawResponse,
    repairResponse:
      'repairResponse' in resultData && typeof resultData.repairResponse === 'string'
        ? resultData.repairResponse
        : undefined,
    takeoverResponse:
      'takeoverResponse' in resultData && typeof resultData.takeoverResponse === 'string'
        ? resultData.takeoverResponse
        : undefined
  }
}

const PanelBody = styled.div`
  display: grid;
  gap: 16px;
`

const Section = styled.section`
  display: grid;
  gap: 10px;
`

const SectionHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`

const SectionTitle = styled.h3`
  margin: 0;
  font-size: 14px;
  font-weight: 600;
`

const DeviceOptionGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
`

const VisionModelButton = styled(Button)`
  width: fit-content;

  > span {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
`

const RunList = styled.div`
  display: grid;
  gap: 10px;
  max-height: 320px;
  overflow: auto;
`

const RunItem = styled.div`
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
`

const RunHeader = styled.div`
  display: flex;
  justify-content: space-between;
  gap: 12px;

  > div:first-child {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
`

const DeviceRunGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
`

const DeviceRunItem = styled.div`
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: 10px;
  border-radius: 8px;
  background: var(--color-background-soft);
`

const EventDetails = styled.details`
  min-width: 0;

  summary {
    width: fit-content;
    cursor: pointer;
    color: var(--color-text-2);
    font-size: 13px;
  }
`

const EventList = styled.div`
  display: grid;
  gap: 6px;
  margin-top: 8px;
`

const EventItem = styled.div`
  display: grid;
  gap: 3px;
  padding: 8px;
  border-left: 2px solid var(--color-border);
  background: var(--color-background);
`

const EventHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
`

const EventMessage = styled(Typography.Text)`
  overflow-wrap: anywhere;
  white-space: pre-wrap;
`

const InterventionDetails = styled.details`
  margin-top: 4px;

  summary {
    width: fit-content;
    cursor: pointer;
    color: var(--color-text-2);
    font-size: 12px;
  }
`

const EvidenceLabel = styled.div`
  margin-top: 6px;
  color: var(--color-text-2);
  font-size: 12px;
  font-weight: 500;
`

const EvidenceText = styled.pre`
  max-height: 140px;
  margin: 4px 0 0;
  padding: 8px;
  overflow: auto;
  border: 1px solid var(--color-border);
  background: var(--color-background);
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`

const ScreenshotDetails = styled.details`
  summary {
    width: fit-content;
    cursor: pointer;
    color: var(--color-text-2);
    font-size: 13px;
  }
`

const ScreenshotPreview = styled.img`
  display: block;
  max-width: min(100%, 360px);
  max-height: 360px;
  margin-top: 8px;
  border: 1px solid var(--color-border);
  object-fit: contain;
`

const DeviceRunHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  strong {
    overflow-wrap: anywhere;
  }
`

export default RpaTaskRunnerPanel
