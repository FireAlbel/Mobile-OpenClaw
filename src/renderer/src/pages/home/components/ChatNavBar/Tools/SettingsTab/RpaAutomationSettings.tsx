import { loggerService } from '@logger'
import { useKnowledgeBases } from '@renderer/hooks/useKnowledge'
import { useProviders } from '@renderer/hooks/useProvider'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { rpaRoleStatusLabel } from '@renderer/pages/rpaRoles/rpaRoleI18n'
import { CollapsibleSettingGroup } from '@renderer/pages/settings/SettingGroup'
import {
  type RpaAppRole,
  type RpaAppRoleAssetBinding,
  type RpaAppRoleAssetType,
  rpaAppRoleRepository
} from '@renderer/services/rpa/RpaAppRole'
import { rpaRolePromptRepository } from '@renderer/services/rpa/RpaRolePrompt'
import { rpaSkillRepository } from '@renderer/services/rpa/RpaSkillRepository'
import type { Assistant, Model } from '@renderer/types'
import { Alert, Button, message, Select, Space, Spin, Tag, Typography } from 'antd'
import { ExternalLink, Save } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

const logger = loggerService.withContext('RpaAutomationSettings')
const DEFAULT_MODEL = '__default__'

interface Props {
  assistant: Assistant
}

interface AssetOption {
  value: string
  label: string
  version?: string
}

const RpaAutomationSettings: FC<Props> = () => {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const translate = useEffectEvent(t)
  const { chat } = useRuntime()
  const { bases } = useKnowledgeBases()
  const { providers } = useProviders()
  const roleId = chat.activeTopic?.rpaRoleId
  const [role, setRole] = useState<RpaAppRole>()
  const [draft, setDraft] = useState<RpaAppRole>()
  const [skills, setSkills] = useState<AssetOption[]>([])
  const [promptCount, setPromptCount] = useState(0)
  const [loading, setLoading] = useState(Boolean(roleId))
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!roleId) {
      setRole(undefined)
      setDraft(undefined)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const [currentRole, roleSkills, prompts] = await Promise.all([
        rpaAppRoleRepository.getById(roleId),
        rpaSkillRepository.getAll(),
        rpaRolePromptRepository.getAll()
      ])
      setRole(currentRole)
      setDraft(currentRole ? cloneRole(currentRole) : undefined)
      setSkills(roleSkills.map((skill) => ({ value: skill.id, label: skill.name, version: skill.version })))
      setPromptCount(prompts.filter((prompt) => prompt.roleId === roleId && prompt.status === 'enabled').length)
    } catch (error) {
      logger.error('Failed to load bound RPA Role settings', { error, roleId })
      message.error(translate('rpa_roles.settings.load_failed'))
    } finally {
      setLoading(false)
    }
    // Effect Events intentionally stay outside reactive dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleId])

  useEffect(() => {
    void load()
  }, [load])

  const knowledgeOptions = useMemo<AssetOption[]>(
    () =>
      bases.map((base) => ({
        value: base.id,
        label: base.name,
        version: base.version ? String(base.version) : undefined
      })),
    [bases]
  )
  const modelOptions = useMemo(
    () =>
      providers.flatMap((provider) =>
        provider.models.map((model) => ({
          value: encodeModel(provider.id, model.id),
          label: `${model.name || model.id} | ${provider.name}`,
          model
        }))
      ),
    [providers]
  )

  const setAssets = (type: RpaAppRoleAssetType, ids: string[], options: AssetOption[]) => {
    if (!draft) return
    const existing = new Map(
      draft.assetBindings
        .filter((binding) => binding.ref.assetType === type)
        .map((binding) => [binding.ref.assetId, binding])
    )
    const bindings = ids.map((assetId): RpaAppRoleAssetBinding => {
      const current = existing.get(assetId)
      const option = options.find((item) => item.value === assetId)
      return (
        current ?? {
          ref: { roleId: draft.id, assetType: type, assetId, version: option?.version },
          ownership: 'linked',
          requirement: 'optional',
          enabled: true,
          priority: 0
        }
      )
    })
    setDraft({
      ...draft,
      assetBindings: [...draft.assetBindings.filter((item) => item.ref.assetType !== type), ...bindings]
    })
  }

  const setModel = (capability: keyof NonNullable<RpaAppRole['modelDefaults']>, value: string) => {
    if (!draft) return
    setDraft({
      ...draft,
      modelDefaults: { ...draft.modelDefaults, [capability]: decodeModel(value) }
    })
  }

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const saved = await rpaAppRoleRepository.save(draft)
      setRole(saved)
      setDraft(cloneRole(saved))
      message.success(t('rpa_roles.settings.saved'))
    } catch (error) {
      logger.error('Failed to save bound RPA Role settings', { error, roleId: draft.id })
      message.error(error instanceof Error ? error.message : t('rpa_roles.settings.save_failed'))
    } finally {
      setSaving(false)
    }
  }

  if (!roleId) {
    return (
      <Alert
        type="info"
        showIcon
        message={t('rpa_roles.settings.unbound_title')}
        description={t('rpa_roles.settings.unbound_description')}
      />
    )
  }
  if (loading)
    return (
      <LoadingArea>
        <Spin />
      </LoadingArea>
    )
  if (!draft || !role) {
    return <Alert type="error" showIcon message={t('rpa_roles.messages.not_found')} description={roleId} />
  }

  return (
    <Panel>
      <RoleHeader>
        <div>
          <Typography.Text strong>{draft.name}</Typography.Text>
          <Typography.Text type="secondary">
            v{role.version} · {rpaRoleStatusLabel(t, draft.status)}
          </Typography.Text>
        </div>
        <Button type="text" icon={<ExternalLink size={15} />} onClick={() => navigate(`/rpa-roles/${draft.id}`)} />
      </RoleHeader>
      <Alert
        type="info"
        showIcon
        message={t('rpa_roles.settings.bound_title')}
        description={t('rpa_roles.settings.bound_description')}
      />
      <CollapsibleSettingGroup title={t('rpa_roles.settings.assets')} defaultExpanded>
        <AssetField
          label={t('rpa_roles.assets.knowledge')}
          options={knowledgeOptions}
          value={selectedAssets(draft, 'knowledge')}
          onChange={(ids) => setAssets('knowledge', ids, knowledgeOptions)}
        />
        <AssetField
          label={t('rpa_roles.assets.skill')}
          options={skills}
          value={selectedAssets(draft, 'skill')}
          onChange={(ids) => setAssets('skill', ids, skills)}
        />
        <Field>
          <Typography.Text>{t('rpa_roles.assets.prompt')}</Typography.Text>
          <Space>
            <Tag>{t('rpa_roles.settings.enabled_prompt_versions', { count: promptCount })}</Tag>
            <Button size="small" onClick={() => navigate(`/rpa-roles/${draft.id}`)}>
              {t('rpa_roles.settings.manage')}
            </Button>
          </Space>
        </Field>
      </CollapsibleSettingGroup>
      <CollapsibleSettingGroup title={t('rpa_roles.settings.model_defaults')} defaultExpanded>
        <ModelField
          label={t('rpa_roles.model_kinds.planner')}
          defaultLabel={t('rpa_roles.settings.use_chat_model')}
          value={draft.modelDefaults?.planner}
          options={modelOptions}
          onChange={(value) => setModel('planner', value)}
        />
        <ModelField
          label={t('rpa_roles.model_kinds.vision')}
          defaultLabel={t('rpa_roles.settings.use_chat_model')}
          value={draft.modelDefaults?.vision}
          options={modelOptions}
          onChange={(value) => setModel('vision', value)}
        />
        <ModelField
          label={t('rpa_roles.model_kinds.verification')}
          defaultLabel={t('rpa_roles.settings.use_chat_model')}
          value={draft.modelDefaults?.verification}
          options={modelOptions}
          onChange={(value) => setModel('verification', value)}
        />
        <ModelField
          label={t('rpa_roles.model_kinds.recovery')}
          defaultLabel={t('rpa_roles.settings.use_chat_model')}
          value={draft.modelDefaults?.recovery}
          options={modelOptions}
          onChange={(value) => setModel('recovery', value)}
        />
      </CollapsibleSettingGroup>
      <Actions>
        <Button type="primary" icon={<Save size={15} />} loading={saving} onClick={() => void save()}>
          {t('rpa_roles.settings.save_role')}
        </Button>
      </Actions>
    </Panel>
  )
}

