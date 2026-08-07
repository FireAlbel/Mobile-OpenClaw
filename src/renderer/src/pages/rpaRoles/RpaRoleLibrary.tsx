import { loggerService } from '@logger'
import {
  createDefaultRpaAppRole,
  type RpaAppRole,
  rpaAppRoleRepository,
  sanitizeRpaAppRole
} from '@renderer/services/rpa/RpaAppRole'
import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import { rpaRolePromptRepository } from '@renderer/services/rpa/RpaRolePrompt'
import { createRpaRoleSessionPath } from '@renderer/services/rpa/RpaRoleSessionNavigation'
import {
  buildRpaRoleWorkspaceSummary,
  type RpaRoleWorkspaceSummary
} from '@renderer/services/rpa/RpaRoleWorkspaceService'
import { rpaSkillRepository } from '@renderer/services/rpa/RpaSkillRepository'
import { useAppSelector } from '@renderer/store'
import {
  Button,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload
} from 'antd'
import { Copy, Download, Pencil, Play, Plus, Trash2, Upload as UploadIcon } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import { rpaRoleAssetLabel } from './rpaRoleI18n'

const logger = loggerService.withContext('RpaRoleLibrary')

interface RoleRow extends RpaAppRole {
  summary: RpaRoleWorkspaceSummary
}

