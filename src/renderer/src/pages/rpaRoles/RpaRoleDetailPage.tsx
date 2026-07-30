import { loggerService } from '@logger'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import FileManager from '@renderer/services/FileManager'
import {
  RPA_APP_ROLE_ASSET_TYPES,
  type RpaAppRole,
  type RpaAppRoleAssetBinding,
  type RpaAppRoleAssetOwnership,
  type RpaAppRoleAssetRequirement,
  type RpaAppRoleAssetType,
  rpaAppRoleRepository
} from '@renderer/services/rpa/RpaAppRole'
import { artifactInputFromFile, type RpaArtifact, rpaArtifactStore } from '@renderer/services/rpa/RpaArtifactStore'
import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import {
  RPA_ROLE_PROMPT_KINDS,
  type RpaRolePrompt,
  type RpaRolePromptKind,
  rpaRolePromptRepository
} from '@renderer/services/rpa/RpaRolePrompt'
import {
  buildRpaRoleWorkspaceSummary,
  type RpaRoleWorkspaceCatalogs,
  type RpaRoleWorkspaceSummary
} from '@renderer/services/rpa/RpaRoleWorkspaceService'
import { type RpaSkillRecord, rpaSkillRepository } from '@renderer/services/rpa/RpaSkillRepository'
import { useAppSelector } from '@renderer/store'
import {
  Alert,
  Button,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tabs,
  Typography
} from 'antd'
import type { TFunction } from 'i18next'
import { ArrowLeft, FileUp, FolderOpen, Plus, Save, Trash2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import styled from 'styled-components'

import {
  rpaRoleAssetLabel,
  rpaRoleOwnershipLabel,
  rpaRolePromptKindLabel,
  rpaRoleRequirementLabel
} from './rpaRoleI18n'

const logger = loggerService.withContext('RpaRoleDetailPage')

interface RoleFormValues {
  name: string
  description?: string
}

interface CatalogItem {
  id: string
  label: string
  version?: string
}

type RoleCatalog = Record<RpaAppRoleAssetType, CatalogItem[]>

const RpaRoleDetailPage: FC = () => {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const translate = useEffectEvent(t)
  const knowledgeBases = useAppSelector((state) => state.knowledge.bases)
  const [form] = Form.useForm<RoleFormValues>()
  const [role, setRole] = useState<RpaAppRole>()
  const [catalog, setCatalog] = useState<RoleCatalog>(emptyCatalog)
  const [prompts, setPrompts] = useState<RpaRolePrompt[]>([])
  const [summary, setSummary] = useState<RpaRoleWorkspaceSummary>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [bindingType, setBindingType] = useState<RpaAppRoleAssetType>('knowledge')
  const [bindingOpen, setBindingOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [bindingForm] = Form.useForm<RpaAppRoleAssetBinding>()
  const [promptForm] = Form.useForm<{
    id: string
    kind: RpaRolePromptKind
    content: string
    capability?: string
    priority: number
  }>()

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      await rpaBatchRunner.initialize()
      const [allRoles, skills, artifacts, allPrompts] = await Promise.all([
        rpaAppRoleRepository.getAll(),
        rpaSkillRepository.getAll(),
        rpaArtifactStore.getAll(),
        rpaRolePromptRepository.getAll()
      ])
      const current = allRoles.find((candidate) => candidate.id === id)
      if (!current) {
        message.error(translate('rpa_roles.messages.not_found'))
        navigate('/rpa-roles', { replace: true })
        return
      }
      const nextCatalog: RoleCatalog = {
        knowledge: knowledgeBases.map((item) => ({ id: item.id, label: item.name })),
        skill: skills.map((item) => ({ id: item.id, label: item.name, version: item.version })),
        artifact: artifacts.map((item) => ({ id: item.id, label: item.title, version: String(item.version) })),
        prompt: allPrompts
          .filter((item) => item.roleId === id)
          .map((item) => ({ id: item.id, label: `${item.kind}: ${item.id}`, version: item.version })),
        provider: []
      }
      const catalogs: RpaRoleWorkspaceCatalogs = {
        knowledgeIds: nextCatalog.knowledge.map((item) => item.id),
        skillIds: nextCatalog.skill.map((item) => item.id),
        artifactIds: nextCatalog.artifact.map((item) => item.id),
        promptIds: nextCatalog.prompt.map((item) => item.id)
      }
      setRole(current)
      setCatalog(nextCatalog)
      setPrompts(allPrompts.filter((item) => item.roleId === id))
      setSummary(
        buildRpaRoleWorkspaceSummary({ role: current, roles: allRoles, catalogs, runs: rpaBatchRunner.getRuns() })
      )
      form.setFieldsValue(toFormValues(current))
    } catch (error) {
      logger.error('Failed to load RPA Role workspace', { error, roleId: id })
      message.error(translate('rpa_roles.messages.workspace_load_failed'))
    } finally {
      setLoading(false)
    }
    // Effect Events intentionally stay outside reactive dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, id, knowledgeBases, navigate])

  useEffect(() => {
    void reload()
  }, [reload])

  const saveRole = async () => {
    if (!role) return
    setSaving(true)
    try {
      const values = await form.validateFields()
      await rpaAppRoleRepository.save({ ...role, ...fromFormValues(values) })
      message.success(t('rpa_roles.messages.saved'))
      await reload()
    } catch (error) {
      if (error instanceof Error) message.error(error.message)
      logger.warn('Failed to save RPA Role', { error, roleId: role.id })
    } finally {
      setSaving(false)
    }
  }

  const openBinding = (assetType: RpaAppRoleAssetType) => {
    setBindingType(assetType)
    bindingForm.setFieldsValue({
      ref: { roleId: role?.id ?? id, assetType, assetId: '' },
      ownership: 'linked',
      requirement: 'optional',
      enabled: true,
      priority: 0
    })
    setBindingOpen(true)
  }

  const addBinding = async () => {
    if (!role) return
    const binding = await bindingForm.validateFields()
    const asset = catalog[bindingType].find((item) => item.id === binding.ref.assetId)
    const next: RpaAppRoleAssetBinding = {
      ...binding,
      ref: { ...binding.ref, roleId: role.id, assetType: bindingType, version: asset?.version }
    }
    await rpaAppRoleRepository.save({
      ...role,
      assetBindings: [
        ...role.assetBindings.filter(
          (candidate) => candidate.ref.assetType !== bindingType || candidate.ref.assetId !== next.ref.assetId
        ),
        next
      ]
    })
    setBindingOpen(false)
    await reload()
  }

  const openKnowledgeManager = () => {
    setBindingOpen(false)
    navigate('/knowledge')
  }

  const importSkills = async () => {
    try {
      const selected = await FileManager.selectFiles({ properties: ['openFile', 'multiSelections'] })
      if (!selected?.length) return
      const imported: RpaSkillRecord[] = []
      for (const file of selected) {
        const raw = await window.api.fs.readText(file.path)
        const parsed = JSON.parse(raw) as unknown
        const candidates = Array.isArray(parsed) ? parsed : [parsed]
        for (const candidate of candidates) {
          const definition =
            candidate && typeof candidate === 'object' && !Array.isArray(candidate) && 'definition' in candidate
              ? (candidate as { definition: unknown }).definition
              : candidate
          imported.push(await rpaSkillRepository.save({ definition }))
        }
      }
      await reload()
      if (imported[0]) bindingForm.setFieldValue(['ref', 'assetId'], imported[0].id)
      message.success(t('rpa_roles.binding.skill_imported', { count: imported.length }))
    } catch (error) {
      logger.warn('Failed to import RPA Skill assets', { error, roleId: role?.id })
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const importArtifacts = async () => {
    try {
      const selected = await FileManager.selectFiles({ properties: ['openFile', 'multiSelections'] })
      if (!selected?.length) return
      const files = await FileManager.addFiles(selected)
      const imported: RpaArtifact[] = []
      for (const file of files) {
        imported.push(
          (
            await rpaArtifactStore.register(
              artifactInputFromFile(file, {
                source: 'uploaded'
              })
            )
          ).artifact
        )
      }
      await reload()
      if (imported[0]) bindingForm.setFieldValue(['ref', 'assetId'], imported[0].id)
      message.success(t('rpa_roles.binding.artifact_imported', { count: imported.length }))
    } catch (error) {
      logger.warn('Failed to import RPA file assets', { error, roleId: role?.id })
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const updateBinding = async (binding: RpaAppRoleAssetBinding, patch: Partial<RpaAppRoleAssetBinding>) => {
    if (!role) return
    await rpaAppRoleRepository.save({
      ...role,
      assetBindings: role.assetBindings.map((candidate) =>
        sameBinding(candidate, binding) ? { ...candidate, ...patch } : candidate
      )
    })
    await reload()
  }

  const removeBinding = async (binding: RpaAppRoleAssetBinding) => {
    if (!role) return
    await rpaAppRoleRepository.save({
      ...role,
      assetBindings: role.assetBindings.filter((candidate) => !sameBinding(candidate, binding))
    })
    await reload()
  }

  const savePrompt = async () => {
    if (!role) return
    const values = await promptForm.validateFields()
    const now = Date.now()
    await rpaRolePromptRepository.save({
      schemaVersion: 1,
      ...values,
      roleId: role.id,
      version: '1',
      status: 'enabled',
      createdAt: now,
      updatedAt: now
    })
    setPromptOpen(false)
    promptForm.resetFields()
    await reload()
  }

  const deletePrompt = async (prompt: RpaRolePrompt) => {
    await rpaRolePromptRepository.remove(prompt.roleId, prompt.id, prompt.version)
    await reload()
  }

  const activeRunBlocked = Boolean(summary?.activeRunIds.length)
  const tabs = [
    {
      key: 'overview',
      label: t('rpa_roles.tabs.overview'),
      children: <Overview form={form} />
    },
    {
      key: 'prompts',
      label: t('rpa_roles.tabs.prompts'),
      children: (
        <Prompts
          prompts={prompts}
          onAdd={() => {
            promptForm.setFieldsValue({ id: '', kind: 'system', content: '', priority: 0 })
            setPromptOpen(true)
          }}
          onDelete={deletePrompt}
        />
      )
    },
    ...RPA_APP_ROLE_ASSET_TYPES.filter((type) => !['prompt', 'provider'].includes(type)).map((type) => ({
      key: type,
      label: assetTabLabel(t, type),
      children: (
        <BindingTable
          type={type}
          role={role}
          catalog={catalog[type]}
          onAdd={() => openBinding(type)}
          onChange={updateBinding}
          onRemove={removeBinding}
        />
      )
    })),
    { key: 'versions', label: t('rpa_roles.tabs.versions'), children: <Versions role={role} prompts={prompts} /> }
  ]

  return (
    <Page>
      <Navbar>
        <NavbarCenter style={{ borderRight: 'none' }}>{t('rpa_roles.actions.edit')}</NavbarCenter>
      </Navbar>
      <ContentContainer id="content-container">
        <Content>
          <Header>
            <Button type="text" icon={<ArrowLeft size={17} />} onClick={() => navigate('/rpa-roles')}>
              {t('rpa_roles.actions.back')}
            </Button>
            <Button icon={<Save size={16} />} loading={saving} onClick={() => void saveRole()}>
              {t('rpa_roles.actions.save')}
            </Button>
          </Header>
          {activeRunBlocked && (
            <Alert
              type="warning"
              showIcon
              message={t('rpa_roles.alerts.active_runs')}
              description={summary?.activeRunIds.join(', ')}
            />
          )}
          {summary?.brokenBindings.length ? (
            <Alert
              type="error"
              showIcon
              message={t('rpa_roles.alerts.broken_bindings', { count: summary.brokenBindings.length })}
              description={summary.brokenBindings.map((item) => item.reason).join('; ')}
            />
          ) : null}
          <Spin spinning={loading}>
            <Tabs items={tabs} destroyOnHidden={false} />
          </Spin>
        </Content>
      </ContentContainer>
      <Modal
        title={t('rpa_roles.binding.bind_title', { asset: assetTabLabel(t, bindingType) })}
        open={bindingOpen}
        onCancel={() => setBindingOpen(false)}
        onOk={() => void addBinding()}
        okText={t('rpa_roles.binding.add')}>
        <AssetImportActions>
          <Typography.Text type="secondary">{t('rpa_roles.binding.asset_source_hint')}</Typography.Text>
          {bindingType === 'knowledge' && (
            <Button icon={<FolderOpen size={15} />} onClick={openKnowledgeManager}>
              {t('rpa_roles.binding.manage_knowledge')}
            </Button>
          )}
          {bindingType === 'skill' && (
            <Button icon={<FileUp size={15} />} onClick={() => void importSkills()}>
              {t('rpa_roles.binding.import_skill')}
            </Button>
          )}
          {bindingType === 'artifact' && (
            <Button icon={<FileUp size={15} />} onClick={() => void importArtifacts()}>
              {t('rpa_roles.binding.import_files')}
            </Button>
          )}
        </AssetImportActions>
        <Form form={bindingForm} layout="vertical">
          <Form.Item name={['ref', 'assetId']} label={t('rpa_roles.binding.asset')} rules={[{ required: true }]}>
            <Select
              showSearch
              options={catalog[bindingType].map((item) => ({ value: item.id, label: `${item.label} (${item.id})` }))}
            />
          </Form.Item>
          <Form.Item name="ownership" label={t('rpa_roles.binding.ownership')} rules={[{ required: true }]}>
            <Select
              options={['owned', 'linked', 'shared'].map((value) => ({
                value,
                label: rpaRoleOwnershipLabel(t, value)
              }))}
            />
          </Form.Item>
          <Form.Item name="requirement" label={t('rpa_roles.binding.requirement')} rules={[{ required: true }]}>
            <Select
              options={['required', 'optional'].map((value) => ({
                value,
                label: rpaRoleRequirementLabel(t, value)
              }))}
            />
          </Form.Item>
          <Form.Item name="priority" label={t('rpa_roles.binding.priority')}>
            <InputNumber min={-100} max={100} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={t('rpa_roles.prompts.add_title')}
        open={promptOpen}
        onCancel={() => setPromptOpen(false)}
        onOk={() => void savePrompt()}
        okText={t('rpa_roles.prompts.save')}
        width={720}>
        <Form form={promptForm} layout="vertical">
          <Form.Item name="id" label={t('rpa_roles.prompts.id')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="kind" label={t('rpa_roles.prompts.kind')} rules={[{ required: true }]}>
            <Select
              options={RPA_ROLE_PROMPT_KINDS.map((value) => ({
                value,
                label: rpaRolePromptKindLabel(t, value)
              }))}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(previous, current) => previous.kind !== current.kind}>
            {({ getFieldValue }) =>
              getFieldValue('kind') === 'capability' ? (
                <Form.Item name="capability" label={t('rpa_roles.prompts.capability')} rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <Form.Item name="priority" label={t('rpa_roles.binding.priority')}>
            <InputNumber min={-100} max={100} />
          </Form.Item>
          <Form.Item name="content" label={t('rpa_roles.prompts.content')} rules={[{ required: true }]}>
            <Input.TextArea rows={12} />
          </Form.Item>
        </Form>
      </Modal>
    </Page>
  )
}

const Overview: FC<{
  form: ReturnType<typeof Form.useForm<RoleFormValues>>[0]
}> = ({ form }) => {
  const { t } = useTranslation()
  return (
    <Form form={form} layout="vertical">
      <Form.Item name="name" label={t('rpa_roles.form.name')} rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name="description" label={t('rpa_roles.form.description')}>
        <Input.TextArea rows={6} />
      </Form.Item>
    </Form>
  )
}

const Prompts: FC<{
  prompts: RpaRolePrompt[]
  onAdd: () => void
  onDelete: (prompt: RpaRolePrompt) => Promise<void>
}> = ({ prompts, onAdd, onDelete }) => {
  const { t } = useTranslation()
  return (
    <Space direction="vertical" size={18} style={{ width: '100%' }}>
      <SectionHeader>
        <Typography.Title level={5}>{t('rpa_roles.prompts.versioned')}</Typography.Title>
        <Button icon={<Plus size={16} />} onClick={onAdd}>
          {t('rpa_roles.prompts.add')}
        </Button>
      </SectionHeader>
      <Table
        rowKey={(item) => `${item.id}:${item.version}`}
        size="small"
        pagination={false}
        dataSource={prompts}
        locale={{ emptyText: <Empty description={t('rpa_roles.prompts.empty')} /> }}
        columns={[
          { title: t('rpa_roles.prompts.id'), dataIndex: 'id' },
          {
            title: t('rpa_roles.prompts.kind'),
            dataIndex: 'kind',
            render: (kind: RpaRolePromptKind) => rpaRolePromptKindLabel(t, kind)
          },
          { title: t('rpa_roles.form.version'), dataIndex: 'version', width: 90 },
          { title: t('rpa_roles.binding.priority'), dataIndex: 'priority', width: 90 },
          { title: t('rpa_roles.prompts.content'), dataIndex: 'content', ellipsis: true },
          {
            title: '',
            width: 54,
            render: (_, prompt) => (
              <Popconfirm title={t('rpa_roles.prompts.delete_confirm')} onConfirm={() => void onDelete(prompt)}>
                <Button type="text" danger icon={<Trash2 size={15} />} />
              </Popconfirm>
            )
          }
        ]}
      />
    </Space>
  )
}

const BindingTable: FC<{
  type: RpaAppRoleAssetType
  role?: RpaAppRole
  catalog: CatalogItem[]
  onAdd: () => void
  onChange: (binding: RpaAppRoleAssetBinding, patch: Partial<RpaAppRoleAssetBinding>) => Promise<void>
  onRemove: (binding: RpaAppRoleAssetBinding) => Promise<void>
}> = ({ type, role, catalog, onAdd, onChange, onRemove }) => {
  const { t } = useTranslation()
  const items = role?.assetBindings.filter((item) => item.ref.assetType === type) ?? []
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <SectionHeader>
        <Typography.Text type="secondary">{t('rpa_roles.binding.reference_hint')}</Typography.Text>
        <Button icon={<Plus size={16} />} onClick={onAdd}>
          {t('rpa_roles.binding.bind_asset')}
        </Button>
      </SectionHeader>
      <Table
        rowKey={(item) => `${item.ref.roleId}:${item.ref.assetType}:${item.ref.assetId}`}
        size="small"
        pagination={false}
        dataSource={items}
        locale={{
          emptyText: <Empty description={t('rpa_roles.binding.empty', { asset: assetTabLabel(t, type) })} />
        }}
        columns={[
          {
            title: t('rpa_roles.binding.asset'),
            render: (_, item) =>
              catalog.find((candidate) => candidate.id === item.ref.assetId)?.label ?? (
                <Typography.Text type="danger">
                  {t('rpa_roles.binding.missing', { id: item.ref.assetId })}
                </Typography.Text>
              )
          },
          { title: t('rpa_roles.form.version'), width: 100, render: (_, item) => item.ref.version ?? '-' },
          {
            title: t('rpa_roles.binding.ownership'),
            width: 130,
            render: (_, item) => (
              <Select
                value={item.ownership}
                style={{ width: 110 }}
                onChange={(ownership: RpaAppRoleAssetOwnership) => void onChange(item, { ownership })}
                options={['owned', 'linked', 'shared'].map((value) => ({
                  value,
                  label: rpaRoleOwnershipLabel(t, value)
                }))}
              />
            )
          },
          {
            title: t('rpa_roles.binding.requirement'),
            width: 130,
            render: (_, item) => (
              <Select
                value={item.requirement}
                style={{ width: 110 }}
                onChange={(requirement: RpaAppRoleAssetRequirement) => void onChange(item, { requirement })}
                options={['required', 'optional'].map((value) => ({
                  value,
                  label: rpaRoleRequirementLabel(t, value)
                }))}
              />
            )
          },
          {
            title: t('rpa_roles.binding.priority'),
            width: 90,
            render: (_, item) => (
              <InputNumber
                value={item.priority}
                min={-100}
                max={100}
                style={{ width: 70 }}
                onChange={(priority) => void onChange(item, { priority: priority ?? 0 })}
              />
            )
          },
          {
            title: t('rpa_roles.binding.enabled'),
            width: 80,
            render: (_, item) => (
              <Switch checked={item.enabled} onChange={(enabled) => void onChange(item, { enabled })} />
            )
          },
          {
            title: '',
            width: 54,
            render: (_, item) => (
              <Popconfirm title={t('rpa_roles.binding.remove_confirm')} onConfirm={() => void onRemove(item)}>
                <Button type="text" danger icon={<Trash2 size={15} />} />
              </Popconfirm>
            )
          }
        ]}
      />
    </Space>
  )
}

const Versions: FC<{ role?: RpaAppRole; prompts: RpaRolePrompt[] }> = ({ role, prompts }) => {
  const { t } = useTranslation()
  return (
    <Descriptions bordered size="small" column={1}>
      <Descriptions.Item label={t('rpa_roles.versions.role_version')}>{role?.version ?? '-'}</Descriptions.Item>
      <Descriptions.Item label={t('rpa_roles.versions.last_updated')}>
        {role ? new Date(role.updatedAt).toLocaleString() : '-'}
      </Descriptions.Item>
      <Descriptions.Item label={t('rpa_roles.versions.prompt_versions')}>
        {prompts.map((item) => `${item.id}@${item.version}`).join(', ') || t('rpa_roles.none')}
      </Descriptions.Item>
    </Descriptions>
  )
}

function toFormValues(role: RpaAppRole): RoleFormValues {
  return {
    name: role.name,
    description: role.description
  }
}

function fromFormValues(values: RoleFormValues): Partial<RpaAppRole> {
  return {
    name: values.name,
    description: values.description
  }
}

function sameBinding(left: RpaAppRoleAssetBinding, right: RpaAppRoleAssetBinding): boolean {
  return (
    left.ref.roleId === right.ref.roleId &&
    left.ref.assetType === right.ref.assetType &&
    left.ref.assetId === right.ref.assetId
  )
}
function assetTabLabel(t: TFunction, type: RpaAppRoleAssetType): string {
  return rpaRoleAssetLabel(t, type)
}
function emptyCatalog(): RoleCatalog {
  return { knowledge: [], skill: [], artifact: [], prompt: [], provider: [] }
}

const Page = styled.div`display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column;`
const ContentContainer = styled.div`display: flex; min-width: 0; min-height: 0; flex: 1; overflow: auto;`
const Content = styled.main`display: flex; width: 100%; max-width: 1120px; min-width: 0; margin: 0 auto; padding: 18px 24px 40px; box-sizing: border-box; flex-direction: column; gap: 14px;`
const Header = styled.div`display: flex; align-items: center; justify-content: space-between; gap: 12px;`
const SectionHeader = styled.div`display: flex; align-items: center; justify-content: space-between; gap: 12px;`
const AssetImportActions = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
`

export default RpaRoleDetailPage
