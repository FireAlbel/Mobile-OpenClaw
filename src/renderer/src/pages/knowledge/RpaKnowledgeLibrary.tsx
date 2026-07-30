import { loggerService } from '@logger'
import {
  createRpaTemplateAssetCatalog,
  type RpaSkillAssetCatalogItem,
  type RpaTemplateAssetCatalogItem
} from '@renderer/services/rpa/RpaAssistantAssetCatalog'
import {
  createDefaultRpaKnowledgeEntry,
  redactRpaKnowledgeText,
  RPA_KNOWLEDGE_CATEGORIES,
  type RpaKnowledgeCategory,
  type RpaKnowledgeEntry,
  rpaKnowledgeRepository
} from '@renderer/services/rpa/RpaKnowledge'
import { rpaSkillRepository } from '@renderer/services/rpa/RpaSkillRepository'
import { rpaTemplateRepository } from '@renderer/services/rpa/RpaTemplateRepository'
import type { KnowledgeBase } from '@renderer/types'
import {
  Alert,
  Button,
  Empty,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography
} from 'antd'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

const logger = loggerService.withContext('RpaKnowledgeLibrary')

interface Props {
  selectedBase: KnowledgeBase
  onCountChange?: (count: number) => void
}

const categoryLabels: Record<RpaKnowledgeCategory, string> = {
  app_sop: 'App SOP',
  page_state_explanation: 'Page state',
  locator_guidance: 'Locator guidance',
  failure_case: 'Failure case',
  recovery_guidance: 'Recovery guidance',
  version_note: 'Version note',
  policy_note: 'Policy note'
}

