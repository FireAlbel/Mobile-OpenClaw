import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import type { RpaBatchRunRecord } from '@renderer/services/rpa/RpaRunStorage'
import { Button, Modal, Progress, Space, Tag, Typography } from 'antd'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  runId?: string
  open: boolean
  onClose: () => void
}

const RpaExecutionProgressModal: FC<Props> = ({ runId, open, onClose }) => {
  const { t } = useTranslation()
  const [run, setRun] = useState<RpaBatchRunRecord>()

  const refresh = useCallback(() => {
    setRun(runId ? rpaBatchRunner.getRuns().find((item) => item.id === runId) : undefined)
  }, [runId])

  useEffect(() => {
    if (!open) return
    void rpaBatchRunner.initialize().then(refresh)
    return rpaBatchRunner.subscribe(refresh)
  }, [open, refresh])

  const completedSteps = useMemo(
    () =>
      run?.deviceRuns.reduce(
        (sum, deviceRun) =>
          sum +
          run.task.steps.filter((step) =>
            deviceRun.events.some((event) => event.stepId === step.id && event.status === 'passed')
          ).length,
        0
      ) ?? 0,
    [run]
  )
  const totalSteps = (run?.task.steps.length ?? 0) * (run?.deviceRuns.length ?? 0)
  const percent = totalSteps ? Math.min(100, Math.round((completedSteps / totalSteps) * 100)) : 0

  return (
    <Modal
      title={t('device.rpa.execution_progress', { defaultValue: 'RPA execution progress' })}
      open={open}
      onCancel={onClose}
      width={900}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      {!run ? (
        <Typography.Text type="secondary">
          {t('device.rpa.run_loading', { defaultValue: 'Loading execution record...' })}
        </Typography.Text>
      ) : (
        <ModalBody>
          <Progress percent={percent} status={run.status === 'failed' ? 'exception' : undefined} />
          <RunSummary>
            <strong>{run.task.name}</strong>
            <StatusTag status={run.status} />
          </RunSummary>
          {run.deviceRuns.map((deviceRun) => {
            const screenshot = findLatestScreenshot(deviceRun.events)
            const currentEvent = deviceRun.events.at(-1)
            return (
              <DeviceRun key={deviceRun.id}>
                <RunSummary>
                  <strong>{deviceRun.deviceId}</strong>
                  <StatusTag status={deviceRun.status} />
                </RunSummary>
                {currentEvent && (
                  <CurrentStep>
                    <Typography.Text type="secondary">{t('device.rpa.current_step')}</Typography.Text>
                    <strong>{currentEvent.stepName}</strong>
                    <StatusTag status={currentEvent.status} />
                  </CurrentStep>
                )}
                {deviceRun.error && <Typography.Text type="danger">{deviceRun.error}</Typography.Text>}
                <StepOverview>
                  {run.task.steps.map((step, index) => {
                    const events = deviceRun.events.filter((event) => event.stepId === step.id)
                    const latestEvent = events.at(-1)
                    return (
                      <PlannedStep key={step.id}>
                        <StepNumber>{index + 1}</StepNumber>
                        <StepDescription>
                          <strong>{step.name}</strong>
                          <Typography.Text type="secondary">
                            {latestEvent?.message || t('device.rpa.waiting_to_execute')}
                          </Typography.Text>
                        </StepDescription>
                        <StatusTag status={latestEvent?.status || 'pending'} />
                      </PlannedStep>
                    )
                  })}
                </StepOverview>
                <Typography.Text strong>{t('device.rpa.realtime_events')}</Typography.Text>
                <EventList>
                  {deviceRun.events.map((event, index) => {
                    const decision = findRecoveryDecision(event.data)
                    const intervention = findVisionIntervention(event.data)
                    return (
                      <EventRow key={`${event.stepId}-${event.timestamp}-${index}`}>
                        <EventMarker $status={event.status} />
                        <EventContent>
                          <RunSummary>
                            <span>
                              {event.stepName} · {t('device.rpa.attempt', { attempt: event.attempt })}
                            </span>
                            <Space size={4}>
                              {findEventPhase(event.data) && <Tag>{findEventPhase(event.data)}</Tag>}
                              <StatusTag status={event.status} />
                            </Space>
                          </RunSummary>
                          <Typography.Text type="secondary">{event.message}</Typography.Text>
                          {decision && (
                            <EvidenceDetails>
                              <summary>{t('device.rpa.recovery_decision')}</summary>
                              <EvidenceGrid>
                                <Typography.Text type="secondary">{t('device.rpa.decision')}</Typography.Text>
                                <span>{decision.status}</span>
                                <Typography.Text type="secondary">{t('device.rpa.reason')}</Typography.Text>
                                <span>{decision.message}</span>
                                <Typography.Text type="secondary">{t('device.rpa.confidence')}</Typography.Text>
                                <span>{decision.confidence.toFixed(2)}</span>
                              </EvidenceGrid>
                              {decision.steps.length > 0 && (
                                <EvidenceCode>
                                  {t('device.rpa.temporary_steps')}
                                  {'\n'}
                                  {JSON.stringify(decision.steps, null, 2)}
                                </EvidenceCode>
                              )}
                            </EvidenceDetails>
                          )}
                          {intervention && (
                            <EvidenceDetails>
                              <summary>{t('device.rpa.correction_evidence')}</summary>
                              <EvidenceCode>{intervention.rawResponse}</EvidenceCode>
                              {intervention.repairResponse && (
                                <EvidenceCode>{intervention.repairResponse}</EvidenceCode>
                              )}
                              {intervention.takeoverResponse && (
                                <EvidenceCode>{intervention.takeoverResponse}</EvidenceCode>
                              )}
                            </EvidenceDetails>
                          )}
                        </EventContent>
                      </EventRow>
                    )
                  })}
                </EventList>
                {screenshot && (
                  <EvidenceDetails>
                    <summary>{t('device.rpa.latest_screenshot')}</summary>
                    <ScreenshotPreview src={screenshot} alt={t('device.rpa.latest_screenshot')} />
                  </EvidenceDetails>
                )}
                <Space>
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
                    disabled={['completed', 'failed', 'cancelled'].includes(deviceRun.status)}
                    onClick={() => void rpaBatchRunner.cancelDeviceRun(deviceRun.id)}>
                    {t('common.cancel')}
                  </Button>
                </Space>
              </DeviceRun>
            )
          })}
        </ModalBody>
      )}
    </Modal>
  )
}