const AssetField: FC<{
  label: string
  options: AssetOption[]
  value: string[]
  onChange: (value: string[]) => void
}> = ({ label, options, value, onChange }) => (
  <Field>
    <Typography.Text>{label}</Typography.Text>
    <Select
      mode="multiple"
      showSearch
      optionFilterProp="label"
      value={value}
      options={options.map((option) => ({
        value: option.value,
        label: option.version ? `${option.label} @ ${option.version}` : option.label
      }))}
      onChange={onChange}
    />
  </Field>
)

const ModelField: FC<{
  label: string
  defaultLabel: string
  value?: { providerId: string; modelId: string }
  options: Array<{ value: string; label: string; model: Model }>
  onChange: (value: string) => void
}> = ({ label, defaultLabel, value, options, onChange }) => (
  <Field>
    <Typography.Text>{label}</Typography.Text>
    <Select
      showSearch
      optionFilterProp="label"
      value={value ? encodeModel(value.providerId, value.modelId) : DEFAULT_MODEL}
      options={[{ value: DEFAULT_MODEL, label: defaultLabel }, ...options]}
      onChange={onChange}
    />
  </Field>
)

function selectedAssets(role: RpaAppRole, type: RpaAppRoleAssetType): string[] {
  return role.assetBindings
    .filter((binding) => binding.ref.assetType === type && binding.enabled)
    .map((binding) => binding.ref.assetId)
}
function encodeModel(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`
}
function decodeModel(value: string) {
  if (value === DEFAULT_MODEL) return undefined
  const [providerId, modelId] = value.split('::')
  return providerId && modelId ? { providerId, modelId } : undefined
}
function cloneRole(role: RpaAppRole): RpaAppRole {
  return structuredClone(role)
}

const Panel = styled.div`display: flex; flex-direction: column; gap: 12px; padding: 4px 5px 14px;`
const LoadingArea = styled.div`display: flex; justify-content: center; padding: 24px;`
const RoleHeader = styled.div`display: flex; align-items: center; justify-content: space-between; gap: 10px; > div { display: flex; min-width: 0; flex-direction: column; }`
const Field = styled.div`display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px;`
const Actions = styled.div`display: flex; justify-content: flex-end;`

export default RpaAutomationSettings
