import { loggerService } from '@logger'
import { rpaArtifactStore } from '@renderer/services/rpa/RpaArtifactStore'
import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import { rpaDebugBundleService } from '@renderer/services/rpa/RpaDebugBundleService'
import type { RpaBatchRunRecord, RpaTaskFlowLearningResult } from '@renderer/services/rpa/RpaRunStorage'
import { Button, Empty, message, Select, Space, Tag, Typography } from 'antd'
import { Download, History } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import RpaExecutionProgressModal from './RpaExecutionProgressModal'

const logger = loggerService.withContext('RpaRunHistory')

const RpaRunHistory: FC = () => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [runs, setRuns] = useState<RpaBatchRunRecord[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [replayOpen, setReplayOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const refresh = useCallback(() => {
    const nextRuns = rpaBatchRunner.getRuns()
    setRuns(nextRuns)
    setSelectedRunId((current) => (current && nextRuns.some((run) => run.id === current) ? current : nextRuns[0]?.id))
  }, [])

  useEffect(() => {
    void rpaBatchRunner.initialize().then(refresh)
    return rpaBatchRunner.subscribe(refresh)
  }, [refresh])

  const selectedRun = useMemo(() => runs.find((run) => run.id === selectedRunId), [runs, selectedRunId])
  const taskFlowLearning = useMemo(
    () =>
      selectedRun?.deviceRuns.find((deviceRun) => deviceRun.traceAnalysis?.taskFlowLearning)?.traceAnalysis
        ?.taskFlowLearning,
    [selectedRun]
  )

  const exportDebugBundle = async () => {
    if (!selectedRun) return
    setExporting(true)
    try {
      const bundle = rpaDebugBundleService.build(selectedRun)
      const result = await window.api.rpa.exportDebugBundle(bundle.payload)
      if (!result.cancelled) {
        if (result.filePath) {
          await rpaArtifactStore.register({
            category: 'debug_bundle',
            title: bundle.payload.fileName,
            sizeBytes: result.fileSize ?? 0,
            source: 'debug_export',
            locator: {
              externalPath: result.filePath,
              originalName: bundle.payload.fileName,
              extension: '.zip',
              mimeType: 'application/zip'
            },
            links: [
              { targetType: 'run', targetId: selectedRun.id, relation: 'debug_evidence' },
              ...selectedRun.deviceRuns.map((deviceRun) => ({
                targetType: 'device_run' as const,
                targetId: deviceRun.id,
                relation: 'debug_evidence'
              }))
            ],
            textForRedaction: bundle.redactedFields
              ? `Debug bundle exported with ${bundle.redactedFields} redacted field(s)`
              : undefined
          })
        }
        message.success(t('device.rpa.debug_exported', { defaultValue: 'Debug bundle exported.' }))
      }
    } catch (error) {
      logger.error('Failed to export RPA debug bundle', { error, runId: selectedRun.id })
      message.error(t('device.rpa.debug_export_failed', { defaultValue: 'Failed to export the debug bundle.' }))
    } finally {
      setExporting(false)
    }
  }

  return (
    <HistorySection>
      <HistoryHeader>
        <div>
          <Typography.Text strong>{t('device.rpa.run_history', { defaultValue: 'Run history' })}</Typography.Text>
          <Typography.Text type="secondary">
            {t('device.rpa.run_history_hint', { defaultValue: 'Replay evidence or export a sanitized debug bundle.' })}
          </Typography.Text>
        </div>
        {runs.length > 0 && (
          <Select
            value={selectedRunId}
            onChange={setSelectedRunId}
            options={runs.map((run) => ({
              value: run.id,
              label: `${run.task.name} · ${new Date(run.createdAt).toLocaleString()} · ${run.status}`
            }))}
          />
        )}
      </HistoryHeader>
      {runs.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('device.rpa.no_runs')} />
      ) : (
        <>
          {selectedRun?.contextSnapshot && (
            <SnapshotSummary>
              <Tag>Profile v{selectedRun.contextSnapshot.assistantProfileVersion}</Tag>
              <Tag>Knowledge {selectedRun.contextSnapshot.knowledge.length}</Tag>
              <Tag>Skill {selectedRun.contextSnapshot.skills.length}</Tag>
              {selectedRun.contextSnapshot.sourceTemplate && (
                <Tag>
                  Task Flow {selectedRun.contextSnapshot.sourceTemplate.id} v
                  {selectedRun.contextSnapshot.sourceTemplate.version ?? '?'}
                </Tag>
              )}
              <Typography.Text type="secondary">
                {selectedRun.contextSnapshot.models.planner.modelId} |{' '}
                {selectedRun.contextSnapshot.models.planner.providerId}
              </Typography.Text>
            </SnapshotSummary>
          )}
          {taskFlowLearning && (
            <LearningSummary>
              <Tag color={taskFlowLearningColor(taskFlowLearning.status)}>
                {taskFlowLearningLabel(t, taskFlowLearning)}
              </Tag>
              {taskFlowLearning.templateId && (
                <Typography.Text type="secondary">{taskFlowLearning.templateId}</Typography.Text>
              )}
            </LearningSummary>
          )}
          <Space wrap>
            <Button icon={<History size={16} />} disabled={!selectedRun} onClick={() => setReplayOpen(true)}>
              {t('device.rpa.replay', { defaultValue: 'Replay' })}
            </Button>
            <Button
              disabled={!selectedRun}
              onClick={() => selectedRun && navigate(`/files?runId=${encodeURIComponent(selectedRun.id)}`)}>
              {t('device.rpa.open_evidence', { defaultValue: 'Open evidence' })}
            </Button>
            <Button
              icon={<Download size={16} />}
              disabled={!selectedRun}
              loading={exporting}
              onClick={() => void exportDebugBundle()}>
              {t('device.rpa.export_debug_bundle', { defaultValue: 'Export debug bundle' })}
            </Button>
          </Space>
        </>
      )}
      <RpaExecutionProgressModal
        runId={selectedRunId}
        historicalRun={selectedRun}
        open={replayOpen}
        onClose={() => setReplayOpen(false)}
      />
    </HistorySection>
  )
}

const HistorySection = styled.section`
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border);
`

const HistoryHeader = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 420px);
  align-items: end;
  gap: 16px;

  > div {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  @media (max-width: 700px) {
    grid-template-columns: 1fr;
  }
`

const SnapshotSummary = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;

  .ant-tag {
    margin-inline-end: 0;
  }
`

const LearningSummary = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;

  .ant-tag {
    margin-inline-end: 0;
  }
`

function taskFlowLearningColor(status: RpaTaskFlowLearningResult['status']): string {
  if (status === 'created' || status === 'versioned') return 'success'
  if (status === 'already_applied') return 'processing'
  return 'warning'
}

function taskFlowLearningLabel(t: ReturnType<typeof useTranslation>['t'], result: RpaTaskFlowLearningResult): string {
  if (result.status === 'created') {
    return t('device.rpa.task_flow_learning.created', { version: result.appliedVersion })
  }
  if (result.status === 'versioned') {
    return t('device.rpa.task_flow_learning.versioned', { version: result.appliedVersion })
  }
  if (result.status === 'already_applied') {
    return t('device.rpa.task_flow_learning.already_applied', { version: result.appliedVersion })
  }
  if (result.status === 'skipped_version_conflict') {
    return t('device.rpa.task_flow_learning.skipped_version_conflict')
  }
  return t('device.rpa.task_flow_learning.skipped_validation_failed')
}

export default RpaRunHistory
