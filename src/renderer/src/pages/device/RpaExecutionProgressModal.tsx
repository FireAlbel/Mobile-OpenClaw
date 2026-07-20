import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import { rpaReplayService } from '@renderer/services/rpa/RpaReplayService'
import type { RpaBatchRunRecord } from '@renderer/services/rpa/RpaRunStorage'
import { rpaSafetyPolicyEngine } from '@renderer/services/rpa/RpaSafetyPolicyEngine'
import { Alert, Button, Modal, Progress, Select, Space, Tag, Typography } from 'antd'
import { ImageOff, OctagonX } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  runId?: string
  historicalRun?: RpaBatchRunRecord
  open: boolean
  onClose: () => void
}

const RpaExecutionProgressModal: FC<Props> = ({ runId, historicalRun, open, onClose }) => {
  const { t } = useTranslation()
  const [run, setRun] = useState<RpaBatchRunRecord>()
  const [deviceFilter, setDeviceFilter] = useState<string>('all')
  const [phaseFilter, setPhaseFilter] = useState<string>('all')

  const refresh = useCallback(() => {
    setRun(historicalRun ?? (runId ? rpaBatchRunner.getRuns().find((item) => item.id === runId) : undefined))
  }, [historicalRun, runId])

  useEffect(() => {
    if (!open) return
    setDeviceFilter('all')
    setPhaseFilter('all')
    if (historicalRun) {
      refresh()
      return
    }
    void rpaBatchRunner.initialize().then(refresh)
    return rpaBatchRunner.subscribe(refresh)
  }, [historicalRun, open, refresh])

  const replay = useMemo(() => (run ? rpaReplayService.load(run) : undefined), [run])
  const visibleDeviceRuns = useMemo(
    () => run?.deviceRuns.filter((deviceRun) => deviceFilter === 'all' || deviceRun.deviceId === deviceFilter) ?? [],
    [deviceFilter, run]
  )

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
  const canEmergencyStop = run?.deviceRuns.some(
    (deviceRun) => !['completed', 'failed', 'cancelled'].includes(deviceRun.status)
  )

  const confirmEmergencyStop = useCallback(() => {
    Modal.confirm({
      title: t('device.rpa.emergency_stop_confirm'),
      content: t('device.rpa.emergency_stop_detail'),
      okText: t('device.rpa.emergency_stop'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        await rpaBatchRunner.emergencyStop()
        refresh()
      }
    })
  }, [refresh, t])

  const resumeDeviceRun = useCallback(
    async (deviceRun: RpaBatchRunRecord['deviceRuns'][number]) => {
      if (!run) return
      const pendingSafety = [...deviceRun.events]
        .reverse()
        .find((event) => event.safety?.decision === 'confirmation_required')?.safety
      if (!pendingSafety) {
        await rpaBatchRunner.resumeDeviceRun(deviceRun.id)
        return
      }

      Modal.confirm({
        title: t('device.rpa.confirm_high_risk_execution'),
        content: t('device.rpa.confirm_safety_target', { target: pendingSafety.target }),
        okText: t('device.rpa.approve_and_retry'),
        okButtonProps: { danger: true },
        cancelText: t('common.cancel'),
        onOk: async () => {
          const safetyApproval = rpaSafetyPolicyEngine.createApproval(
            run.task,
            [pendingSafety.target],
            [deviceRun.deviceId]
          )
          await rpaBatchRunner.resumeDeviceRun(deviceRun.id, safetyApproval)
        }
      })
    },
    [run, t]
  )

  return (
    <Modal
      title={
        historicalRun
          ? t('device.rpa.run_replay', { defaultValue: 'RPA run replay' })
          : t('device.rpa.execution_progress', { defaultValue: 'RPA execution progress' })
      }
      open={open}
      onCancel={onClose}
      width={900}
      footer={
        <Space>
          {!historicalRun && (
            <Button danger icon={<OctagonX size={16} />} disabled={!canEmergencyStop} onClick={confirmEmergencyStop}>
              {t('device.rpa.emergency_stop')}
            </Button>
          )}
          <Button onClick={onClose}>{t('common.close')}</Button>
        </Space>
      }>
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
          <ReplayFilters>
            <Select
              value={deviceFilter}
              onChange={setDeviceFilter}
              options={[
                { value: 'all', label: t('device.rpa.all_devices', { defaultValue: 'All devices' }) },
                ...run.deviceRuns.map((deviceRun) => ({ value: deviceRun.deviceId, label: deviceRun.deviceId }))
              ]}
            />
            <Select
              value={phaseFilter}
              onChange={setPhaseFilter}
              options={[
                { value: 'all', label: t('device.rpa.all_phases', { defaultValue: 'All phases' }) },
                ...(replay?.phases.map((phase) => ({ value: phase, label: phase })) ?? [])
              ]}
            />
            {historicalRun && replay && replay.missingArtifactCount > 0 && (
              <Typography.Text type="secondary">
                {t('device.rpa.missing_artifact_count', {
                  defaultValue: '{{count}} timeline events have no screenshot evidence.',
                  count: replay.missingArtifactCount
                })}
              </Typography.Text>
            )}
          </ReplayFilters>
          {visibleDeviceRuns.map((deviceRun) => {
            const screenshot = findLatestScreenshot(deviceRun.events)
            const currentEvent = deviceRun.events.at(-1)
            const visibleEvents = deviceRun.events.filter(
              (event) => phaseFilter === 'all' || (event.phase ?? findEventPhase(event.data)) === phaseFilter
            )
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
                  {visibleEvents.map((event, index) => {
                    const decision = findRecoveryDecision(event.data)
                    const intervention = findVisionIntervention(event.data)
                    const phase = event.phase ?? findEventPhase(event.data)
                    return (
                      <EventRow key={`${event.stepId}-${event.timestamp}-${index}`}>
                        <EventMarker $status={event.status} />
                        <EventContent>
                          <RunSummary>
                            <span>
                              {event.stepName} · {t('device.rpa.attempt', { attempt: event.attempt })}
                            </span>
                            <Space size={4}>
                              {event.recoveryRound && (
                                <Tag>{t('device.rpa.correction_round', { round: event.recoveryRound })}</Tag>
                              )}
                              {event.temporary && <Tag>{t('device.rpa.temporary_action')}</Tag>}
                              {phase && <Tag>{phase}</Tag>}
                              <StatusTag status={event.status} />
                            </Space>
                          </RunSummary>
                          <Typography.Text type="secondary">{event.message}</Typography.Text>
                          {event.safety && (
                            <EvidenceDetails>
                              <summary>{t('device.rpa.safety_decision')}</summary>
                              <EvidenceGrid>
                                <Typography.Text type="secondary">{t('device.rpa.decision')}</Typography.Text>
                                <span>{event.safety.decision}</span>
                                <Typography.Text type="secondary">{t('device.rpa.risk_level')}</Typography.Text>
                                <span>{event.safety.riskLevel}</span>
                                <Typography.Text type="secondary">{t('device.rpa.safety_target')}</Typography.Text>
                                <span>{event.safety.target}</span>
                                <Typography.Text type="secondary">{t('device.rpa.reason')}</Typography.Text>
                                <span>{event.safety.reason}</span>
                                {event.safety.delayMs !== undefined && (
                                  <>
                                    <Typography.Text type="secondary">
                                      {t('device.rpa.rate_limit_delay')}
                                    </Typography.Text>
                                    <span>{event.safety.delayMs} ms</span>
                                  </>
                                )}
                              </EvidenceGrid>
                            </EvidenceDetails>
                          )}
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
                          {event.action && (
                            <EvidenceDetails>
                              <summary>{t('device.rpa.executable_action')}</summary>
                              <EvidenceCode>{JSON.stringify(event.action, null, 2)}</EvidenceCode>
                            </EvidenceDetails>
                          )}
                          {event.verification && (
                            <EvidenceDetails>
                              <summary>{t('device.rpa.verification_result')}</summary>
                              <EvidenceGrid>
                                <Typography.Text type="secondary">Status</Typography.Text>
                                <span>{event.verification.status}</span>
                                <Typography.Text type="secondary">{t('device.rpa.confidence')}</Typography.Text>
                                <span>{event.verification.confidence.toFixed(2)}</span>
                                <Typography.Text type="secondary">{t('device.rpa.reason')}</Typography.Text>
                                <span>{event.verification.message}</span>
                              </EvidenceGrid>
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
                {screenshot ? (
                  <EvidenceDetails>
                    <summary>{t('device.rpa.latest_screenshot')}</summary>
                    <EvidenceGrid>
                      <Typography.Text type="secondary">{t('device.rpa.frame_source')}</Typography.Text>
                      <span>{screenshot.source}</span>
                      {screenshot.sequence !== undefined && (
                        <>
                          <Typography.Text type="secondary">{t('device.rpa.frame_sequence')}</Typography.Text>
                          <span>{screenshot.sequence}</span>
                        </>
                      )}
                      {screenshot.capturedAt !== undefined && (
                        <>
                          <Typography.Text type="secondary">{t('device.rpa.frame_captured_at')}</Typography.Text>
                          <span>{new Date(screenshot.capturedAt).toLocaleString()}</span>
                        </>
                      )}
                      {screenshot.width !== undefined && screenshot.height !== undefined && (
                        <>
                          <Typography.Text type="secondary">{t('device.rpa.frame_dimensions')}</Typography.Text>
                          <span>
                            {screenshot.width} x {screenshot.height}
                          </span>
                        </>
                      )}
                      {screenshot.codecName && (
                        <>
                          <Typography.Text type="secondary">{t('device.rpa.frame_codec')}</Typography.Text>
                          <span>{screenshot.codecName.toUpperCase()}</span>
                        </>
                      )}
                      {screenshot.reconnectCount !== undefined && (
                        <>
                          <Typography.Text type="secondary">{t('device.rpa.frame_reconnects')}</Typography.Text>
                          <span>{screenshot.reconnectCount}</span>
                        </>
                      )}
                    </EvidenceGrid>
                    <ScreenshotPreview src={screenshot.src} alt={t('device.rpa.latest_screenshot')} />
                  </EvidenceDetails>
                ) : (
                  <Alert
                    type="info"
                    showIcon
                    icon={<ImageOff size={16} />}
                    message={t('device.rpa.missing_screenshot', {
                      defaultValue: 'Screenshot evidence is unavailable.'
                    })}
                  />
                )}
                {!historicalRun && (
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
                      onClick={() => void resumeDeviceRun(deviceRun)}>
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
                )}
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

interface ScreenshotEvidence {
  src: string
  source: string
  sequence?: number
  capturedAt?: number
  width?: number
  height?: number
  codecName?: string
  reconnectCount?: number
}

function findLatestScreenshot(
  events: RpaBatchRunRecord['deviceRuns'][number]['events']
): ScreenshotEvidence | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const data = events[index].data as
      | {
          observation?: { screenshot?: unknown }
          result?: { data?: { imageBase64?: unknown; mime?: unknown; screenshot?: unknown } }
          verification?: { evidence?: { observation?: { screenshot?: unknown } } }
        }
      | undefined
    const resultData = data?.result?.data
    const screenshot = toScreenshotEvidence(
      data?.observation?.screenshot ??
        data?.verification?.evidence?.observation?.screenshot ??
        resultData?.screenshot ??
        resultData
    )
    if (screenshot) return screenshot
  }
  return undefined
}

function toScreenshotEvidence(value: unknown): ScreenshotEvidence | undefined {
  if (!value || typeof value !== 'object' || !('imageBase64' in value)) return undefined
  if (typeof value.imageBase64 !== 'string' || !value.imageBase64) return undefined
  const mime = 'mime' in value && typeof value.mime === 'string' ? value.mime : 'image/png'
  return {
    src: value.imageBase64.startsWith('data:') ? value.imageBase64 : `data:${mime};base64,${value.imageBase64}`,
    source: 'source' in value && typeof value.source === 'string' ? value.source : 'unknown',
    sequence: 'sequence' in value && typeof value.sequence === 'number' ? value.sequence : undefined,
    capturedAt: 'capturedAt' in value && typeof value.capturedAt === 'number' ? value.capturedAt : undefined,
    width: 'width' in value && typeof value.width === 'number' ? value.width : undefined,
    height: 'height' in value && typeof value.height === 'number' ? value.height : undefined,
    codecName: 'codecName' in value && typeof value.codecName === 'string' ? value.codecName : undefined,
    reconnectCount:
      'reconnectCount' in value && typeof value.reconnectCount === 'number' ? value.reconnectCount : undefined
  }
}

function findRecoveryDecision(
  data: unknown
): { status: string; message: string; confidence: number; steps: unknown[] } | undefined {
  if (!data || typeof data !== 'object' || !('decision' in data)) return undefined
  const decision = data.decision
  if (!decision || typeof decision !== 'object') return undefined
  const status =
    'decision' in decision && typeof decision.decision === 'string'
      ? decision.decision
      : 'status' in decision && typeof decision.status === 'string'
        ? decision.status
        : undefined
  const message =
    'reason' in decision && typeof decision.reason === 'string'
      ? decision.reason
      : 'message' in decision && typeof decision.message === 'string'
        ? decision.message
        : undefined
  if (!status || !message) return undefined
  if (!('confidence' in decision) || typeof decision.confidence !== 'number') return undefined
  return {
    status,
    message,
    confidence: decision.confidence,
    steps:
      'actions' in decision && Array.isArray(decision.actions)
        ? decision.actions
        : 'steps' in decision && Array.isArray(decision.steps)
          ? decision.steps
          : []
  }
}

function findVisionIntervention(
  data: unknown
): { rawResponse: string; repairResponse?: string; takeoverResponse?: string } | undefined {
  if (!data || typeof data !== 'object') return undefined
  if ('verification' in data && data.verification && typeof data.verification === 'object') {
    const verification = data.verification
    if ('evidence' in verification && verification.evidence && typeof verification.evidence === 'object') {
      const evidence = verification.evidence
      if ('rawResponse' in evidence && typeof evidence.rawResponse === 'string') {
        return { rawResponse: evidence.rawResponse }
      }
    }
  }
  if (!('result' in data)) return undefined
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

const ReplayFilters = styled.div`
  display: grid;
  grid-template-columns: minmax(160px, 240px) minmax(160px, 240px) minmax(0, 1fr);
  align-items: center;
  gap: 10px;

  @media (max-width: 700px) {
    grid-template-columns: 1fr;
  }
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
