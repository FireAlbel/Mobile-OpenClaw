import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import type { RpaBatchRunRecord } from '@renderer/services/rpa/RpaRunStorage'
import { Button, Progress, Tooltip } from 'antd'
import { CirclePause, ListRestart } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import RpaExecutionProgressModal from '../../device/RpaExecutionProgressModal'

const ACTIVE_BATCH_STATUSES = new Set<RpaBatchRunRecord['status']>(['pending', 'running', 'paused'])

const ActiveRpaRuns: FC = () => {
  const { t } = useTranslation()
  const [runs, setRuns] = useState<RpaBatchRunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string>()

  const refresh = useCallback(() => {
    setRuns(rpaBatchRunner.getRuns().filter((run) => ACTIVE_BATCH_STATUSES.has(run.status)))
  }, [])

  useEffect(() => {
    void rpaBatchRunner.initialize().then(refresh)
    return rpaBatchRunner.subscribe(refresh)
  }, [refresh])

  const pauseRun = useCallback(async (run: RpaBatchRunRecord) => {
    await Promise.all(
      run.deviceRuns
        .filter((deviceRun) => deviceRun.status === 'pending' || deviceRun.status === 'running')
        .map((deviceRun) => rpaBatchRunner.pauseDeviceRun(deviceRun.id))
    )
  }, [])

  if (runs.length === 0) {
    return <EmptyState>{t('device.rpa.no_active_runs')}</EmptyState>
  }

  return (
    <>
      <RunList>
        {runs.map((run) => {
          const completedDevices = run.deviceRuns.filter((deviceRun) => deviceRun.status === 'completed').length
          const completedSteps = run.deviceRuns.reduce(
            (total, deviceRun) =>
              total +
              run.task.steps.filter((step) =>
                deviceRun.events.some((event) => event.stepId === step.id && event.status === 'passed')
              ).length,
            0
          )
          const totalSteps = run.task.steps.length * run.deviceRuns.length
          const percent = totalSteps === 0 ? 0 : Math.min(100, Math.round((completedSteps / totalSteps) * 100))
          const needsHuman = run.deviceRuns.some((deviceRun) => deviceRun.status === 'needs_human')
          const canPause = run.deviceRuns.some(
            (deviceRun) => deviceRun.status === 'pending' || deviceRun.status === 'running'
          )
          const status = needsHuman ? 'needs_human' : run.status
          const statusLabel =
            status === 'needs_human'
              ? t('device.rpa.status.needs_human')
              : status === 'running'
                ? t('device.rpa.status.running')
                : status === 'paused'
                  ? t('device.rpa.status.paused')
                  : t('device.rpa.status.pending')

          return (
            <RunRow key={run.id} onClick={() => setSelectedRunId(run.id)}>
              <RunHeader>
                <RunName title={run.task.name}>{run.task.name}</RunName>
                <RunStatus $status={status}>{statusLabel}</RunStatus>
              </RunHeader>
              <RunMeta>
                {t('device.rpa.run_devices_summary', {
                  completed: completedDevices,
                  total: run.deviceRuns.length
                })}
              </RunMeta>
              <RunFooter>
                <Progress percent={percent} size="small" showInfo={false} />
                <RunActions>
                  {canPause && (
                    <Tooltip title={t('device.rpa.pause')}>
                      <Button
                        type="text"
                        size="small"
                        icon={<CirclePause size={15} />}
                        aria-label={t('device.rpa.pause')}
                        onClick={(event) => {
                          event.stopPropagation()
                          void pauseRun(run)
                        }}
                      />
                    </Tooltip>
                  )}
                  <Tooltip title={t('device.rpa.execution_progress')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<ListRestart size={15} />}
                      aria-label={t('device.rpa.execution_progress')}
                    />
                  </Tooltip>
                </RunActions>
              </RunFooter>
            </RunRow>
          )
        })}
      </RunList>
      <RpaExecutionProgressModal
        runId={selectedRunId}
        open={Boolean(selectedRunId)}
        onClose={() => setSelectedRunId(undefined)}
      />
    </>
  )
}

const RunList = styled.div`
  display: flex;
  flex-direction: column;
`

const RunRow = styled.div`
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border-soft);
  cursor: pointer;

  &:hover {
    background: var(--color-list-item-hover);
  }

  &:last-child {
    border-bottom: 0;
  }
`

const RunHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`

const RunName = styled.strong`
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--color-text);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const RunStatus = styled.span<{ $status: string }>`
  color: ${({ $status }) =>
    $status === 'needs_human'
      ? 'var(--color-status-warning)'
      : $status === 'running'
        ? 'var(--color-primary)'
        : 'var(--color-text-secondary)'};
  font-size: 11px;
  white-space: nowrap;
`

const RunMeta = styled.div`
  margin-top: 4px;
  color: var(--color-text-secondary);
  font-size: 11px;
`

const RunFooter = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  margin-top: 6px;

  .ant-progress {
    margin: 0;
  }
`

const RunActions = styled.div`
  display: flex;
  align-items: center;

  .ant-btn {
    width: 26px;
    height: 26px;
  }
`

const EmptyState = styled.div`
  padding: 8px 12px 10px;
  color: var(--color-text-secondary);
  font-size: 12px;
`

export default ActiveRpaRuns
