import { loggerService } from '@logger'
import type { RpaChatTemplateSaveMode, RpaChatTemplateSource } from '@renderer/services/rpa/RpaChatTemplateSaveService'
import { rpaChatTemplateSaveService } from '@renderer/services/rpa/RpaChatTemplateSaveService'
import { defaultRpaModuleRegistry } from '@renderer/services/rpa/RpaDefaultRegistry'
import { RpaTaskValidator } from '@renderer/services/rpa/RpaTaskValidator'
import type { RpaTemplateRecord } from '@renderer/services/rpa/RpaTemplateRepository'
import { rpaTemplateRepository } from '@renderer/services/rpa/RpaTemplateRepository'
import { Alert, Input, message, Modal, Segmented, Select, Space, Tag, Typography } from 'antd'
import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import styled from 'styled-components'

const logger = loggerService.withContext('RpaSaveToTemplateModal')
const validator = new RpaTaskValidator(defaultRpaModuleRegistry, { requireDeviceIds: false })

export interface RpaChatTemplateLink {
  templateId: string
  name: string
  version: number
  status: RpaTemplateRecord['status']
  linkedAt: number
}

interface Props {
  open: boolean
  dsl: unknown
  defaultName: string
  defaultGoal: string
  source: RpaChatTemplateSource
  linkedTemplateId?: string
  onCancel: () => void
  onSaved: (link: RpaChatTemplateLink) => Promise<void>
}

const RpaSaveToTemplateModal: FC<Props> = ({
  open,
  dsl,
  defaultName,
  defaultGoal,
  source,
  linkedTemplateId,
  onCancel,
  onSaved
}) => {
  const [templates, setTemplates] = useState<RpaTemplateRecord[]>([])
  const [mode, setMode] = useState<RpaChatTemplateSaveMode>('new')
  const [targetId, setTargetId] = useState<string>()
  const [name, setName] = useState(defaultName)
  const [tagsText, setTagsText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [conflictIds, setConflictIds] = useState<string[]>([])
  const validation = useMemo(() => validator.validate(dsl), [dsl])
  const nameConflicts = useMemo(
    () => templates.filter((template) => template.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase()),
    [name, templates]
  )

  useEffect(() => {
    if (!open) return
    setName(defaultName)
    setConflictIds([])
    setMode(linkedTemplateId ? 'new_version' : 'new')
    setTargetId(linkedTemplateId)
    void rpaTemplateRepository
      .getAll()
      .then((records) => {
        setTemplates(records)
        const linked = linkedTemplateId ? records.find((template) => template.id === linkedTemplateId) : undefined
        if (linked) {
          setName(linked.name)
          setTagsText(linked.tags.join(', '))
        } else {
          setTagsText('')
        }
      })
      .catch((error) => {
        logger.error('Failed to load templates for chat save', { error })
        message.error('加载 RPA 模板失败')
      })
  }, [defaultName, linkedTemplateId, open])

  useEffect(() => {
    if (mode === 'new' || targetId) return
    setTargetId(nameConflicts[0]?.id ?? templates[0]?.id)
  }, [mode, nameConflicts, targetId, templates])

  const submit = async () => {
    setSubmitting(true)
    try {
      const result = await rpaChatTemplateSaveService.save({
        mode,
        name,
        goal: defaultGoal,
        tags: tagsText
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        dsl,
        targetTemplateId: targetId,
        source
      })
      if (result.status === 'name_conflict') {
        setConflictIds(result.conflicts.map((template) => template.id))
        message.warning('存在同名模板，请重命名，或选择覆盖/保存新版本')
        return
      }
      await onSaved({
        templateId: result.template.id,
        name: result.template.name,
        version: result.template.version,
        status: result.template.status,
        linkedAt: Date.now()
      })
      message.success(result.template.status === 'executable' ? '已保存到 RPA 模板' : '已保存为不可执行草稿')
    } catch (error) {
      logger.error('Failed to save chat RPA task as a template', { error, messageId: source.messageId })
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  const showConflict = mode === 'new' && (conflictIds.length > 0 || nameConflicts.length > 0)
  const selectTarget = (id: string) => {
    setTargetId(id)
    const target = templates.find((template) => template.id === id)
    if (target) {
      setName(target.name)
      setTagsText(target.tags.join(', '))
    }
  }

  return (
    <Modal
      open={open}
      title="保存到 RPA 模板"
      width={620}
      okText={mode === 'overwrite' ? '覆盖模板' : mode === 'new_version' ? '保存新版本' : '新建模板'}
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ disabled: !name.trim() || (mode !== 'new' && !targetId) }}
      onCancel={onCancel}
      onOk={() => void submit()}>
      <Form>
        <label>
          <Typography.Text type="secondary">保存方式</Typography.Text>
          <Segmented
            block
            value={mode}
            options={[
              { label: '新建模板', value: 'new' },
              { label: '覆盖模板', value: 'overwrite' },
              { label: '保存新版本', value: 'new_version' }
            ]}
            onChange={(value) => {
              setMode(value as RpaChatTemplateSaveMode)
              setConflictIds([])
            }}
          />
        </label>
        {mode !== 'new' && (
          <label>
            <Typography.Text type="secondary">目标模板</Typography.Text>
            <Select
              showSearch
              value={targetId}
              onChange={selectTarget}
              options={templates.map((template) => ({
                value: template.id,
                label: `${template.name} (v${template.version})`
              }))}
            />
          </label>
        )}
        <label>
          <Typography.Text type="secondary">模板名称</Typography.Text>
          <Input
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setConflictIds([])
            }}
          />
        </label>
        <label>
          <Typography.Text type="secondary">标签</Typography.Text>
          <Input value={tagsText} placeholder="使用逗号分隔" onChange={(event) => setTagsText(event.target.value)} />
        </label>
        {showConflict && (
          <Alert
            type="warning"
            showIcon
            message="发现同名模板"
            description="修改名称以新建模板，或选择覆盖模板/保存新版本。"
          />
        )}
        <Alert
          type={validation.success ? 'success' : 'warning'}
          showIcon
          message={
            validation.success
              ? 'DSL 校验通过，保存后可执行'
              : `DSL 有 ${validation.issues.length} 个问题，将保存为不可执行草稿`
          }
          description={
            validation.issues
              .slice(0, 3)
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join('\n') || undefined
          }
        />
        <Space size={[4, 4]} wrap>
          <Tag>{source.topicId}</Tag>
          <Tag>{source.messageId}</Tag>
        </Space>
      </Form>
    </Modal>
  )
}

const Form = styled.div`
  display: flex; flex-direction: column; gap: 14px; padding-top: 4px;
  label { display: flex; flex-direction: column; gap: 6px; }
  .ant-select { width: 100%; }
`

export default RpaSaveToTemplateModal