const RpaKnowledgeLibrary: FC<Props> = ({ selectedBase, onCountChange }) => {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<RpaKnowledgeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<RpaKnowledgeEntry>()
  const [templateCatalog, setTemplateCatalog] = useState<RpaTemplateAssetCatalogItem[]>([])
  const [skillCatalog, setSkillCatalog] = useState<RpaSkillAssetCatalogItem[]>([])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [next, templates, skills] = await Promise.all([
        rpaKnowledgeRepository.getByKnowledgeBaseId(selectedBase.id),
        rpaTemplateRepository.getAll(),
        rpaSkillRepository.toCatalog()
      ])
      setEntries(next)
      setTemplateCatalog(createRpaTemplateAssetCatalog(templates))
      setSkillCatalog(skills)
      onCountChange?.(next.length)
    } catch (error) {
      logger.error('Failed to load RPA knowledge entries', { error, knowledgeBaseId: selectedBase.id })
      message.error(t('knowledge.rpa.load_failed', { defaultValue: 'Failed to load RPA knowledge.' }))
    } finally {
      setLoading(false)
    }
  }, [onCountChange, selectedBase.id, t])

  useEffect(() => {
    void reload()
  }, [reload])

  const saveDraft = async () => {
    if (!draft?.title.trim()) return
    setSaving(true)
    try {
      const summary = redactRpaKnowledgeText(draft.summary, 2_000)
      const content = redactRpaKnowledgeText(draft.content, 12_000)
      await rpaKnowledgeRepository.save({
        ...draft,
        knowledgeBaseId: selectedBase.id,
        summary: summary.text,
        content: content.text,
        redactions: [...new Set([...draft.redactions, ...summary.redactions, ...content.redactions])]
      })
      setDraft(undefined)
      await reload()
      message.success(t('knowledge.rpa.saved', { defaultValue: 'RPA knowledge saved.' }))
    } catch (error) {
      logger.error('Failed to save RPA knowledge entry', { error, entryId: draft.id })
      message.error(t('knowledge.rpa.save_failed', { defaultValue: 'Failed to save RPA knowledge.' }))
    } finally {
      setSaving(false)
    }
  }

  const removeEntry = async (id: string) => {
    try {
      await rpaKnowledgeRepository.remove(id)
      await reload()
    } catch (error) {
      logger.error('Failed to remove RPA knowledge entry', { error, entryId: id })
      message.error(t('knowledge.rpa.delete_failed', { defaultValue: 'Failed to delete RPA knowledge.' }))
    }
  }

  const columns = [
    {
      title: t('knowledge.rpa.entry', { defaultValue: 'SOP / Experience' }),
      key: 'entry',
      render: (_: unknown, entry: RpaKnowledgeEntry) => (
        <EntryTitle>
          <Typography.Text strong>{entry.title}</Typography.Text>
          <Typography.Text type="secondary" ellipsis>
            {entry.summary || entry.content}
          </Typography.Text>
          {entry.improvementSuggestions.some((suggestion) => suggestion.status === 'pending') && (
            <Tag color="processing">
              {t('knowledge.rpa.pending_improvements', {
                defaultValue: '{{count}} pending improvement(s)',
                count: entry.improvementSuggestions.filter((suggestion) => suggestion.status === 'pending').length
              })}
            </Tag>
          )}
        </EntryTitle>
      )
    },
    {
      title: t('knowledge.rpa.category', { defaultValue: 'Category' }),
      dataIndex: 'category',
      width: 150,
      render: (category: RpaKnowledgeCategory) => <Tag>{categoryLabels[category]}</Tag>
    },
    {
      title: t('knowledge.rpa.scope', { defaultValue: 'Scope' }),
      key: 'scope',
      width: 220,
      render: (_: unknown, entry: RpaKnowledgeEntry) => (
        <Space size={[4, 4]} wrap>
          {entry.scope.appPackages.slice(0, 2).map((value) => (
            <Tag key={value}>{value}</Tag>
          ))}
          {entry.scope.errorClasses.slice(0, 1).map((value) => (
            <Tag color="error" key={value}>
              {value}
            </Tag>
          ))}
        </Space>
      )
    },
    {
      title: t('knowledge.rpa.review_status', { defaultValue: 'Review' }),
      dataIndex: 'reviewStatus',
      width: 110,
      render: (status: RpaKnowledgeEntry['reviewStatus']) => (
        <Tag color={status === 'reviewed' ? 'success' : status === 'rejected' ? 'error' : 'warning'}>{status}</Tag>
      )
    },
    {
      title: t('common.action'),
      key: 'actions',
      width: 90,
      render: (_: unknown, entry: RpaKnowledgeEntry) => (
        <Space size={2}>
          <Button type="text" size="small" icon={<Pencil size={15} />} onClick={() => setDraft(entry)} />
          <Popconfirm title={t('common.delete_confirm')} onConfirm={() => void removeEntry(entry.id)}>
            <Button danger type="text" size="small" icon={<Trash2 size={15} />} />
          </Popconfirm>
        </Space>
      )
    }
  ]

  const missingLinks = draft ? findMissingLinks(draft, templateCatalog, skillCatalog) : []

  return (
    <Container>
      <Toolbar>
        <div>
          <Typography.Text strong>
            {t('knowledge.rpa.title', { defaultValue: 'RPA SOP and experience library' })}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t('knowledge.rpa.hint', {
              defaultValue:
                'Reviewed guidance may be used by Planner and Recovery. Executable behavior remains in Skills.'
            })}
          </Typography.Text>
        </div>
        <Button
          type="primary"
          icon={<Plus size={16} />}
          onClick={() => setDraft(createDefaultRpaKnowledgeEntry(selectedBase.id))}>
          {t('knowledge.rpa.add', { defaultValue: 'Add SOP / experience' })}
        </Button>
      </Toolbar>
      {loading ? (
        <LoadingArea>
          <Spin />
        </LoadingArea>
      ) : entries.length ? (
        <Table rowKey="id" size="small" pagination={{ pageSize: 10 }} columns={columns} dataSource={entries} />
      ) : (
        <Empty description={t('knowledge.rpa.empty', { defaultValue: 'No RPA SOP or experience entries.' })} />
      )}

      <Modal
        open={Boolean(draft)}
        width={760}
        title={t('knowledge.rpa.editor', { defaultValue: 'RPA knowledge editor' })}
        okText={t('common.save')}
        confirmLoading={saving}
        okButtonProps={{ disabled: !draft?.title.trim() }}
        onOk={() => void saveDraft()}
        onCancel={() => setDraft(undefined)}>
        {draft && (
          <Editor>
            {missingLinks.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={t('knowledge.rpa.missing_links', {
                  defaultValue: 'Some linked Templates or Skills are unavailable: {{links}}',
                  links: missingLinks.join(', ')
                })}
              />
            )}
            {draft.redactions.length > 0 && (
              <Alert
                type="info"
                showIcon
                message={t('knowledge.rpa.redacted', {
                  defaultValue: 'Sensitive fields were redacted: {{fields}}',
                  fields: draft.redactions.join(', ')
                })}
              />
            )}
            <Field label={t('common.title')}>
              <Input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </Field>
            <EditorGrid>
              <Field label={t('knowledge.rpa.category', { defaultValue: 'Category' })}>
                <Select
                  value={draft.category}
                  options={RPA_KNOWLEDGE_CATEGORIES.map((category) => ({
                    value: category,
                    label: categoryLabels[category]
                  }))}
                  onChange={(category) => setDraft({ ...draft, category })}
                />
              </Field>
              <Field label={t('knowledge.rpa.review_status', { defaultValue: 'Review status' })}>
                <Select
                  value={draft.reviewStatus}
                  options={['draft', 'reviewed', 'rejected'].map((value) => ({ value, label: value }))}
                  onChange={(reviewStatus) => setDraft({ ...draft, reviewStatus })}
                />
              </Field>
              <Field label={t('knowledge.rpa.confidence', { defaultValue: 'Confidence' })}>
                <InputNumber
                  min={0}
                  max={1}
                  step={0.05}
                  value={draft.confidence}
                  onChange={(confidence) => setDraft({ ...draft, confidence: confidence ?? 0.5 })}
                />
              </Field>
            </EditorGrid>
            <Field label={t('knowledge.rpa.summary', { defaultValue: 'Planner / Recovery summary' })}>
              <Input.TextArea
                rows={3}
                value={draft.summary}
                onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
              />
            </Field>
            <Field label={t('knowledge.rpa.content', { defaultValue: 'Reviewed details' })}>
              <Input.TextArea
                rows={6}
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              />
            </Field>
            <TagFields draft={draft} onChange={setDraft} />
          </Editor>
        )}
      </Modal>
    </Container>
  )
}