const RpaRoleLibrary: FC = () => {
  const { t } = useTranslation()
  const translate = useEffectEvent(t)
  const navigate = useNavigate()
  const knowledgeBases = useAppSelector((state) => state.knowledge.bases)
  const [roles, setRoles] = useState<RpaAppRole[]>([])
  const [rows, setRows] = useState<RoleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [form] = Form.useForm<{ name: string; appPackage?: string }>()

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      await rpaBatchRunner.initialize()
      const [nextRoles, skills, prompts] = await Promise.all([
        rpaAppRoleRepository.getAll(),
        rpaSkillRepository.getAll(),
        rpaRolePromptRepository.getAll()
      ])
      const runs = rpaBatchRunner.getRuns()
      const catalogs = {
        knowledgeIds: knowledgeBases.map((base) => base.id),
        skillIds: skills.map((skill) => skill.id),
        artifactIds: [],
        promptIds: prompts.map((prompt) => prompt.id)
      }
      setRoles(nextRoles)
      setRows(
        nextRoles.map((role) => ({
          ...role,
          summary: buildRpaRoleWorkspaceSummary({ role, roles: nextRoles, catalogs, runs })
        }))
      )
    } catch (error) {
      logger.error('Failed to load RPA Roles', { error })
      message.error(translate('rpa_roles.messages.load_failed'))
    } finally {
      setLoading(false)
    }
    // Effect Events intentionally stay outside reactive dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knowledgeBases])

  useEffect(() => {
    void reload()
  }, [reload])

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase()
    return query
      ? rows.filter((role) =>
          `${role.name} ${role.description ?? ''} ${role.appPackages.join(' ')}`.toLowerCase().includes(query)
        )
      : rows
  }, [rows, search])

  const createRole = async () => {
    const values = await form.validateFields()
    const now = Date.now()
    const id = uniqueRoleId(values.name, roles)
    await rpaAppRoleRepository.save({
      ...createDefaultRpaAppRole(id, values.name, now),
      appPackages: values.appPackage?.trim() ? [values.appPackage.trim()] : []
    })
    form.resetFields()
    setCreateOpen(false)
    await reload()
    navigate(`/rpa-roles/${id}`)
  }

  const duplicate = async (role: RpaAppRole) => {
    const id = uniqueRoleId(`${role.id}-copy`, roles)
    await rpaAppRoleRepository.duplicate(role.id, id, t('rpa_roles.library.copy_name', { name: role.name }))
    await reload()
  }

  const remove = async (role: RoleRow) => {
    if (role.summary.activeRunIds.length) {
      message.error(t('rpa_roles.messages.active_role_delete_blocked'))
      return
    }
    await rpaAppRoleRepository.remove(role.id)
    await reload()
  }

  const exportRole = async (role: RpaAppRole) => {
    await window.api.file.save(`${safeFileName(role.name)}.role.json`, JSON.stringify(role, null, 2))
  }

  const importRole = async (file: File) => {
    try {
      const parsed = sanitizeRpaAppRole(JSON.parse(await file.text()))
      if (!parsed) throw new Error(t('rpa_roles.messages.invalid_json'))
      if (roles.some((role) => role.id === parsed.id)) {
        throw new Error(t('rpa_roles.messages.already_exists', { id: parsed.id }))
      }
      await rpaAppRoleRepository.save(parsed)
      await reload()
      message.success(t('rpa_roles.messages.imported'))
    } catch (error) {
      logger.warn('Failed to import RPA Role', { error, fileName: file.name })
      message.error(error instanceof Error ? error.message : t('rpa_roles.messages.import_failed'))
    }
    return false
  }

  const columns = [
    {
      title: t('rpa_roles.columns.role'),
      key: 'role',
      width: 320,
      render: (_: unknown, role: RoleRow) => (
        <NameCell>
          <Typography.Text strong>{role.name}</Typography.Text>
          <VersionTag>v{role.version}</VersionTag>
        </NameCell>
      )
    },
    {
      title: t('rpa_roles.columns.assets'),
      key: 'assets',
      width: 220,
      render: (_: unknown, role: RoleRow) => (
        <Typography.Text type="secondary">
          {Object.entries(role.summary.assetCounts)
            .filter(([, count]) => count > 0)
            .map(([type, count]) => `${rpaRoleAssetLabel(t, type)} ${count}`)
            .join(' · ') || t('rpa_roles.library.no_assets')}
        </Typography.Text>
      )
    },
    {
      title: t('rpa_roles.columns.health'),
      key: 'health',
      width: 180,
      render: (_: unknown, role: RoleRow) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>
            {t('rpa_roles.library.broken_bindings', { count: role.summary.brokenBindings.length })}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t('rpa_roles.library.active_runs', { count: role.summary.activeRunIds.length })}
          </Typography.Text>
        </Space>
      )
    },
    {
      title: t('rpa_roles.columns.updated'),
      dataIndex: 'updatedAt',
      width: 170,
      render: (value: number) => new Date(value).toLocaleString()
    },
    {
      title: t('rpa_roles.columns.actions'),
      key: 'actions',
      width: 250,
      render: (_: unknown, role: RoleRow) => (
        <Space size={2}>
          <Tooltip title={t('rpa_roles.actions.start_session')}>
            <Button
              type="text"
              aria-label={t('rpa_roles.actions.start_session')}
              icon={<Play size={16} />}
              onClick={() => navigate(createRpaRoleSessionPath(role.id))}
            />
          </Tooltip>
          <Tooltip title={t('rpa_roles.actions.edit')}>
            <Button type="text" icon={<Pencil size={16} />} onClick={() => navigate(`/rpa-roles/${role.id}`)} />
          </Tooltip>
          <Tooltip title={t('rpa_roles.actions.duplicate')}>
            <Button type="text" icon={<Copy size={16} />} onClick={() => void duplicate(role)} />
          </Tooltip>
          <Tooltip title={t('rpa_roles.actions.export')}>
            <Button type="text" icon={<Download size={16} />} onClick={() => void exportRole(role)} />
          </Tooltip>
          <Popconfirm title={t('rpa_roles.actions.delete_confirm')} onConfirm={() => void remove(role)}>
            <Button
              type="text"
              danger
              disabled={Boolean(role.summary.activeRunIds.length)}
              icon={<Trash2 size={16} />}
            />
          </Popconfirm>
        </Space>
      )
    }
  ]

  return (
    <Root>
      <Toolbar>
        <Space>
          <Input.Search
            allowClear
            placeholder={t('rpa_roles.library.search_placeholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Upload accept=".json" showUploadList={false} beforeUpload={importRole}>
            <Button icon={<UploadIcon size={16} />}>{t('rpa_roles.actions.import')}</Button>
          </Upload>
          <Button type="primary" icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
            {t('rpa_roles.actions.new_role')}
          </Button>
        </Space>
      </Toolbar>
      {loading || filteredRows.length ? (
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={filteredRows}
          pagination={{ pageSize: 12 }}
          scroll={{ x: 1140 }}
        />
      ) : (
        <Empty description={t('rpa_roles.library.empty')} />
      )}
      <Modal
        title={t('rpa_roles.create.title')}
        open={createOpen}
        okText={t('rpa_roles.actions.create')}
        onOk={() => void createRole()}
        onCancel={() => setCreateOpen(false)}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('rpa_roles.form.role_name')} rules={[{ required: true }]}>
            <Input placeholder={t('rpa_roles.create.name_placeholder')} />
          </Form.Item>
          <Form.Item name="appPackage" label={t('rpa_roles.form.primary_app_package')}>
            <Input placeholder="com.sankuai.meituan" />
          </Form.Item>
        </Form>
      </Modal>
    </Root>
  )
}

function uniqueRoleId(value: string, roles: RpaAppRole[]): string {
  const base =
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'rpa-role'
  const ids = new Set(roles.map((role) => role.id))
  let candidate = base
  let index = 2
  while (ids.has(candidate)) candidate = `${base}-${index++}`
  return candidate
}

function safeFileName(value: string): string {
  const sanitized = [...value]
    .map((character) => (character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '_' : character))
    .join('')
    .trim()
  return sanitized || 'rpa-role'
}

const Root = styled.div`
  display: flex;
  width: 100%;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  overflow: hidden;

  .ant-table-wrapper {
    width: 100%;
    min-width: 0;
  }
`

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  flex-wrap: wrap;

  .ant-typography {
    margin: 0;
  }

  .ant-input-search {
    width: min(240px, 55vw);
  }
`

const NameCell = styled.div`
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 5px;
`

const VersionTag = styled(Tag)`
  width: fit-content;
  margin-inline-end: 0;
  align-self: flex-start;
`

export default RpaRoleLibrary
