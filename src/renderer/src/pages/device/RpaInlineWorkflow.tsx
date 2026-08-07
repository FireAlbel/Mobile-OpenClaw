import { loggerService } from '@logger'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useProviders } from '@renderer/hooks/useProvider'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { resolveEffectiveRpaRoleContext } from '@renderer/services/rpa/EffectiveRpaRoleContextResolver'
import { adaptAssistantProfileToRpaAppRole, rpaAppRoleRepository } from '@renderer/services/rpa/RpaAppRole'
import { rpaArtifactStore } from '@renderer/services/rpa/RpaArtifactStore'
import {
  createKnowledgeAssetCatalog,
  createRpaTemplateAssetCatalog
} from '@renderer/services/rpa/RpaAssistantAssetCatalog'
import { rpaAssistantProfileMigrationService } from '@renderer/services/rpa/RpaAssistantProfileMigrationService'
import { rpaBatchRunner } from '@renderer/services/rpa/RpaBatchRunner'
import { rpaContextualReplanService } from '@renderer/services/rpa/RpaContextualReplanService'
import { defaultRpaModuleRegistry } from '@renderer/services/rpa/RpaDefaultRegistry'
import { rpaDslSessionRepository } from '@renderer/services/rpa/RpaDslSession'
import type { RpaExecutionTargetSelection } from '@renderer/services/rpa/RpaExecutionTarget'
import { rpaKnowledgeRetrievalService } from '@renderer/services/rpa/RpaKnowledgeRetrievalService'
import { rpaRolePromptRepository } from '@renderer/services/rpa/RpaRolePrompt'
import {
  createRpaDslProvenance,
  createRpaRunContextSnapshot,
  type RpaDslProvenance
} from '@renderer/services/rpa/RpaRunContextSnapshot'
import type { RpaBatchRunRecord } from '@renderer/services/rpa/RpaRunStorage'
import { rpaSafetyPolicyEngine } from '@renderer/services/rpa/RpaSafetyPolicyEngine'
import { rpaSessionDraftRegistry } from '@renderer/services/rpa/RpaSessionDraftRegistry'
import { rpaSkillRepository } from '@renderer/services/rpa/RpaSkillRepository'
import { RpaTaskValidator } from '@renderer/services/rpa/RpaTaskValidator'
import { rpaTemplateRepository } from '@renderer/services/rpa/RpaTemplateRepository'
import { rpaTopicContextOverrideRepository } from '@renderer/services/rpa/RpaTopicContextOverride'
import type { RpaTask, RpaValidationIssue } from '@renderer/services/rpa/RpaTypes'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { updateOneBlock } from '@renderer/store/messageBlock'
import { updateMessageAndBlocksThunk } from '@renderer/store/thunk/messageThunk'
import type { MainTextMessageBlock, Message } from '@renderer/types/newMessage'
import { Button, Input, message as antMessage, Modal, Space, Typography } from 'antd'
import { ExternalLink, FolderInput, Play, RefreshCw, Save } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import styled from 'styled-components'

import JsonEditor, { getJsonSyntaxError } from './JsonEditor'
import RpaContextIndicator from './RpaContextIndicator'
import RpaExecutionConfirmModal from './RpaExecutionConfirmModal'
import RpaExecutionProgressModal from './RpaExecutionProgressModal'
import RpaRunHistory from './RpaRunHistory'
import RpaSaveToTemplateModal, { type RpaChatTemplateLink } from './RpaSaveToTemplateModal'
import RpaTimelineEditor from './RpaTimelineEditor'

const logger = loggerService.withContext('RpaInlineWorkflow')
const draftValidator = new RpaTaskValidator(defaultRpaModuleRegistry, { requireDeviceIds: false })
const executionValidator = new RpaTaskValidator(defaultRpaModuleRegistry)

interface Props {
  block: MainTextMessageBlock
  message: Message
}