const Field: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <FieldContainer>
    <Typography.Text>{label}</Typography.Text>
    {children}
  </FieldContainer>
)

const TagFields: FC<{ draft: RpaKnowledgeEntry; onChange: (entry: RpaKnowledgeEntry) => void }> = ({
  draft,
  onChange
}) => (
  <>
    <EditorGrid>
      <TagSelectField
        label="App packages"
        value={draft.scope.appPackages}
        onChange={(appPackages) => onChange({ ...draft, scope: { ...draft.scope, appPackages } })}
      />
      <TagSelectField
        label="Task goals"
        value={draft.scope.taskGoals}
        onChange={(taskGoals) => onChange({ ...draft, scope: { ...draft.scope, taskGoals } })}
      />
      <TagSelectField
        label="State IDs"
        value={draft.scope.stateIds}
        onChange={(stateIds) => onChange({ ...draft, scope: { ...draft.scope, stateIds } })}
      />
      <TagSelectField
        label="Error classes"
        value={draft.scope.errorClasses}
        onChange={(errorClasses) => onChange({ ...draft, scope: { ...draft.scope, errorClasses } })}
      />
      <TagSelectField
        label="Template IDs"
        value={draft.links.templateIds}
        onChange={(templateIds) => onChange({ ...draft, links: { ...draft.links, templateIds } })}
      />
      <TagSelectField
        label="Skill ID@version"
        value={draft.links.skills.map((skill) => `${skill.skillId}${skill.version ? `@${skill.version}` : ''}`)}
        onChange={(values) => onChange({ ...draft, links: { ...draft.links, skills: parseSkillLinks(values) } })}
      />
      <TagSelectField
        label="Failure fingerprint IDs"
        value={draft.links.failureFingerprintIds}
        onChange={(failureFingerprintIds) => onChange({ ...draft, links: { ...draft.links, failureFingerprintIds } })}
      />
      <TagSelectField
        label="Artifact IDs"
        value={draft.links.artifactIds}
        onChange={(artifactIds) => onChange({ ...draft, links: { ...draft.links, artifactIds } })}
      />
    </EditorGrid>
  </>
)

const TagSelectField: FC<{ label: string; value: string[]; onChange: (value: string[]) => void }> = ({
  label,
  value,
  onChange
}) => (
  <Field label={label}>
    <Select mode="tags" tokenSeparators={[',']} value={value} onChange={onChange} />
  </Field>
)

function parseSkillLinks(values: string[]): RpaKnowledgeEntry['links']['skills'] {
  return values.flatMap((value) => {
    const separator = value.lastIndexOf('@')
    const skillId = (separator > 0 ? value.slice(0, separator) : value).trim()
    const version = separator > 0 ? value.slice(separator + 1).trim() : undefined
    return skillId ? [{ skillId, version: version || undefined }] : []
  })
}

function findMissingLinks(
  entry: RpaKnowledgeEntry,
  templates: RpaTemplateAssetCatalogItem[],
  skills: RpaSkillAssetCatalogItem[]
): string[] {
  const templateIds = new Set(templates.map((template) => template.id))
  const skillIds = new Set(skills.map((skill) => skill.id))
  return [
    ...entry.links.templateIds.filter((id) => !templateIds.has(id)).map((id) => `Template:${id}`),
    ...entry.links.skills.filter((link) => !skillIds.has(link.skillId)).map((link) => `Skill:${link.skillId}`)
  ]
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
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

const LoadingArea = styled.div`
  display: flex;
  justify-content: center;
  padding: 48px;
`

const EntryTitle = styled.div`
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
`

const Editor = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
`

const EditorGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;

  @media (max-width: 700px) {
    grid-template-columns: 1fr;
  }
`

const FieldContainer = styled.label`
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;

  .ant-select,
  .ant-input-number {
    width: 100%;
  }
`

export default RpaKnowledgeLibrary
