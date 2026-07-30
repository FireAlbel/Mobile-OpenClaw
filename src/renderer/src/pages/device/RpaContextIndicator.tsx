import type { RpaDslProvenance } from '@renderer/services/rpa/RpaRunContextSnapshot'
import { Button, Popover, Space, Tag, Typography } from 'antd'
import { BookOpen, Settings2, Workflow, Wrench } from 'lucide-react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  provenance?: RpaDslProvenance
  onAdjust: () => void
}

const RpaContextIndicator: FC<Props> = ({ provenance, onAdjust }) => {
  const { t } = useTranslation()
  if (!provenance) return null

  return (
    <ContextBar>
      <Space size={4} wrap>
        <Tag icon={<BookOpen size={12} />}>Knowledge {provenance.activeAssetCounts.knowledge}</Tag>
        <Tag icon={<Wrench size={12} />}>Skill {provenance.activeAssetCounts.skills}</Tag>
        <Tag icon={<Workflow size={12} />}>Task Flow {provenance.activeAssetCounts.templates}</Tag>
      </Space>
      <Space size={4}>
        <Popover
          trigger="click"
          placement="bottomRight"
          title={t('device.rpa.dsl_provenance')}
          content={<ProvenanceDetails provenance={provenance} />}>
          <Button type="text" size="small">
            {t('device.rpa.view_context')}
          </Button>
        </Popover>
        <Button type="text" size="small" icon={<Settings2 size={14} />} onClick={onAdjust}>
          {t('device.rpa.adjust_context')}
        </Button>
      </Space>
    </ContextBar>
  )
}

const ProvenanceDetails: FC<{ provenance: RpaDslProvenance }> = ({ provenance }) => {
  const { t } = useTranslation()
  return (
    <Details>
      <DetailRow label={t('device.rpa.assistant_profile_version')} value={`v${provenance.assistantProfileVersion}`} />
      <DetailRow
        label={t('device.rpa.source_template')}
        value={formatAsset(provenance.sourceTemplate) || t('device.rpa.no_source_template')}
      />
      <DetailRow
        label={t('device.rpa.compiled_skills')}
        value={provenance.compiledSkills.map(formatAsset).join(', ') || '-'}
      />
      <DetailRow
        label={t('device.rpa.retrieved_knowledge')}
        value={provenance.retrievedKnowledge.map(formatAsset).join(', ') || '-'}
      />
      <DetailRow label={t('device.rpa.planner_model')} value={formatModel(provenance.models.planner)} />
      <DetailRow label={t('device.rpa.visual_model')} value={formatModel(provenance.models.vision)} />
    </Details>
  )
}

const DetailRow: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <Typography.Text type="secondary">{label}</Typography.Text>
    <Typography.Text>{value}</Typography.Text>
  </div>
)

function formatAsset(asset?: { id: string; version?: string }): string {
  return asset ? `${asset.id}${asset.version ? `@${asset.version}` : ''}` : ''
}

function formatModel(model: { providerId: string; modelId: string }): string {
  return `${model.modelId} | ${model.providerId}`
}

const ContextBar = styled.div`
  display: flex;
  min-height: 32px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
  padding: 4px 0;
  border-bottom: 1px solid var(--color-border);

  .ant-tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-inline-end: 0;
  }
`

const Details = styled.div`
  display: grid;
  min-width: 280px;
  gap: 8px;

  > div {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr);
    gap: 12px;
  }
`

export default RpaContextIndicator