const StatusTag: FC<{ status: string }> = ({ status }) => {
  const { t } = useTranslation()
  const color =
    status === 'completed' || status === 'passed'
      ? 'green'
      : status === 'failed'
        ? 'red'
        : status === 'running'
          ? 'blue'
          : 'default'
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
          result?: { data?: { imageBase64?: unknown; mime?: unknown; screenshot?: unknown } }
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
  if (typeof value.imageBase64 !== 'string' || !value.imageBase64) return undefined
  const mime = 'mime' in value && typeof value.mime === 'string' ? value.mime : 'image/png'
  return value.imageBase64.startsWith('data:') ? value.imageBase64 : `data:${mime};base64,${value.imageBase64}`
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

function findEventPhase(data: unknown): string | undefined {
  if (!data || typeof data !== 'object' || !('phase' in data) || typeof data.phase !== 'string') return undefined
  return data.phase
}

const ModalBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: 68vh;
  overflow-y: auto;
`

const RunSummary = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`

const DeviceRun = styled.section`
  border-top: 1px solid var(--color-border);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const CurrentStep = styled.div`
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-left: 3px solid var(--color-primary);
  background: var(--color-background-soft);
`

const StepOverview = styled.div`
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: 6px;
`

const PlannedStep = styled.div`
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  min-height: 52px;
  padding: 8px 10px;

  & + & {
    border-top: 1px solid var(--color-border);
  }
`

const StepNumber = styled.span`
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--color-background-mute);
  color: var(--color-text-2);
`

const StepDescription = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;

  .ant-typography {
    overflow-wrap: anywhere;
  }
`

const EventList = styled.div`
  display: flex;
  flex-direction: column;
  padding-left: 6px;
`

const EventRow = styled.div`
  display: grid;
  grid-template-columns: 14px 1fr;
  gap: 10px;
  min-height: 52px;
`

const EventMarker = styled.div<{ $status: string }>`
  width: 10px;
  height: 10px;
  margin-top: 6px;
  border-radius: 50%;
  background: ${({ $status }) => ($status === 'passed' ? '#22a06b' : $status === 'failed' ? '#d14343' : '#4b7bec')};
`

const EventContent = styled.div`
  border-left: 1px solid var(--color-border);
  padding: 0 0 12px 12px;
`

const EvidenceDetails = styled.details`
  margin-top: 8px;

  summary {
    cursor: pointer;
    color: var(--color-text-2);
  }
`

const EvidenceGrid = styled.div`
  display: grid;
  grid-template-columns: minmax(80px, auto) 1fr;
  gap: 6px 12px;
  margin-top: 8px;
`

const EvidenceCode = styled.pre`
  margin: 8px 0 0;
  padding: 8px;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background-soft);
`

const ScreenshotPreview = styled.img`
  display: block;
  max-width: min(100%, 360px);
  max-height: 420px;
  margin-top: 8px;
  object-fit: contain;
  border: 1px solid var(--color-border);
  border-radius: 6px;
`

export default RpaExecutionProgressModal
