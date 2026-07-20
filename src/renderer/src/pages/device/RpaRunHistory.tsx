import { loggerService } from '@logger'
import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import { rpaDebugBundleService } from '@renderer/services/rpa/RpaDebugBundleService'
import type { RpaBatchRunRecord } from '@renderer/services/rpa/RpaRunStorage'
import type { RpaTask } from '@renderer/services/rpa/RpaTypes'
import { Button, Empty, message, Select, Space, Typography } from 'antd'
import { Download, FilePlus2, History } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import RpaExecutionProgressModal from './RpaExecutionProgressModal'

const logger = loggerService.withContext('RpaRunHistory')

interface Props {
  onUseTemplate: (template: RpaTask) => void
}

const RpaRunHistory: FC<Props> = ({ onUseTemplate }) => {
  const { t } = useTranslation()
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

  const exportDebugBundle = async () => {
    if (!selectedRun) return
    setExporting(true)
    try {
      const bundle = rpaDebugBundleService.build(selectedRun)
      const result = await window.api.rpa.exportDebugBundle(bundle.payload)
      if (!result.cancelled) {
        message.success(t('device.rpa.debug_exported', { defaultValue: 'Debug bundle exported.' }))
      }
    } catch (error) {
      logger.error('Failed to export RPA debug bundle', { error, runId: selectedRun.id })
      message.error(t('device.rpa.debug_export_failed', { defaultValue: 'Failed to export the debug bundle.' }))
    } finally {
      setExporting(false)
    }
  }

  const createTemplate = () => {
    if (!selectedRun) return
    try {
      const template = rpaDebugBundleService.createTemplate(selectedRun)
      onUseTemplate(template)
      message.success(t('device.rpa.template_created', { defaultValue: 'Reusable workflow template created.' }))
    } catch (error) {
      logger.warn('RPA run cannot be converted into a template', { error, runId: selectedRun.id })
      message.warning(
        t('device.rpa.template_requires_success', {
          defaultValue: 'Only a fully successful run can become a template.'
        })
      )
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
        <Space wrap>
          <Button icon={<History size={16} />} disabled={!selectedRun} onClick={() => setReplayOpen(true)}>
            {t('device.rpa.replay', { defaultValue: 'Replay' })}
          </Button>
          <Button
            icon={<Download size={16} />}
            disabled={!selectedRun}
            loading={exporting}
            onClick={() => void exportDebugBundle()}>
            {t('device.rpa.export_debug_bundle', { defaultValue: 'Export debug bundle' })}
          </Button>
          <Button
            icon={<FilePlus2 size={16} />}
            disabled={!selectedRun || selectedRun.status !== 'completed'}
            onClick={createTemplate}>
            {t('device.rpa.create_template', { defaultValue: 'Create template' })}
          </Button>
        </Space>
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

export default RpaRunHistory
