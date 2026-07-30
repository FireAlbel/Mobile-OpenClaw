import { loggerService } from '@logger'
import FileManager from '@renderer/services/FileManager'
import { rpaArtifactImportRouter } from '@renderer/services/rpa/RpaArtifactImportRouter'
import {
  artifactInputFromFile,
  RPA_ARTIFACT_CATEGORIES,
  type RpaArtifact,
  type RpaArtifactCategory,
  type RpaArtifactLinkTarget,
  rpaArtifactStore
} from '@renderer/services/rpa/RpaArtifactStore'
import type { KnowledgeBase } from '@renderer/types'
import { formatFileSize } from '@renderer/utils'
import { Alert, Button, Empty, Input, message, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd'
import { ExternalLink, FileInput, Link2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('RpaArtifactsView')

interface Props {
  runId?: string
  knowledgeBases: KnowledgeBase[]
}

const RpaArtifactsView: FC<Props> = ({ runId, knowledgeBases }) => {
  const { t } = useTranslation()
  const [artifacts, setArtifacts] = useState<RpaArtifact[]>([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState<RpaArtifactCategory | 'all'>('all')
  const [importing, setImporting] = useState(false)
  const [importArtifact, setImportArtifact] = useState<RpaArtifact>()
  const [importKnowledgeBaseId, setImportKnowledgeBaseId] = useState<string>()
  const [linkArtifact, setLinkArtifact] = useState<RpaArtifact>()
  const [linkTargetType, setLinkTargetType] = useState<RpaArtifactLinkTarget>('bug_report')
  const [linkTargetId, setLinkTargetId] = useState('')
  const [linkRelation, setLinkRelation] = useState('evidence')
  const categoryLabels = useMemo<Record<RpaArtifactCategory, string>>(
    () => ({
      sop_import: t('files.rpa.categories.sop_import'),
      screenshot: t('files.rpa.categories.screenshot'),
      ui_tree: t('files.rpa.categories.ui_tree'),
      ocr_capture: t('files.rpa.categories.ocr_capture'),
      run_log: t('files.rpa.categories.run_log'),
      debug_bundle: t('files.rpa.categories.debug_bundle'),
      exported_dsl: t('files.rpa.categories.exported_dsl'),
      app_reference_image: t('files.rpa.categories.app_reference_image'),
      other: t('files.rpa.categories.other')
    }),
    [t]
  )

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      await rpaArtifactStore.cleanupExpired()
      setArtifacts(runId ? await rpaArtifactStore.findByLink('run', runId) : await rpaArtifactStore.getAll())
    } catch (error) {
      logger.error('Failed to load RPA artifacts', { error, runId })
      message.error(t('files.rpa.load_failed', { defaultValue: 'Failed to load RPA assets.' }))
    } finally {
      setLoading(false)
    }
  }, [runId, t])

  useEffect(() => {
    void reload()
  }, [reload])

  const filteredArtifacts = useMemo(
    () => artifacts.filter((artifact) => category === 'all' || artifact.category === category),
    [artifacts, category]
  )

  const addFiles = async () => {
    try {
      const selected = await FileManager.selectFiles({ properties: ['openFile', 'multiSelections'] })
      if (!selected?.length) return
      const files = await FileManager.addFiles(selected)
      for (const file of files) await rpaArtifactStore.register(artifactInputFromFile(file, { source: 'uploaded' }))
      await reload()
    } catch (error) {
      logger.error('Failed to add files to RPA artifact store', { error })
      message.error(t('files.rpa.add_failed', { defaultValue: 'Failed to add RPA assets.' }))
    }
  }

  const openArtifact = async (artifact: RpaArtifact) => {
    try {
      if (artifact.locator.externalPath) {
        await window.api.file.openPath(artifact.locator.externalPath)
        return
      }
      if (artifact.locator.fileId) {
        const file = await FileManager.getFile(artifact.locator.fileId)
        if (file) await window.api.file.openPath(FileManager.getFilePath(file))
      }
    } catch (error) {
      logger.error('Failed to open RPA artifact', { error, artifactId: artifact.id })
      message.error(t('files.rpa.open_failed', { defaultValue: 'Failed to open RPA asset.' }))
    }
  }

  const startImport = (artifact: RpaArtifact) => {
    if (artifact.category === 'sop_import') {
      setImportKnowledgeBaseId(knowledgeBases[0]?.id)
      setImportArtifact(artifact)
      return
    }
    void executeImport(artifact)
  }

  const executeImport = async (artifact = importArtifact) => {
    if (!artifact) return
    setImporting(true)
    try {
      const result = await rpaArtifactImportRouter.import(artifact, { knowledgeBaseId: importKnowledgeBaseId })
      if (result.target === 'knowledge_draft') {
        message.success(t('files.rpa.knowledge_draft_created', { defaultValue: 'Knowledge draft created.' }))
      } else if (result.target === 'rpa_template_draft') {
        message.success(
          t('files.rpa.rpa_template_draft_ready', {
            defaultValue: 'Validated RPA template draft created.'
          })
        )
      } else {
        message.warning(result.reason)
      }
      setImportArtifact(undefined)
      await reload()
    } catch (error) {
      logger.error('Failed to import RPA artifact', { error, artifactId: artifact.id })
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }

  const saveLink = async () => {
    if (!linkArtifact || !linkTargetId.trim() || !linkRelation.trim()) return
    try {
      await rpaArtifactStore.link(linkArtifact.id, {
        targetType: linkTargetType,
        targetId: linkTargetId,
        relation: linkRelation
      })
      setLinkArtifact(undefined)
      setLinkTargetId('')
      await reload()
    } catch (error) {
      logger.error('Failed to link RPA artifact', { error, artifactId: linkArtifact.id })
      message.error(t('files.rpa.link_failed', { defaultValue: 'Failed to link RPA asset.' }))
    }
  }

  const columns = [
    {
      title: t('files.rpa.asset', { defaultValue: 'RPA asset' }),
      key: 'asset',
      render: (_: unknown, artifact: RpaArtifact) => (
        <AssetTitle>
          <Typography.Text strong>{artifact.title}</Typography.Text>
          <Typography.Text type="secondary">
            {formatFileSize(artifact.sizeBytes)} | {artifact.source}
          </Typography.Text>
        </AssetTitle>
      )
    },
    {
      title: t('files.rpa.category', { defaultValue: 'Category' }),
      dataIndex: 'category',
      width: 140,
      render: (value: RpaArtifactCategory) => <Tag>{categoryLabels[value]}</Tag>
    },
    {
      title: t('files.rpa.links', { defaultValue: 'Links' }),
      key: 'links',
      width: 220,
      render: (_: unknown, artifact: RpaArtifact) => (
        <Space size={[4, 4]} wrap>
          {artifact.links.slice(0, 3).map((link) => (
            <Tag
              key={`${link.targetType}:${link.targetId}:${link.relation}`}>{`${link.targetType}:${link.targetId}`}</Tag>
          ))}
          {artifact.links.length > 3 && <Tag>+{artifact.links.length - 3}</Tag>}
        </Space>
      )
    },
    {
      title: t('files.rpa.policy', { defaultValue: 'Policy' }),
      key: 'policy',
      width: 180,
      render: (_: unknown, artifact: RpaArtifact) => (
        <Space size={4} wrap>
          <Tag color={artifact.policyAction === 'stored' ? 'success' : 'warning'}>{artifact.policyAction}</Tag>
          <Tag color={artifact.redaction.status === 'redacted' ? 'success' : undefined}>
            {artifact.redaction.status}
          </Tag>
        </Space>
      )
    },
    {
      title: t('common.action'),
      key: 'actions',
      width: 160,
      render: (_: unknown, artifact: RpaArtifact) => (
        <Space size={2}>
          <Button
            type="text"
            size="small"
            title={t('common.open')}
            icon={<ExternalLink size={15} />}
            onClick={() => void openArtifact(artifact)}
          />
          <Button
            type="text"
            size="small"
            title={t('files.rpa.import', { defaultValue: 'Import' })}
            icon={<FileInput size={15} />}
            onClick={() => startImport(artifact)}
          />
          <Button
            type="text"
            size="small"
            title={t('files.rpa.link', { defaultValue: 'Link' })}
            icon={<Link2 size={15} />}
            onClick={() => setLinkArtifact(artifact)}
          />
          <Popconfirm
            title={t('files.rpa.remove_metadata_confirm', {
              defaultValue: 'Remove this asset record? The underlying file will not be deleted.'
            })}
            onConfirm={async () => {
              await rpaArtifactStore.removeMetadata(artifact.id)
              await reload()
            }}>
            <Button danger type="text" size="small" icon={<Trash2 size={15} />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <Container>
      <Toolbar>
        <div>
          <Typography.Text strong>{t('files.rpa.title', { defaultValue: 'RPA evidence and assets' })}</Typography.Text>
          <Typography.Text type="secondary">
            {runId
              ? t('files.rpa.filtered_run', { defaultValue: 'Evidence linked to run {{runId}}', runId })
              : t('files.rpa.hint', {
                  defaultValue:
                    'Files are referenced, categorized, redacted, and retained without duplicate persistence.'
                })}
          </Typography.Text>
        </div>
        <Space>
          <Button icon={<RefreshCw size={15} />} onClick={() => void reload()} />
          <Button type="primary" icon={<Plus size={16} />} onClick={() => void addFiles()}>
            {t('files.rpa.add', { defaultValue: 'Add RPA asset' })}
          </Button>
        </Space>
      </Toolbar>
      <FilterRow>
        <Select
          value={category}
          onChange={setCategory}
          options={[
            { value: 'all', label: t('files.rpa.all_categories') },
            ...RPA_ARTIFACT_CATEGORIES.map((value) => ({ value, label: categoryLabels[value] }))
          ]}
        />
        <Typography.Text type="secondary">
          {t('files.rpa.asset_count', { defaultValue: '{{count}} asset(s)', count: filteredArtifacts.length })}
        </Typography.Text>
      </FilterRow>
      {artifacts.some((artifact) => artifact.redaction.status === 'required') && (
        <Alert
          type="warning"
          showIcon
          message={t('files.rpa.redaction_required', {
            defaultValue: 'Some sensitive evidence requires redaction before sharing.'
          })}
        />
      )}
      {loading ? null : filteredArtifacts.length ? (
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={filteredArtifacts}
          pagination={{ pageSize: 12 }}
        />
      ) : (
        <Empty description={t('files.rpa.empty', { defaultValue: 'No RPA assets.' })} />
      )}

      <Modal
        open={Boolean(importArtifact)}
        title={t('files.rpa.import_sop', { defaultValue: 'Import SOP into Knowledge' })}
        confirmLoading={importing}
        okButtonProps={{ disabled: !importKnowledgeBaseId }}
        onOk={() => void executeImport()}
        onCancel={() => setImportArtifact(undefined)}>
        <ModalForm>
          <Typography.Text type="secondary">
            {t('files.rpa.import_sop_hint', {
              defaultValue: 'The imported entry remains a draft until a human reviews it.'
            })}
          </Typography.Text>
          <Select
            value={importKnowledgeBaseId}
            placeholder={t('files.rpa.select_knowledge', { defaultValue: 'Select Knowledge base' })}
            options={knowledgeBases.map((base) => ({ value: base.id, label: base.name }))}
            onChange={setImportKnowledgeBaseId}
          />
        </ModalForm>
      </Modal>

      <Modal
        open={Boolean(linkArtifact)}
        title={t('files.rpa.link_asset', { defaultValue: 'Link RPA asset' })}
        okButtonProps={{ disabled: !linkTargetId.trim() || !linkRelation.trim() }}
        onOk={() => void saveLink()}
        onCancel={() => setLinkArtifact(undefined)}>
        <ModalForm>
          <Select
            value={linkTargetType}
            options={['run', 'device_run', 'knowledge', 'rpa_template', 'bug_report'].map((value) => ({
              value,
              label: value
            }))}
            onChange={setLinkTargetType}
          />
          <Input
            value={linkTargetId}
            placeholder="Target ID"
            onChange={(event) => setLinkTargetId(event.target.value)}
          />
          <Input
            value={linkRelation}
            placeholder="Relation"
            onChange={(event) => setLinkRelation(event.target.value)}
          />
        </ModalForm>
      </Modal>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
`

const Toolbar = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;

  > div {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 3px;
  }
`

const FilterRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  .ant-select {
    width: 200px;
  }
`

const AssetTitle = styled.div`
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
`

const ModalForm = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
`

export default RpaArtifactsView