const RpaInlineWorkflow: FC<Props> = ({ block, message }) => {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const dispatch = useAppDispatch()
  const { assistant } = useAssistant(message.assistantId)
  const { providers } = useProviders()
  const knowledgeBases = useAppSelector((state) => state.knowledge.bases)
  const storedTask = block.metadata?.rpaTask as RpaTask
  const storedProvenance = block.metadata?.rpaProvenance as RpaDslProvenance | undefined
  const storedTemplateLink = block.metadata?.rpaTemplateLink as RpaChatTemplateLink | undefined
  const storedSessionId = typeof block.metadata?.rpaSessionId === 'string' ? block.metadata.rpaSessionId : undefined
  const storedExecutionRunId = typeof block.metadata?.rpaRunId === 'string' ? block.metadata.rpaRunId : undefined
  const [task, setTask] = useState<RpaTask>(() => toDeviceAgnosticTask(storedTask))
  const [issues, setIssues] = useState<RpaValidationIssue[]>(() => draftValidator.validate(storedTask).issues)
  const [jsonText, setJsonText] = useState(() => JSON.stringify(toDeviceAgnosticTask(storedTask), null, 2))
  const [savedJsonText, setSavedJsonText] = useState(() => JSON.stringify(toDeviceAgnosticTask(storedTask), null, 2))
  const [jsonError, setJsonError] = useState<string>()
  const [paramsJsonValid, setParamsJsonValid] = useState(true)
  const [executionRunId, setExecutionRunId] = useState<string | undefined>(storedExecutionRunId)
  const [executionOpen, setExecutionOpen] = useState(false)
  const [confirmationOpen, setConfirmationOpen] = useState(false)
  const [saveToTemplateOpen, setSaveToTemplateOpen] = useState(false)
  const [templateDsl, setTemplateDsl] = useState<unknown>(storedTask)
  const [templateLink, setTemplateLink] = useState<RpaChatTemplateLink | undefined>(storedTemplateLink)
  const [replanOpen, setReplanOpen] = useState(false)
  const [replanObjective, setReplanObjective] = useState('')
  const [replanRun, setReplanRun] = useState<RpaBatchRunRecord>()
  const [replanLoading, setReplanLoading] = useState(false)
  const riskSummary = useMemo(
    () => rpaSafetyPolicyEngine.analyzeTask(task, defaultRpaModuleRegistry.listMetadata()),
    [task]
  )

  useEffect(() => {
    const deviceAgnosticTask = toDeviceAgnosticTask(storedTask)
    setTask(deviceAgnosticTask)
    const nextJson = JSON.stringify(deviceAgnosticTask, null, 2)
    setJsonText(nextJson)
    setSavedJsonText(nextJson)
    setIssues(draftValidator.validate(deviceAgnosticTask).issues)
  }, [storedTask])

  useEffect(() => {
    if (!storedTemplateLink?.templateId) return
    void rpaTemplateRepository.getById(storedTemplateLink.templateId).then((current) => {
      if (!current) return
      setTemplateLink({
        ...storedTemplateLink,
        name: current.name,
        version: current.version,
        status: current.status
      })
    })
  }, [storedTemplateLink])

  useEffect(() => {
    if (!executionRunId || !storedSessionId) return
    const syncExecutionStatus = async () => {
      await rpaBatchRunner.initialize()
      const session = await rpaDslSessionRepository.getById(storedSessionId)
      if (!session || (session.status !== 'executing' && session.status !== 'paused')) return
      const run = rpaBatchRunner.getRuns().find((candidate) => candidate.id === executionRunId)
      const nextStatus = !run
        ? 'paused'
        : run.status === 'pending' || run.status === 'running'
          ? 'executing'
          : run.status === 'paused'
            ? 'paused'
            : run.status === 'completed'
              ? 'completed'
              : run.status === 'failed' || run.status === 'cancelled'
                ? 'failed'
                : undefined
      if (!nextStatus || nextStatus === session.status) return
      await rpaDslSessionRepository.setExecutionStatus(session.id, session.version, nextStatus)
    }
    const synchronize = () => {
      void syncExecutionStatus().catch((error) => {
        logger.warn('Failed to synchronize the RPA DSL session execution status', {
          error,
          runId: executionRunId,
          sessionId: storedSessionId
        })
      })
    }
    synchronize()
    return rpaBatchRunner.subscribe(synchronize)
  }, [executionRunId, storedSessionId])

  const updateTask = (nextTask: RpaTask) => {
    const deviceAgnosticTask = toDeviceAgnosticTask(nextTask)
    setTask(deviceAgnosticTask)
    setJsonText(JSON.stringify(deviceAgnosticTask, null, 2))
    setJsonError(undefined)
    setIssues(draftValidator.validate(deviceAgnosticTask).issues)
  }

  const validateJson = useCallback(
    (value: string) => {
      const syntaxError = getJsonSyntaxError(value)
      if (syntaxError) {
        setJsonError(syntaxError)
        return undefined
      }

      try {
        const parsed = JSON.parse(value) as RpaTask
        const validation = draftValidator.validate(parsed)
        setIssues(validation.issues)
        if (!validation.success || !validation.task) {
          setJsonError(t('device.rpa.dsl_validation_failed', { defaultValue: 'DSL validation failed.' }))
          return undefined
        }
        setJsonError(undefined)
        return toDeviceAgnosticTask(validation.task)
      } catch (error) {
        setJsonError(error instanceof Error ? error.message : String(error))
        return undefined
      }
    },
    [t]
  )

  const handleJsonChange = (value: string) => {
    setJsonText(value)
    validateJson(value)
  }

  const applyJson = (value = jsonText) => {
    const validatedTask = validateJson(value)
    if (validatedTask) setTask(validatedTask)
  }

  const editorInvalid = Boolean(jsonError) || !paramsJsonValid

  const openSaveToTemplate = () => {
    try {
      const parsed = JSON.parse(jsonText)
      setTemplateDsl(parsed)
      setSaveToTemplateOpen(true)
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error))
      antMessage.error('请先修复 JSON 语法错误')
    }
  }

  const saveTemplateLink = async (link: RpaChatTemplateLink) => {
    const updatedBlock: MainTextMessageBlock = {
      ...block,
      metadata: { ...block.metadata, rpaTemplateLink: link },
      updatedAt: new Date().toISOString()
    }
    dispatch(updateOneBlock({ id: block.id, changes: updatedBlock }))
    await dispatch(updateMessageAndBlocksThunk(message.topicId, null, [updatedBlock]))
    setTemplateLink(link)
    setSaveToTemplateOpen(false)
  }

  const saveTask = useCallback(async (): Promise<boolean> => {
    try {
      const candidate = JSON.parse(jsonText)
      const validation = draftValidator.validate(candidate)
      setIssues(validation.issues)
      if (!validation.success || !validation.task) {
        antMessage.error(
          t('device.rpa.fix_validation_errors', { defaultValue: 'Fix validation errors before saving.' })
        )
        return false
      }

      let revisionVersion = block.metadata?.rpaRevisionVersion
      if (storedSessionId) {
        const session = await rpaDslSessionRepository.getById(storedSessionId)
        const activeRevision = session?.revisions.find((revision) => revision.version === session.activeRevisionVersion)
        if (session && activeRevision) {
          const revisedSession = await rpaDslSessionRepository.appendRevision(
            session.id,
            validation.task,
            activeRevision.roleContext,
            {
              validate: (dsl) => {
                const result = draftValidator.validate(dsl)
                return { dsl: result.task ?? dsl, issues: result.issues, executable: result.success }
              }
            },
            {
              expectedSessionVersion: session.version,
              source: 'revised',
              humanReadableExplanation: 'Saved from the inline RPA DSL editor',
              requestContext:
                (activeRevision.requestContext?.provenance ?? storedProvenance)
                  ? {
                      requestId: `manual-edit-${crypto.randomUUID()}`,
                      sessionId: session.id,
                      baseRevision: activeRevision.version,
                      expectedVersion: session.version,
                      supplementRevision: activeRevision.requestContext?.supplementRevision ?? 0,
                      provenance: activeRevision.requestContext?.provenance ?? storedProvenance!
                    }
                  : undefined
            }
          )
          revisionVersion = revisedSession.activeRevisionVersion
        }
      }
      const updatedBlock: MainTextMessageBlock = {
        ...block,
        metadata: { ...block.metadata, rpaTask: validation.task, rpaRevisionVersion: revisionVersion },
        updatedAt: new Date().toISOString()
      }

      dispatch(updateOneBlock({ id: block.id, changes: updatedBlock }))
      await dispatch(updateMessageAndBlocksThunk(message.topicId, null, [updatedBlock]))
      setTask(validation.task)
      const savedJson = JSON.stringify(validation.task, null, 2)
      setJsonText(savedJson)
      setSavedJsonText(savedJson)
      antMessage.success(t('device.rpa.draft_saved', { defaultValue: 'RPA workflow draft saved.' }))
      return true
    } catch (error) {
      logger.error('Failed to save inline RPA workflow', { error, blockId: block.id })
      antMessage.error(t('device.rpa.save_failed', { defaultValue: 'Failed to save the RPA workflow.' }))
      return false
    }
  }, [block, dispatch, jsonText, message.topicId, storedProvenance, storedSessionId, t])

  useEffect(() => {
    if (!storedSessionId) return
    return rpaSessionDraftRegistry.register(storedSessionId, block.id, {
      isDirty: () => jsonText !== savedJsonText,
      save: saveTask,
      discard: () => {
        const restored = toDeviceAgnosticTask(storedTask)
        const restoredJson = JSON.stringify(restored, null, 2)
        setTask(restored)
        setJsonText(restoredJson)
        setSavedJsonText(restoredJson)
        setIssues(draftValidator.validate(restored).issues)
        setJsonError(undefined)
      }
    })
  }, [block.id, jsonText, saveTask, savedJsonText, storedSessionId, storedTask])

  const openExecutionConfirmation = () => {
    const validation = draftValidator.validate(toDeviceAgnosticTask(task))
    setIssues(validation.issues)
    if (!validation.success || !validation.task) {
      antMessage.error(
        t('device.rpa.fix_validation_errors', { defaultValue: 'Fix validation errors before execution.' })
      )
      return
    }
    setConfirmationOpen(true)
  }

  const resolveCurrentContext = async () => {
    const [migration, topicOverride, session, allRoles, rolePrompts, artifacts] = await Promise.all([
      rpaAssistantProfileMigrationService.getOrMigrateAssistant(assistant, {
        availableKnowledgeIds: knowledgeBases.map((knowledge) => knowledge.id)
      }),
      rpaTopicContextOverrideRepository.getByTopicId(message.topicId),
      storedSessionId ? rpaDslSessionRepository.getById(storedSessionId) : undefined,
      rpaAppRoleRepository.getAll(),
      rpaRolePromptRepository.getAll(),
      rpaArtifactStore.getAll()
    ])
    const profile = migration.profile
    const availableModels = providers.flatMap((provider) => provider.models)
    if (!availableModels.some((candidate) => candidate.id === assistant.model.id)) {
      availableModels.push(assistant.model)
    }
    const selectedTemplateId = readSelectedTemplateId(task.metadata)
    const [templateRecords, skillCatalog] = await Promise.all([
      rpaTemplateRepository.getAll(),
      rpaSkillRepository.toCatalog()
    ])
    const templateCatalog = createRpaTemplateAssetCatalog(templateRecords)
    const knowledgeAvailability = await rpaKnowledgeRetrievalService.getAvailability(
      knowledgeBases.map((knowledge) => knowledge.id)
    )
    const compatibilityRole = adaptAssistantProfileToRpaAppRole({
      profile,
      assistantName: assistant.name,
      appPackages: topicOverride?.appPackages
    })
    const selectedRole = session?.primaryRole
      ? allRoles.find(
          (candidate) => candidate.id === session.primaryRole?.id && candidate.version === session.primaryRole.version
        )
      : undefined
    if (session?.primaryRole && !selectedRole && session.primaryRole.id !== compatibilityRole.id) {
      throw new Error(
        `The immutable RPA Role version is unavailable: ${session.primaryRole.id}@${session.primaryRole.version}`
      )
    }
    const primaryRole = selectedRole ?? compatibilityRole
    const supportingRoles = session?.supportingRoles
      .map((reference) =>
        allRoles.find((candidate) => candidate.id === reference.id && candidate.version === reference.version)
      )
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    const effectiveContext = resolveEffectiveRpaRoleContext({
      topicId: message.topicId,
      primaryRole,
      supportingRoles,
      compatibilityProfile: selectedRole ? undefined : profile,
      topicOverride,
      catalogs: {
        knowledge: createKnowledgeAssetCatalog(knowledgeBases),
        skills: skillCatalog,
        templates: templateCatalog
      },
      promptCatalog: rolePrompts,
      assetAvailability: [
        ...knowledgeAvailability.map((availability) => ({
          assetType: 'knowledge' as const,
          assetId: availability.knowledgeBaseId,
          status: availability.status
        })),
        ...providers.map((provider) => ({
          assetType: 'provider' as const,
          assetId: provider.id,
          status: 'ready' as const
        })),
        ...artifacts.map((artifact) => ({
          assetType: 'artifact' as const,
          assetId: artifact.id,
          version: String(artifact.version),
          status: 'ready' as const
        }))
      ],
      defaultModel: assistant.model,
      availableModels,
      executionOverride: { selectedTemplateIds: selectedTemplateId ? [selectedTemplateId] : [] }
    })
    if (!effectiveContext.executable) {
      const details = [
        ...effectiveContext.roleIssues.filter((issue) => issue.severity === 'error').map((issue) => issue.message),
        ...effectiveContext.missingDependencies.map((issue) => issue.message),
        ...effectiveContext.warnings.map((warning) => warning.message)
      ]
      throw new Error(details.join('; ') || 'RPA effective context is no longer executable')
    }
    return { effectiveContext, topicOverride }
  }

  const executeWithTargets = async (targetSelection: RpaExecutionTargetSelection) => {
    const { effectiveContext, topicOverride } = await resolveCurrentContext()
    const executionTask = { ...toDeviceAgnosticTask(task), deviceIds: targetSelection.deviceIds }
    const validation = executionValidator.validate(executionTask)
    setIssues(validation.issues)
    if (!validation.success || !validation.task) {
      throw new Error(t('device.rpa.fix_validation_errors'))
    }

    const validatedTask = {
      ...validation.task,
      visionModel: effectiveContext.models.vision ?? validation.task.visionModel
    }
    const provenance = storedProvenance ?? createRpaDslProvenance(effectiveContext, validatedTask.metadata)
    const contextSnapshot = createRpaRunContextSnapshot(effectiveContext, provenance, topicOverride)
    const requiresHighRiskConfirmation = riskSummary.highRiskTargets.length > 0
    const safetyApproval = requiresHighRiskConfirmation
      ? rpaSafetyPolicyEngine.createApproval(validatedTask, riskSummary.highRiskTargets, targetSelection.deviceIds)
      : undefined
    if (storedSessionId) {
      const session = await rpaDslSessionRepository.getById(storedSessionId)
      if (session?.status === 'ended') {
        throw new Error(
          t('device.rpa.lifecycle.task_ended_detail', {
            defaultValue: 'This task is now read-only. Create or duplicate a task to continue.'
          })
        )
      }
    }
    const run = await rpaBatchRunner.start({
      task: validatedTask,
      deviceIds: targetSelection.deviceIds,
      safetyApproval,
      targetSelection,
      contextSnapshot
    })
    if (storedSessionId) {
      try {
        let session = await rpaDslSessionRepository.getById(storedSessionId)
        if (session) {
          if (session.status === 'validated') {
            session = await rpaDslSessionRepository.setExecutionStatus(session.id, session.version, 'executing')
          }
          session = await rpaDslSessionRepository.link(session.id, session.version, 'run', run.id)
        }
      } catch (error) {
        logger.warn('Failed to link the execution run to its RPA DSL session', {
          error,
          runId: run.id,
          sessionId: storedSessionId
        })
      }
    }
    const executedBlock: MainTextMessageBlock = {
      ...block,
      metadata: { ...block.metadata, rpaRunId: run.id },
      updatedAt: new Date().toISOString()
    }
    dispatch(updateOneBlock({ id: block.id, changes: executedBlock }))
    await dispatch(updateMessageAndBlocksThunk(message.topicId, null, [executedBlock]))
    setConfirmationOpen(false)
    setExecutionRunId(run.id)
    setExecutionOpen(true)
  }

  const openContextualReplan = (run?: RpaBatchRunRecord) => {
    setReplanRun(run)
    setReplanObjective(
      run
        ? t('device.rpa.replan.execution_objective', {
            defaultValue: 'Repair the workflow using the failed execution state and continue toward the original goal.'
          })
        : t('device.rpa.replan.validation_objective', {
            defaultValue: 'Repair the DSL validation errors while preserving the original task goal.'
          })
    )
    setReplanOpen(true)
  }

  const applyContextualReplan = async () => {
    if (!storedSessionId || !replanObjective.trim()) return
    setReplanLoading(true)
    try {
      const session = await rpaDslSessionRepository.getById(storedSessionId)
      if (!session) throw new Error('The RPA task session is unavailable')
      const { effectiveContext } = await resolveCurrentContext()
      const knowledgeContext = await rpaKnowledgeRetrievalService.retrieve({
        knowledgeBaseIds: effectiveContext.assets.knowledge.map((knowledge) => knowledge.id),
        appPackage: effectiveContext.appPackages[0],
        taskGoal: session.goal,
        categories: ['app_sop', 'page_state_explanation', 'locator_guidance', 'failure_case', 'recovery_guidance']
      })
      const result = await rpaContextualReplanService.replan({
        session,
        objective: replanObjective,
        effectiveContext,
        knowledgeContext,
        validationIssues: replanRun ? undefined : issues,
        run: replanRun,
        signal: AbortSignal.timeout(120_000)
      })
      const nextTask = toDeviceAgnosticTask(result.task)
      const nextJson = JSON.stringify(nextTask, null, 2)
      const provenance = createRpaDslProvenance(effectiveContext, nextTask.metadata)
      const updatedBlock: MainTextMessageBlock = {
        ...block,
        metadata: {
          ...block.metadata,
          rpaTask: nextTask,
          rpaSessionId: result.session.id,
          rpaRevisionVersion: result.session.activeRevisionVersion,
          rpaProvenance: provenance,
          rpaReplan: {
            sourceRevision: result.sourceRevision,
            evidenceKind: result.evidenceKind,
            objective: replanObjective,
            repaired: result.repaired
          }
        },
        updatedAt: new Date().toISOString()
      }
      dispatch(updateOneBlock({ id: block.id, changes: updatedBlock }))
      await dispatch(updateMessageAndBlocksThunk(message.topicId, null, [updatedBlock]))
      setTask(nextTask)
      setJsonText(nextJson)
      setSavedJsonText(nextJson)
      setIssues(draftValidator.validate(nextTask).issues)
      setJsonError(undefined)
      setReplanOpen(false)
      setReplanRun(undefined)
      antMessage.success(t('device.rpa.replan.completed', { defaultValue: 'A new Replan revision was created.' }))
    } catch (error) {
      logger.error('Contextual RPA Replan failed', { error, sessionId: storedSessionId })
      antMessage.error(error instanceof Error ? error.message : String(error))
    } finally {
      setReplanLoading(false)
    }
  }

  return (
    <Workflow>
      <Header>
        <div>
          <Typography.Title level={4}>{task.name}</Typography.Title>
          <Typography.Text type="secondary">{task.goal}</Typography.Text>
        </div>
        <Space wrap>
          {issues.length > 0 && storedSessionId && (
            <Button icon={<RefreshCw size={16} />} onClick={() => openContextualReplan()}>
              {t('device.rpa.replan.action', { defaultValue: 'Replan' })}
            </Button>
          )}
          <Button icon={<Save size={16} />} disabled={editorInvalid} onClick={() => void saveTask()}>
            {t('common.save')}
          </Button>
          <Button
            icon={<FolderInput size={16} />}
            disabled={Boolean(getJsonSyntaxError(jsonText))}
            onClick={openSaveToTemplate}>
            保存到任务流
          </Button>
          <Button type="primary" icon={<Play size={16} />} disabled={editorInvalid} onClick={openExecutionConfirmation}>
            {t('device.rpa.confirm_and_execute', { defaultValue: 'Confirm and execute' })}
          </Button>
        </Space>
      </Header>

      <RpaContextIndicator
        provenance={storedProvenance}
        onAdjust={() => void EventEmitter.emit(EVENT_NAMES.OPEN_ASSISTANT_SETTINGS)}
      />

      {templateLink && (
        <TemplateLinkBar>
          <Space size={6} wrap>
            <Typography.Text type="secondary">已关联任务流</Typography.Text>
            <Typography.Text strong>{templateLink.name}</Typography.Text>
            <Typography.Text type="secondary">v{templateLink.version}</Typography.Text>
            <Typography.Text type={templateLink.status === 'executable' ? 'success' : 'warning'}>
              {templateLink.status === 'executable' ? '可执行' : '草稿'}
            </Typography.Text>
          </Space>
          <Button
            type="text"
            size="small"
            icon={<ExternalLink size={15} />}
            onClick={() => navigate(`/rpa-workflows/edit/${templateLink.templateId}`)}>
            打开模板
          </Button>
        </TemplateLinkBar>
      )}

      <RpaTimelineEditor task={task} issues={issues} onChange={updateTask} onJsonValidityChange={setParamsJsonValid} />

      <AdvancedDetails open>
        <summary>{t('device.rpa.advanced_dsl', { defaultValue: 'Advanced DSL editor' })}</summary>
        <JsonEditor
          value={jsonText}
          onChange={handleJsonChange}
          onBlur={applyJson}
          error={jsonError}
          height="360px"
          minHeight="220px"
          maxHeight="70vh"
          resizable
          ariaLabel={t('device.rpa.advanced_dsl', { defaultValue: 'Advanced DSL editor' })}
        />
      </AdvancedDetails>

      <RpaRunHistory />

      <RpaExecutionConfirmModal
        open={confirmationOpen}
        task={task}
        riskSummary={riskSummary}
        onCancel={() => setConfirmationOpen(false)}
        onExecute={executeWithTargets}
      />

      <RpaExecutionProgressModal
        runId={executionRunId}
        open={executionOpen}
        onClose={() => setExecutionOpen(false)}
        onReplan={openContextualReplan}
      />

      <Modal
        title={t('device.rpa.replan.title', { defaultValue: 'Contextual Replan' })}
        open={replanOpen}
        confirmLoading={replanLoading}
        okText={t('device.rpa.replan.create_revision', { defaultValue: 'Create Replan revision' })}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: !replanObjective.trim() }}
        onOk={() => void applyContextualReplan()}
        onCancel={() => {
          setReplanOpen(false)
          setReplanRun(undefined)
        }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {replanRun
              ? t('device.rpa.replan.execution_evidence', {
                  defaultValue: 'The failed run, recent events, and manual-intervention evidence will be included.'
                })
              : t('device.rpa.replan.validation_evidence', {
                  defaultValue: 'The active DSL and its validation errors will be included.'
                })}
          </Typography.Text>
          <Input.TextArea
            value={replanObjective}
            rows={4}
            maxLength={2_000}
            onChange={(event) => setReplanObjective(event.target.value)}
          />
        </Space>
      </Modal>

      <RpaSaveToTemplateModal
        open={saveToTemplateOpen}
        dsl={templateDsl}
        defaultName={task.name}
        defaultGoal={task.goal}
        linkedTemplateId={templateLink?.templateId}
        source={{
          messageId: message.id,
          topicId: message.topicId,
          blockId: block.id,
          assistantId: message.assistantId
        }}
        onCancel={() => setSaveToTemplateOpen(false)}
        onSaved={saveTemplateLink}
      />
    </Workflow>
  )
}

const Workflow = styled.section`
  width: 100%;
  margin-top: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--color-border);
`

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;

  .ant-typography {
    margin: 0;
  }
`

const AdvancedDetails = styled.details`
  margin-top: 12px;

  summary {
    cursor: pointer;
    margin-bottom: 10px;
    color: var(--color-text-2);
  }
`

const TemplateLinkBar = styled.div`
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background-soft);
`

export default RpaInlineWorkflow

function toDeviceAgnosticTask(task: RpaTask): RpaTask {
  return task.deviceIds.length === 0 ? task : { ...task, deviceIds: [] }
}

function readSelectedTemplateId(metadata: Record<string, unknown>): string | undefined {
  const assets = metadata.rpaAssets
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return undefined
  const templateId = (assets as Record<string, unknown>).templateId
  return typeof templateId === 'string' && templateId.trim() ? templateId.trim() : undefined
}
