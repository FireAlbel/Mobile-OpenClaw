import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import { rpaReplayService } from '@renderer/services/rpa/RpaReplayService'
import type { RpaBatchRunRecord } from '@renderer/services/rpa/RpaRunStorage'
import { rpaSafetyPolicyEngine } from '@renderer/services/rpa/RpaSafetyPolicyEngine'
import { Alert, Button, Modal, Progress, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { TFunction } from 'i18next'
import { Eye, ImageOff, OctagonX, Pause, Play } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  runId?: string
  historicalRun?: RpaBatchRunRecord
  open: boolean
  onClose: () => void
  onReplan?: (run: RpaBatchRunRecord) => void
}

const RpaExecutionProgressModal: FC<Props> = ({ runId, historicalRun, open, onClose, onReplan }) => {
  const { t } = useTranslation()
  const [run, setRun] = useState<RpaBatchRunRecord>()
  const [selectedDeviceRunId, setSelectedDeviceRunId] = useState<string>()
  const [detectedDevices, setDetectedDevices] = useState(() => rpaBatchRunner.getDetectedDevices())
  const [deviceStatusReady, setDeviceStatusReady] = useState(() => rpaBatchRunner.hasDeviceStatusSnapshot())

  const refresh = useCallback(() => {
    setRun(historicalRun ?? (runId ? rpaBatchRunner.getRuns().find((item) => item.id === runId) : undefined))
    setDetectedDevices(rpaBatchRunner.getDetectedDevices())
    setDeviceStatusReady(rpaBatchRunner.hasDeviceStatusSnapshot())
  }, [historicalRun, runId])

  useEffect(() => {
    if (!open) return
    const unsubscribe = rpaBatchRunner.subscribe(refresh)
    const initialize = historicalRun ? Promise.resolve() : rpaBatchRunner.initialize()
    void initialize.then(() => rpaBatchRunner.refreshDeviceStatuses()).then(refresh)
    refresh()
    return unsubscribe
  }, [historicalRun, open, refresh])

  const replay = useMemo(() => (run ? rpaReplayService.load(run) : undefined), [run])
  const selectedDeviceRun = useMemo(
    () => run?.deviceRuns.find((deviceRun) => deviceRun.id === selectedDeviceRunId),
    [run, selectedDeviceRunId]
  )
  const detectedDeviceById = useMemo(
    () => new Map(detectedDevices.map((device) => [device.id, device])),
    [detectedDevices]
  )
  const canEmergencyStop = run?.deviceRuns.some(
    (deviceRun) => !['completed', 'failed', 'cancelled'].includes(deviceRun.status)
  )
  const canReplan =
    !historicalRun &&
    Boolean(run) &&
    (run?.status === 'failed' || run?.deviceRuns.some((deviceRun) => deviceRun.status === 'needs_human'))

  const confirmCurrentRunStop = useCallback(() => {
    if (!run) return
    Modal.confirm({
      title: t('device.rpa.emergency_stop_confirm'),
      content: t('device.rpa.emergency_stop_detail'),
      okText: t('device.rpa.emergency_stop'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: async () => {
        await rpaBatchRunner.cancelBatchRun(run.id)
        refresh()
      }
    })
  }, [refresh, run, t])

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
    <>
      <Modal
        title={t('device.rpa.execution_progress', { defaultValue: 'RPA execution details' })}
        open={open && Boolean(selectedDeviceRun)}
        onCancel={() => setSelectedDeviceRunId(undefined)}
        destroyOnHidden
        width={900}
        footer={<Button onClick={() => setSelectedDeviceRunId(undefined)}>{t('common.close')}</Button>}>
        {!run ? (
          <Typography.Text type="secondary">
            {t('device.rpa.run_loading', { defaultValue: 'Loading execution record...' })}
          </Typography.Text>
        ) : (
          <ModalBody>
            {historicalRun && replay && replay.missingArtifactCount > 0 && (
              <Typography.Text type="secondary">
                {t('device.rpa.missing_artifact_count', {
                  defaultValue: '{{count}} timeline events have no screenshot evidence.',
                  count: replay.missingArtifactCount
                })}
              </Typography.Text>
            )}
            {selectedDeviceRun &&
              [selectedDeviceRun].map((deviceRun) => {
                const screenshot = findLatestScreenshot(deviceRun.events)
                return (
                  <DeviceRun key={deviceRun.id}>
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
                  </DeviceRun>
                )
              })}
          </ModalBody>
        )}
      </Modal>
      <Modal
        title={t('device.rpa.execution_devices')}
        open={open}
        onCancel={onClose}
        width={900}
        footer={
          <Space>
            {canReplan && run && onReplan && (
              <Button
                onClick={() => {
                  onReplan(run)
                  onClose()
                }}>
                {t('device.rpa.replan.action', { defaultValue: 'Replan' })}
              </Button>
            )}
            {!historicalRun && (
              <Button danger icon={<OctagonX size={16} />} disabled={!canEmergencyStop} onClick={confirmCurrentRunStop}>
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
          <Table<RpaBatchRunRecord['deviceRuns'][number]>
            rowKey="id"
            pagination={false}
            dataSource={run.deviceRuns}
            columns={[
              {
                title: t('device.rpa.device_name'),
                key: 'device',
                render: (_, deviceRun) => {
                  const device = detectedDeviceById.get(deviceRun.deviceId)
                  return (
                    <DeviceIdentity>
                      <strong>{device?.name || device?.model || deviceRun.deviceId}</strong>
                      {(device?.name || device?.model) && (
                        <Typography.Text type="secondary">{deviceRun.deviceId}</Typography.Text>
                      )}
                    </DeviceIdentity>
                  )
                }
              },
              {
                title: t('device.rpa.device_execution_progress'),
                key: 'progress',
                width: 250,
                render: (_, deviceRun) => {
                  const progress = getDeviceProgress(run, deviceRun)
                  return (
                    <DeviceProgressValue>
                      <Progress
                        percent={progress.percent}
                        size="small"
                        status={deviceRun.status === 'failed' ? 'exception' : undefined}
                      />
                      <Typography.Text type="secondary">
                        {t('device.rpa.device_completed_steps', {
                          completed: progress.completed,
                          total: progress.total
                        })}
                      </Typography.Text>
                    </DeviceProgressValue>
                  )
                }
              },
              {
                title: t('device.rpa.execution_status'),
                key: 'status',
                width: 140,
                render: (_, deviceRun) => {
                  const device = detectedDeviceById.get(deviceRun.deviceId)
                  const liveStatus = device?.status ?? (deviceStatusReady ? 'offline' : undefined)
                  const presentation = getDeviceStatusPresentation(run, deviceRun, liveStatus)
                  const reason = getDeviceStatusReason(deviceRun, presentation.status, t)
                  const tag = <StatusTag status={presentation.status} />
                  return reason ? (
                    <Tooltip title={reason}>
                      <StatusTooltipTarget title={reason}>{tag}</StatusTooltipTarget>
                    </Tooltip>
                  ) : (
                    tag
                  )
                }
              },
              {
                title: t('device.rpa.operations'),
                key: 'operations',
                width: 210,
                render: (_, deviceRun) => {
                  const device = detectedDeviceById.get(deviceRun.deviceId)
                  const unavailable = deviceStatusReady && device?.status !== 'online'
                  const canStop = deviceRun.status === 'pending' || deviceRun.status === 'running'
                  const canContinue = deviceRun.status === 'paused' || deviceRun.status === 'needs_human'
                  return (
                    <Space size={4}>
                      <Button
                        type="link"
                        size="small"
                        icon={<Eye size={15} />}
                        onClick={() => setSelectedDeviceRunId(deviceRun.id)}>
                        {t('device.rpa.view_details')}
                      </Button>
                      {canStop && !historicalRun && (
                        <Button
                          type="link"
                          size="small"
                          icon={<Pause size={15} />}
                          onClick={() => void rpaBatchRunner.pauseDeviceRun(deviceRun.id)}>
                          {t('device.rpa.stop_device')}
                        </Button>
                      )}
                      {canContinue && !historicalRun && (
                        <Tooltip title={unavailable ? t('device.rpa.device_offline_cannot_continue') : undefined}>
                          <Button
                            type="link"
                            size="small"
                            icon={<Play size={15} />}
                            disabled={unavailable}
                            onClick={() => void resumeDeviceRun(deviceRun)}>
                            {t('device.rpa.continue_device')}
                          </Button>
                        </Tooltip>
                      )}
                    </Space>
                  )
                }
              }
            ]}
          />
        )}
      </Modal>
    </>
  )
}

function getDeviceProgress(
  run: RpaBatchRunRecord,
  deviceRun: RpaBatchRunRecord['deviceRuns'][number]
): { completed: number; total: number; percent: number } {
  const completed = run.task.steps.filter((step) =>
    deviceRun.events.some((event) => event.stepId === step.id && event.status === 'passed')
  ).length
  const total = run.task.steps.length
  return {
    completed,
    total,
    percent: total ? Math.min(100, Math.round((completed / total) * 100)) : 0
  }
}

function getDeviceStatusPresentation(
  run: RpaBatchRunRecord,
  deviceRun: RpaBatchRunRecord['deviceRuns'][number],
  liveStatus?: 'online' | 'offline' | 'unauthorized'
): { status: string } {
  if (liveStatus && liveStatus !== 'online' && !['completed', 'failed', 'cancelled'].includes(deviceRun.status)) {
    return { status: liveStatus }
  }
  if (deviceRun.status !== 'running') return { status: deviceRun.status }
  const plannedStepIds = new Set(run.task.steps.map((step) => step.id))
  const currentEvent = [...deviceRun.events]
    .reverse()
    .find((event) => plannedStepIds.has(event.stepId) && !event.temporary)
  return { status: currentEvent?.status ?? 'running' }
}

function getDeviceStatusReason(
  deviceRun: RpaBatchRunRecord['deviceRuns'][number],
  status: string,
  t: TFunction
): string | undefined {
  if (status === 'offline') {
    return t('device.rpa.device_offline_reason', { device: deviceRun.deviceId })
  }
  if (status === 'unauthorized') {
    return t('device.rpa.device_unauthorized_reason', { device: deviceRun.deviceId })
  }
  if (!['failed', 'timeout', 'needs_human'].includes(status)) return undefined
  return deviceRun.error || deviceRun.events.at(-1)?.message
}

const StatusTag: FC<{ status: string }> = ({ status }) => {
  const { t } = useTranslation()
  const color =
    status === 'completed' || status === 'passed'
      ? 'green'
      : status === 'failed' || status === 'offline'
        ? 'red'
        : status === 'running'
          ? 'blue'
          : status === 'unauthorized' || status === 'needs_human' || status === 'timeout'
            ? 'orange'
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
                      : status === 'offline'
                        ? t('device.status.offline')
                        : status === 'unauthorized'
                          ? t('device.status.unauthorized')
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

const StatusTooltipTarget = styled.span`
  display: inline-flex;
`

const DeviceIdentity = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;

  strong,
  .ant-typography {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`

const DeviceProgressValue = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
`

const DeviceRun = styled.section`
  display: flex;
  flex-direction: column;
  gap: 8px;
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
