import { loggerService } from '@logger'
import {
  isAutoEnableImageGenerationModel,
  isGenerateImageModel,
  isGenerateImageModels,
  isMandatoryWebSearchModel,
  isVisionModel,
  isVisionModels,
  isWebSearchModel
} from '@renderer/config/models'
import db from '@renderer/databases'
import { useAssistant } from '@renderer/hooks/useAssistant'
import { useInputText } from '@renderer/hooks/useInputText'
import { useMessageOperations, useTopicLoading } from '@renderer/hooks/useMessageOperations'
import { useProviders } from '@renderer/hooks/useProvider'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTextareaResize } from '@renderer/hooks/useTextareaResize'
import { useTimer } from '@renderer/hooks/useTimer'
import {
  InputbarToolsProvider,
  useInputbarToolsDispatch,
  useInputbarToolsInternalDispatch,
  useInputbarToolsState
} from '@renderer/pages/home/Inputbar/context/InputbarToolsProvider'
import { fetchMcpTools } from '@renderer/services/ApiService'
import { getDefaultTopic } from '@renderer/services/AssistantService'
import { CacheService } from '@renderer/services/CacheService'
import { deviceChatCommandService } from '@renderer/services/DeviceChatCommandService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import FileManager from '@renderer/services/FileManager'
import { checkRateLimit, getAssistantMessage, getUserMessage } from '@renderer/services/MessagesService'
import {
  adaptRpaTopicOverrideForAssistant,
  type RpaTopicOverrideSwitchDecision
} from '@renderer/services/rpa/EffectiveRpaContextResolver'
import { resolveEffectiveRpaRoleContext } from '@renderer/services/rpa/EffectiveRpaRoleContextResolver'
import { adaptAssistantProfileToRpaAppRole, rpaAppRoleRepository } from '@renderer/services/rpa/RpaAppRole'
import { rpaArtifactStore } from '@renderer/services/rpa/RpaArtifactStore'
import {
  createKnowledgeAssetCatalog,
  createRpaTemplateAssetCatalog
} from '@renderer/services/rpa/RpaAssistantAssetCatalog'
import { rpaAssistantProfileMigrationService } from '@renderer/services/rpa/RpaAssistantProfileMigrationService'
import { readRpaCutoverStateSync } from '@renderer/services/rpa/RpaCutoverGate'
import { defaultRpaModuleRegistry } from '@renderer/services/rpa/RpaDefaultRegistry'
import { type RpaDslSession, rpaDslSessionRepository } from '@renderer/services/rpa/RpaDslSession'
import { rpaFailureFingerprintRepository } from '@renderer/services/rpa/RpaFailureFingerprint'
import {
  isRpaSessionOrchestratorPreviewEnabled,
  isRpaSessionSupplementsEnabled
} from '@renderer/services/rpa/RpaFeatureFlags'
import {
  createKnowledgeRetrievalSource,
  createTemporaryIndexSource,
  rpaFederatedRetrievalService
} from '@renderer/services/rpa/RpaFederatedRetrievalService'
import { isRpaPlanningRequest } from '@renderer/services/rpa/RpaIntentDetector'
import { rpaKnowledgeRetrievalService } from '@renderer/services/rpa/RpaKnowledgeRetrievalService'
import { RpaPlannerService } from '@renderer/services/rpa/RpaPlannerService'
import {
  resolveRpaPlanningRequestError,
  rpaPlanningRequestCoordinator,
  type RpaPlanningRequestHandle
} from '@renderer/services/rpa/RpaPlanningRequestCoordinator'
import { rpaQuickCommandCompiler } from '@renderer/services/rpa/RpaQuickCommandCompiler'
import { rpaRolePromptRepository } from '@renderer/services/rpa/RpaRolePrompt'
import {
  bindTopicToRpaRole,
  consumeRpaRoleSessionRequest,
  readRpaRoleSessionRequest
} from '@renderer/services/rpa/RpaRoleSessionNavigation'
import { createRpaDslProvenance } from '@renderer/services/rpa/RpaRunContextSnapshot'
import { rpaSessionDraftRegistry } from '@renderer/services/rpa/RpaSessionDraftRegistry'
import { rpaSessionOrchestrator } from '@renderer/services/rpa/RpaSessionOrchestrator'
import { rpaSessionOutcomeService } from '@renderer/services/rpa/RpaSessionOutcomeService'
import { resolveRpaSessionRouting } from '@renderer/services/rpa/RpaSessionRoutingPolicy'
import {
  rpaSessionSupplementRepository,
  rpaSessionSupplementService
} from '@renderer/services/rpa/RpaSessionSupplement'
import {
  rpaSessionSupplementResolver,
  type RpaSessionSupplementSourceAvailability
} from '@renderer/services/rpa/RpaSessionSupplementResolver'
import { rpaSessionTelemetryService } from '@renderer/services/rpa/RpaSessionTelemetryService'
import { RpaSkillCompiler } from '@renderer/services/rpa/RpaSkillCompiler'
import { rpaSkillRepository } from '@renderer/services/rpa/RpaSkillRepository'
import {
  rpaArtifactExtractionService,
  rpaContextSnapshotService,
  type RpaTemporaryArtifactIndex
} from '@renderer/services/rpa/RpaSupplementContext'
import { rpaTaskLifecycleService } from '@renderer/services/rpa/RpaTaskLifecycleService'
import { resolveStableRpaTaskSessionState } from '@renderer/services/rpa/RpaTaskSessionProtocol'
import { rpaTemplateRepository } from '@renderer/services/rpa/RpaTemplateRepository'
import { rpaTopicContextOverrideRepository } from '@renderer/services/rpa/RpaTopicContextOverride'
import { spanManagerService } from '@renderer/services/SpanManagerService'
import { estimateTextTokens as estimateTxtTokens, estimateUserPromptUsage } from '@renderer/services/TokenService'
import WebSearchService from '@renderer/services/WebSearchService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { upsertManyBlocks } from '@renderer/store/messageBlock'
import { newMessagesActions } from '@renderer/store/newMessage'
import { sendMessage as _sendMessage } from '@renderer/store/thunk/messageThunk'
import { saveMessageAndBlocksToDB, updateMessageAndBlocksThunk } from '@renderer/store/thunk/messageThunk'
import {
  type Assistant,
  type FileMetadata,
  type KnowledgeBase,
  type Model,
  type Topic,
  TopicType
} from '@renderer/types'
import type { MessageInputBaseParams } from '@renderer/types/newMessage'
import { AssistantMessageStatus, MessageBlockStatus } from '@renderer/types/newMessage'
import { delay } from '@renderer/utils'
import { getSendMessageShortcutLabel } from '@renderer/utils/input'
import { createMainTextBlock } from '@renderer/utils/messageUtils/create'
import { documentExts, imageExts, textExts } from '@shared/config/constant'
import { Button, Modal, Space } from 'antd'
import { debounce } from 'lodash'
import type { FC } from 'react'
import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { InputbarCore } from './components/InputbarCore'
import InputbarTools from './InputbarTools'
import KnowledgeBaseInput from './KnowledgeBaseInput'
import MentionModelsInput from './MentionModelsInput'
import { getInputbarConfig } from './registry'
import TokenCount from './TokenCount'

const logger = loggerService.withContext('Inputbar')

const INPUTBAR_DRAFT_CACHE_KEY = 'inputbar-draft'
const DRAFT_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours
const handledRpaRoleSessionRequests = new Set<string>()
const rpaPlanner = new RpaPlannerService({
  registry: defaultRpaModuleRegistry,
  skillRepository: rpaSkillRepository,
  skillCompiler: new RpaSkillCompiler(defaultRpaModuleRegistry),
  failureFingerprintRepository: rpaFailureFingerprintRepository
})

const getMentionedModelsCacheKey = (assistantId: string) => `inputbar-mentioned-models-${assistantId}`

const getValidatedCachedModels = (assistantId: string): Model[] => {
  const cached = CacheService.get<Model[]>(getMentionedModelsCacheKey(assistantId))
  if (!Array.isArray(cached)) return []
  return cached.filter((model) => model?.id && model?.name)
}

interface Props {
  assistant: Assistant
  setActiveTopic: (topic: Topic) => void
  topic: Topic
  rpaAvailable?: boolean
}

type ProviderActionHandlers = {
  resizeTextArea: () => void
  addNewTopic: () => void
  duplicateRpaTask: () => void
  endRpaTask: () => void
  clearTopic: () => void
  onNewContext: () => void
  onTextChange: (updater: string | ((prev: string) => string)) => void
  toggleExpanded: (nextState?: boolean) => void
}

interface InputbarInnerProps extends Props {
  actionsRef: React.RefObject<ProviderActionHandlers>
}

const Inputbar: FC<Props> = ({ assistant: initialAssistant, setActiveTopic, topic, rpaAvailable }) => {
  const actionsRef = useRef<ProviderActionHandlers>({
    resizeTextArea: () => {},
    addNewTopic: () => {},
    duplicateRpaTask: () => {},
    endRpaTask: () => {},
    clearTopic: () => {},
    onNewContext: () => {},
    onTextChange: () => {},
    toggleExpanded: () => {}
  })

  const [initialMentionedModels] = useState(() => getValidatedCachedModels(initialAssistant.id))

  const initialState = useMemo(
    () => ({
      files: [] as FileMetadata[],
      mentionedModels: initialMentionedModels,
      selectedKnowledgeBases: initialAssistant.knowledge_bases ?? [],
      isExpanded: false,
      couldAddImageFile: false,
      extensions: [] as string[]
    }),
    [initialMentionedModels, initialAssistant.knowledge_bases]
  )

  return (
    <InputbarToolsProvider
      initialState={initialState}
      actions={{
        resizeTextArea: () => actionsRef.current.resizeTextArea(),
        addNewTopic: () => actionsRef.current.addNewTopic(),
        duplicateRpaTask: () => actionsRef.current.duplicateRpaTask(),
        endRpaTask: () => actionsRef.current.endRpaTask(),
        clearTopic: () => actionsRef.current.clearTopic(),
        onNewContext: () => actionsRef.current.onNewContext(),
        onTextChange: (updater) => actionsRef.current.onTextChange(updater),
        toggleExpanded: (next) => actionsRef.current.toggleExpanded(next)
      }}>
      <InputbarInner
        assistant={initialAssistant}
        setActiveTopic={setActiveTopic}
        topic={topic}
        actionsRef={actionsRef}
        rpaAvailable={rpaAvailable}
      />
    </InputbarToolsProvider>
  )
}

const InputbarInner: FC<InputbarInnerProps> = ({
  assistant: initialAssistant,
  setActiveTopic,
  topic,
  actionsRef,
  rpaAvailable
}) => {
  const scope = topic.type ?? TopicType.Chat
  const config = getInputbarConfig(scope)

  const { files, mentionedModels, selectedKnowledgeBases } = useInputbarToolsState()
  const { setFiles, setMentionedModels, setSelectedKnowledgeBases } = useInputbarToolsDispatch()
  const { setCouldAddImageFile } = useInputbarToolsInternalDispatch()

  const { text, setText } = useInputText({
    initialValue: CacheService.get<string>(INPUTBAR_DRAFT_CACHE_KEY) ?? '',
    onChange: (value) => CacheService.set(INPUTBAR_DRAFT_CACHE_KEY, value, DRAFT_CACHE_TTL)
  })
  const {
    textareaRef,
    resize: resizeTextArea,
    focus: focusTextarea,
    setExpanded,
    isExpanded: textareaIsExpanded,
    customHeight,
    setCustomHeight
  } = useTextareaResize({
    maxHeight: 500,
    minHeight: 30
  })

  const { assistant, addTopic, model, setModel, updateAssistant } = useAssistant(initialAssistant.id)
  const { sendMessageShortcut, showInputEstimatedTokens, enableQuickPanelTriggers } = useSettings()
  const [estimateTokenCount, setEstimateTokenCount] = useState(0)
  const [contextCount, setContextCount] = useState({ current: 0, max: 0 })

  const { t } = useTranslation()
  const { pauseMessages } = useMessageOperations(topic)
  const loading = useTopicLoading(topic)
  const dispatch = useAppDispatch()
  const isVisionAssistant = useMemo(() => isVisionModel(model), [model])
  const isGenerateImageAssistant = useMemo(() => isGenerateImageModel(model), [model])
  const { setTimeoutTimer } = useTimer()
  const isMultiSelectMode = useAppSelector((state) => state.runtime.chat.isMultiSelectMode)
  const knowledgeBases = useAppSelector((state) => state.knowledge.bases)
  const { providers } = useProviders()

  const isVisionSupported = useMemo(
    () =>
      (mentionedModels.length > 0 && isVisionModels(mentionedModels)) ||
      (mentionedModels.length === 0 && isVisionAssistant),
    [mentionedModels, isVisionAssistant]
  )

  const isGenerateImageSupported = useMemo(
    () =>
      (mentionedModels.length > 0 && isGenerateImageModels(mentionedModels)) ||
      (mentionedModels.length === 0 && isGenerateImageAssistant),
    [mentionedModels, isGenerateImageAssistant]
  )

  const canAddImageFile = useMemo(() => {
    return isVisionSupported || isGenerateImageSupported
  }, [isGenerateImageSupported, isVisionSupported])

  const canAddTextFile = useMemo(() => {
    return isVisionSupported || (!isVisionSupported && !isGenerateImageSupported)
  }, [isGenerateImageSupported, isVisionSupported])

  const supportedExts = useMemo(() => {
    if (canAddImageFile && canAddTextFile) {
      return [...imageExts, ...documentExts, ...textExts]
    }

    if (canAddImageFile) {
      return [...imageExts]
    }

    if (canAddTextFile) {
      return [...documentExts, ...textExts]
    }

    return []
  }, [canAddImageFile, canAddTextFile])

  useEffect(() => {
    setCouldAddImageFile(canAddImageFile)
  }, [canAddImageFile, setCouldAddImageFile])

  const onUnmount = useEffectEvent((id: string) => {
    CacheService.set(getMentionedModelsCacheKey(id), mentionedModels, DRAFT_CACHE_TTL)
  })

  useEffect(() => {
    return () => onUnmount(assistant.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant.id])

  const defaultPlaceholderText = enableQuickPanelTriggers
    ? t('chat.input.placeholder', { key: getSendMessageShortcutLabel(sendMessageShortcut) })
    : t('chat.input.placeholder_without_triggers', {
        key: getSendMessageShortcutLabel(sendMessageShortcut),
        defaultValue: t('chat.input.placeholder', {
          key: getSendMessageShortcutLabel(sendMessageShortcut)
        })
      })
  const roleScopedRpaInput =
    resolveRpaSessionRouting({
      rpaAvailable: Boolean(rpaAvailable),
      roleId: topic.rpaRoleId,
      legacyIntentMatched: false,
      cutoverState: readRpaCutoverStateSync(),
      previewEnabled: isRpaSessionOrchestratorPreviewEnabled()
    }).mode === 'session_orchestrator'
  const placeholderText = roleScopedRpaInput
    ? t('device.rpa.chat_placeholder', {
        defaultValue: 'Describe the task to perform on the selected devices. Press Enter to generate the workflow.'
      })
    : defaultPlaceholderText

  const sendMessage = useCallback(async () => {
    const routingDecision = resolveRpaSessionRouting({
      rpaAvailable: Boolean(rpaAvailable),
      roleId: topic.rpaRoleId,
      legacyIntentMatched: isRpaPlanningRequest(text),
      cutoverState: readRpaCutoverStateSync(),
      previewEnabled: isRpaSessionOrchestratorPreviewEnabled()
    })
    const useSessionOrchestrator = routingDecision.mode === 'session_orchestrator'
    const shouldGenerateRpa = useSessionOrchestrator || routingDecision.mode === 'compatibility'
    if (routingDecision.mode === 'blocked') {
      rpaSessionTelemetryService.record('generic_fallback_attempt', {
        reason: routingDecision.reason
      })
      Modal.error({
        title: t('device.rpa.non_executable_title', { defaultValue: 'RPA task unavailable' }),
        content: routingDecision.reason
      })
      return
    }
    if (routingDecision.mode === 'compatibility') {
      rpaSessionTelemetryService.record(routingDecision.rollbackActive ? 'rollback_routing' : 'compatibility_routing', {
        reason: routingDecision.reason
      })
    } else if (routingDecision.mode === 'session_orchestrator' && routingDecision.cutoverEnabled) {
      rpaSessionTelemetryService.record('cutover_routing', { reason: routingDecision.reason })
    }
    if (shouldGenerateRpa) {
      const goal = text.trim()
      if (!goal) return
      setText('')
      setTimeoutTimer('sendRpaMessage', () => resizeTextArea(), 0)
      focusTextarea()

      const baseUserMessage: MessageInputBaseParams = { assistant, topic, content: goal }
      const { message: userMessage, blocks: userBlocks } = getUserMessage(baseUserMessage)
      const assistantMessage = getAssistantMessage({ assistant, topic })
      assistantMessage.askId = userMessage.id
      assistantMessage.status = AssistantMessageStatus.PROCESSING
      const requestId = crypto.randomUUID()
      const requestedAt = Date.now()
      let auditedSession: Awaited<ReturnType<typeof rpaDslSessionRepository.create>> | undefined
      let routedOutcome: ReturnType<typeof rpaSessionOrchestrator.route> | undefined
      let planningRequest: RpaPlanningRequestHandle | undefined
      let contextSnapshotId: string | undefined
      let stableInteractionState: RpaDslSession['interactionState'] | undefined

      await saveMessageAndBlocksToDB(topic.id, userMessage, userBlocks)
      await saveMessageAndBlocksToDB(topic.id, assistantMessage, [])
      dispatch(newMessagesActions.addMessage({ topicId: topic.id, message: userMessage }))
      dispatch(upsertManyBlocks(userBlocks))
      dispatch(newMessagesActions.addMessage({ topicId: topic.id, message: assistantMessage }))

      const finalizeRpaMessage = async (
        content: string,
        status: AssistantMessageStatus.SUCCESS | AssistantMessageStatus.ERROR,
        metadata?: Record<string, unknown>
      ) => {
        const block = createMainTextBlock(assistantMessage.id, content, {
          status: status === AssistantMessageStatus.SUCCESS ? MessageBlockStatus.SUCCESS : MessageBlockStatus.ERROR,
          metadata
        })
        const finalizedMessage = {
          ...assistantMessage,
          blocks: [block.id],
          status
        }

        logger.info('Finalizing inline RPA message', {
          messageId: finalizedMessage.id,
          status,
          hasWorkflow: Boolean(metadata?.rpaTask)
        })

        dispatch(upsertManyBlocks([block]))
        dispatch(
          newMessagesActions.updateMessage({
            topicId: topic.id,
            messageId: finalizedMessage.id,
            updates: finalizedMessage
          })
        )

        try {
          await dispatch(updateMessageAndBlocksThunk(topic.id, finalizedMessage, [block]))
          logger.info('Inline RPA message finalized', {
            messageId: finalizedMessage.id,
            status
          })
        } catch (persistenceError) {
          logger.error('Failed to persist finalized inline RPA message', {
            error: persistenceError,
            errorMessage: persistenceError instanceof Error ? persistenceError.message : String(persistenceError),
            messageId: finalizedMessage.id
          })
        }
      }

      try {
        const { profile } = await rpaAssistantProfileMigrationService.getOrMigrateAssistant(assistant, {
          availableKnowledgeIds: knowledgeBases.map((knowledge) => knowledge.id)
        })
        const [skills, templates, allRoles, rolePrompts, artifacts] = await Promise.all([
          rpaSkillRepository.toCatalog(),
          rpaTemplateRepository.getAll(),
          rpaAppRoleRepository.getAll(),
          rpaRolePromptRepository.getAll(),
          rpaArtifactStore.getAll()
        ])
        const catalogs = {
          knowledge: createKnowledgeAssetCatalog(knowledgeBases),
          skills,
          templates: createRpaTemplateAssetCatalog(templates)
        }
        const knowledgeAvailability = await rpaKnowledgeRetrievalService.getAvailability(
          knowledgeBases.map((knowledge) => knowledge.id)
        )
        let topicOverride = await rpaTopicContextOverrideRepository.getByTopicId(topic.id)
        if (topicOverride && topicOverride.assistantId !== assistant.id) {
          const decision = await promptTopicOverrideSwitchDecision(t)
          if (!decision) throw new Error(t('device.rpa.topic_override_switch_cancelled'))
          const adapted = adaptRpaTopicOverrideForAssistant(topicOverride, assistant.id, decision, catalogs)
          if (adapted) topicOverride = await rpaTopicContextOverrideRepository.save(adapted)
          else {
            await rpaTopicContextOverrideRepository.remove(topic.id)
            topicOverride = undefined
          }
        }
        const availableModels = providers.flatMap((provider) => provider.models)
        if (!availableModels.some((candidate) => candidate.id === assistant.model?.id)) {
          availableModels.push(assistant.model)
        }
        const compatibilityRole = adaptAssistantProfileToRpaAppRole({
          profile,
          assistantName: assistant.name,
          appPackages: topicOverride?.appPackages
        })
        const requestedRoleId = topic.rpaRoleId
        const selectedRole = requestedRoleId
          ? allRoles.find((candidate) => candidate.id === requestedRoleId)
          : undefined
        if (requestedRoleId && !selectedRole) throw new Error(`Selected RPA Role was not found: ${requestedRoleId}`)
        const primaryRole = selectedRole ?? compatibilityRole
        const supportingRoles = selectedRole
          ? selectedRole.supportingRoleIds
              .map((roleId) => allRoles.find((candidate) => candidate.id === roleId))
              .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
          : []
        const existingSession = (await rpaDslSessionRepository.getAll()).find(
          (session) =>
            session.topicCompatibilityId === topic.id &&
            session.primaryRole?.id === primaryRole.id &&
            session.primaryRole.version === primaryRole.version
        )
        let session =
          existingSession ??
          (await rpaDslSessionRepository.create({
            goal,
            primaryRole: { id: primaryRole.id, version: primaryRole.version },
            supportingRoles: supportingRoles.map((role) => ({ id: role.id, version: role.version })),
            topicCompatibilityId: topic.id
          }))
        stableInteractionState = resolveStableRpaTaskSessionState(session.interactionState, session.interactionEvents)
        let planningGoal = goal
        let revisionInstruction: string | undefined
        let baseTask: unknown
        let clarificationAnswers: unknown[] | undefined
        if (useSessionOrchestrator) {
          routedOutcome = rpaSessionOrchestrator.route(
            {
              requestId,
              sessionId: session.id,
              baseRevision: session.activeRevisionVersion,
              role: { id: primaryRole.id, version: primaryRole.version },
              input: goal,
              topicCompatibilityId: topic.id
            },
            session
          )
          if (routedOutcome.outcome === 'non_executable') {
            rpaSessionTelemetryService.record('non_executable_result', {
              sessionId: session.id,
              requestId,
              reason: routedOutcome.reason
            })
            session = await rpaDslSessionRepository.recordInteraction(session.id, session.version, {
              requestId,
              outcome: routedOutcome.outcome,
              phase: 'rejected',
              text: goal,
              stateAfter: routedOutcome.stateAfter,
              sourceRevision: routedOutcome.sourceRevision,
              reason: routedOutcome.reason
            })
            auditedSession = session
            await finalizeRpaMessage(routedOutcome.reason, AssistantMessageStatus.ERROR, {
              rpaSessionId: session.id,
              rpaOutcome: routedOutcome.outcome
            })
            return
          }
          if (routedOutcome.outcome === 'create_new_task') {
            const newGoal = rpaSessionOutcomeService.extractNewTaskGoal(goal)
            if (!newGoal) {
              rpaSessionTelemetryService.record('non_executable_result', {
                sessionId: session.id,
                requestId,
                reason: 'A new task command requires an explicit goal'
              })
              session = await rpaDslSessionRepository.recordInteraction(session.id, session.version, {
                requestId,
                outcome: routedOutcome.outcome,
                phase: 'rejected',
                text: goal,
                stateAfter: session.interactionState,
                sourceRevision: session.activeRevisionVersion,
                reason: 'A new task command requires an explicit goal'
              })
              auditedSession = session
              await finalizeRpaMessage(
                'Include the new task goal after the new-task command.',
                AssistantMessageStatus.ERROR,
                { rpaSessionId: session.id, rpaOutcome: 'non_executable' }
              )
              return
            }
            session = await rpaDslSessionRepository.create({
              goal: newGoal,
              primaryRole: { id: primaryRole.id, version: primaryRole.version },
              supportingRoles: supportingRoles.map((role) => ({ id: role.id, version: role.version })),
              topicCompatibilityId: topic.id
            })
            stableInteractionState = resolveStableRpaTaskSessionState(
              session.interactionState,
              session.interactionEvents
            )
            planningGoal = newGoal
          }
          session = await rpaDslSessionRepository.recordInteraction(session.id, session.version, {
            requestId,
            outcome: routedOutcome.outcome,
            phase: 'received',
            text: goal,
            stateAfter: routedOutcome.stateAfter,
            sourceRevision: routedOutcome.outcome === 'create_new_task' ? undefined : routedOutcome.sourceRevision,
            reason: routedOutcome.reason
          })
          auditedSession = session
          if (routedOutcome.outcome === 'explain_dsl') {
            const outcome = await rpaSessionOutcomeService.explain(session)
            session = await rpaDslSessionRepository.recordInteraction(session.id, session.version, {
              requestId,
              outcome: routedOutcome.outcome,
              phase: outcome.success ? 'completed' : 'rejected',
              text: goal,
              stateAfter: outcome.stateAfter,
              sourceRevision: routedOutcome.sourceRevision,
              reason: outcome.message
            })
            auditedSession = session
            await finalizeRpaMessage(
              outcome.message,
              outcome.success ? AssistantMessageStatus.SUCCESS : AssistantMessageStatus.ERROR,
              { rpaSessionId: session.id, rpaOutcome: outcome.kind }
            )
            return
          }
          if (routedOutcome.outcome === 'control_run' && routedOutcome.runControlAction) {
            const outcome = await rpaSessionOutcomeService.control(session, routedOutcome.runControlAction)
            if (outcome.newRunId) {
              session = await rpaDslSessionRepository.link(session.id, session.version, 'run', outcome.newRunId)
            }
            session = await rpaDslSessionRepository.recordInteraction(session.id, session.version, {
              requestId,
              outcome: routedOutcome.outcome,
              phase: outcome.success ? 'completed' : 'rejected',
              text: goal,
              stateAfter: outcome.stateAfter,
              sourceRevision: routedOutcome.sourceRevision,
              reason: outcome.message
            })
            auditedSession = session
            await finalizeRpaMessage(
              outcome.message,
              outcome.success ? AssistantMessageStatus.SUCCESS : AssistantMessageStatus.ERROR,
              {
                rpaSessionId: session.id,
                rpaOutcome: outcome.kind,
                rpaRunId: outcome.newRunId ?? outcome.runId
              }
            )
            return
          }
          if (routedOutcome.outcome === 'answer_clarification') {
            const pending = session.clarifications.find(
              (clarification) => clarification.required && !clarification.answer
            )
            if (!pending) throw new Error('The task session has no pending clarification to answer')
            session = await rpaDslSessionRepository.answerClarification(session.id, session.version, pending.id, goal)
            auditedSession = session
            const unresolved = session.clarifications.find(
              (clarification) => clarification.required && !clarification.answer
            )
            if (unresolved) {
              session = await rpaDslSessionRepository.recordInteraction(session.id, session.version, {
                requestId,
                outcome: routedOutcome.outcome,
                phase: 'completed',
                text: goal,
                stateAfter: 'needs_clarification',
                sourceRevision: routedOutcome.sourceRevision,
                reason: 'A further required clarification remains unanswered'
              })
              auditedSession = session
              await finalizeRpaMessage(unresolved.question, AssistantMessageStatus.SUCCESS, {
                rpaSessionId: session.id,
                rpaOutcome: 'answer_clarification',
                rpaClarificationId: unresolved.id
              })
              return
            }
            planningGoal = session.goal
            clarificationAnswers = session.clarifications.map(({ id, question, answer }) => ({ id, question, answer }))
          } else if (routedOutcome.outcome === 'revise_dsl') {
            planningGoal = session.goal
            revisionInstruction = goal
            baseTask = session.revisions.find((revision) => revision.version === session.activeRevisionVersion)?.dsl
          }
        }
        const effectiveContext = resolveEffectiveRpaRoleContext({
          topicId: topic.id,
          primaryRole,
          supportingRoles,
          compatibilityProfile: selectedRole?.compatibility ? profile : selectedRole ? undefined : profile,
          catalogs,
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
          topicOverride
        })
        if (!effectiveContext.executable) {
          const issues = [
            ...effectiveContext.roleIssues.filter((issue) => issue.severity === 'error').map((issue) => issue.message),
            ...effectiveContext.missingDependencies.map((issue) => issue.message),
            ...effectiveContext.warnings
              .filter((warning) => warning.code === 'assistant_switch_decision_required')
              .map((warning) => warning.message),
            ...Object.values(effectiveContext.capabilityChecks)
              .filter((check) => !check.compatible)
              .map((check) => check.message)
          ].filter((issue): issue is string => Boolean(issue))
          const issueText = issues.join('; ') || 'RPA effective context is not executable'
          if (useSessionOrchestrator) {
            session = await rpaDslSessionRepository.markNonExecutable(session.id, session.version, issueText)
            session = await rpaDslSessionRepository.recordInteraction(session.id, session.version, {
              requestId,
              outcome: 'non_executable',
              phase: 'completed',
              text: goal,
              stateAfter: 'non_executable',
              sourceRevision: session.activeRevisionVersion,
              reason: issueText
            })
            auditedSession = session
            await finalizeRpaMessage(issueText, AssistantMessageStatus.ERROR, {
              rpaSessionId: session.id,
              rpaOutcome: 'non_executable'
            })
            return
          }
          throw new Error(issueText)
        }
        const knowledgeContext = await rpaKnowledgeRetrievalService.retrieve({
          knowledgeBaseIds: effectiveContext.assets.knowledge.map((knowledge) => knowledge.id),
          appPackage: effectiveContext.appPackages[0],
          taskGoal: planningGoal,
          categories: ['app_sop', 'page_state_explanation', 'locator_guidance', 'failure_case', 'recovery_guidance']
        })
        const selectedMcpTools = await fetchMcpTools(assistant)
        const mcpToolsByServer = selectedMcpTools.reduce<Record<string, string[]>>((groups, tool) => {
          const names = groups[tool.serverId] ?? []
          if (!names.includes(tool.name)) names.push(tool.name)
          groups[tool.serverId] = names
          return groups
        }, {})
        let supplementContext
        let federatedEvidence: unknown[] | undefined
        let supplementRevision = 0
        if (useSessionOrchestrator && isRpaSessionSupplementsEnabled()) {
          let supplements = await rpaSessionSupplementService.initialize(session.id, {
            id: primaryRole.id,
            version: primaryRole.version
          })
          const availability: RpaSessionSupplementSourceAvailability[] = []
          const temporaryIndexes: RpaTemporaryArtifactIndex[] = []
          const roleKnowledgeIds = new Set(effectiveContext.assets.knowledge.map((knowledge) => knowledge.id))
          const sessionKnowledgeIds = selectedKnowledgeBases
            .map((knowledge) => knowledge.id)
            .filter((knowledgeId) => !roleKnowledgeIds.has(knowledgeId))
          for (const knowledgeId of sessionKnowledgeIds) {
            const alreadyBound = supplements.bindings.some(
              (binding) =>
                binding.sourceType === 'knowledge' &&
                binding.sourceId === knowledgeId &&
                !['removed', 'expired', 'promoted'].includes(binding.lifecycle)
            )
            if (!alreadyBound) {
              supplements = await rpaSessionSupplementService.bind(
                {
                  sessionId: session.id,
                  sourceType: 'knowledge',
                  sourceId: knowledgeId,
                  scope: 'session',
                  requirement: 'optional',
                  lifecycle: 'ready',
                  retention: { mode: 'session' }
                },
                supplements.supplementRevision,
                { role: supplements.role }
              )
            }
            availability.push({ sourceType: 'knowledge', sourceId: knowledgeId, status: 'ready' })
          }
          for (const file of files) {
            const extraction = await rpaArtifactExtractionService.extract({
              sessionId: session.id,
              requestId,
              file,
              signal: undefined
            })
            temporaryIndexes.push(extraction.index)
            supplements = await rpaSessionSupplementService.bind(
              {
                sessionId: session.id,
                sourceType: 'artifact',
                sourceId: extraction.artifact.id,
                sourceVersion: String(extraction.artifact.version),
                contentHash: extraction.artifact.contentHash,
                scope: 'session',
                requirement: 'optional',
                lifecycle:
                  extraction.index.status === 'ready' || extraction.index.status === 'degraded'
                    ? extraction.index.status
                    : 'blocked',
                retention: { mode: 'session' }
              },
              supplements.supplementRevision,
              { role: supplements.role }
            )
            supplements = await rpaSessionSupplementService.bind(
              {
                sessionId: session.id,
                sourceType: 'temporary_index',
                sourceId: extraction.index.id,
                sourceVersion: extraction.index.extractorVersion,
                contentHash: extraction.index.artifactHash,
                scope: 'session',
                requirement: 'optional',
                lifecycle:
                  extraction.index.status === 'ready' || extraction.index.status === 'degraded'
                    ? extraction.index.status
                    : 'blocked',
                retention: { mode: 'session' }
              },
              supplements.supplementRevision,
              { role: supplements.role }
            )
            availability.push(
              {
                sourceType: 'artifact' as const,
                sourceId: extraction.artifact.id,
                status: extraction.index.status === 'blocked' ? ('blocked' as const) : ('ready' as const),
                version: String(extraction.artifact.version),
                contentHash: extraction.artifact.contentHash
              },
              {
                sourceType: 'temporary_index' as const,
                sourceId: extraction.index.id,
                status:
                  extraction.index.status === 'blocked'
                    ? ('blocked' as const)
                    : extraction.index.status === 'degraded'
                      ? ('degraded' as const)
                      : ('ready' as const),
                version: extraction.index.extractorVersion,
                contentHash: extraction.index.artifactHash,
                message: extraction.index.warnings.join('; ') || undefined
              }
            )
            if (extraction.index.status !== 'ready') {
              rpaSessionTelemetryService.record(
                extraction.index.status === 'blocked'
                  ? 'supplement_extraction_failure'
                  : 'supplement_source_degradation',
                {
                  sessionId: session.id,
                  requestId,
                  reason: extraction.index.warnings.join('; ') || extraction.index.status
                }
              )
            }
          }
          for (const binding of supplements.bindings) {
            if (
              binding.sourceType !== 'tool_selection' ||
              ['removed', 'expired', 'promoted'].includes(binding.lifecycle)
            ) {
              continue
            }
            const selectedNames = mcpToolsByServer[binding.sourceId]
            const boundNames = [...binding.toolNames].sort()
            if (selectedNames && JSON.stringify([...selectedNames].sort()) === JSON.stringify(boundNames)) continue
            supplements = await rpaSessionSupplementService.transition(
              session.id,
              binding.id,
              'removed',
              supplements.supplementRevision,
              { actor: 'system', requestId, reason: 'The chat MCP tool selection changed' }
            )
          }
          for (const [serverId, toolNames] of Object.entries(mcpToolsByServer)) {
            const alreadyBound = supplements.bindings.some(
              (binding) =>
                binding.sourceType === 'tool_selection' &&
                binding.sourceId === serverId &&
                !['removed', 'expired', 'promoted'].includes(binding.lifecycle) &&
                JSON.stringify([...binding.toolNames].sort()) === JSON.stringify([...toolNames].sort())
            )
            if (alreadyBound) continue
            supplements = await rpaSessionSupplementService.bind(
              {
                sessionId: session.id,
                sourceType: 'tool_selection',
                sourceId: serverId,
                toolNames,
                scope: 'session',
                requirement: 'optional',
                lifecycle: 'ready',
                retention: { mode: 'session' }
              },
              supplements.supplementRevision,
              { role: supplements.role, toolAllowlist: mcpToolsByServer }
            )
          }
          supplementContext = rpaSessionSupplementResolver.resolve({
            effectiveRoleContext: effectiveContext,
            supplements,
            expectedSupplementRevision: supplements.supplementRevision,
            permissions: {
              role: supplements.role,
              workspaceProviderIds: [],
              toolAllowlist: mcpToolsByServer
            },
            requestId,
            availability
          })
          supplementRevision = supplementContext.supplementRevision
          const sessionKnowledgeContext = sessionKnowledgeIds.length
            ? await rpaKnowledgeRetrievalService.retrieve({
                knowledgeBaseIds: sessionKnowledgeIds,
                appPackage: effectiveContext.appPackages[0],
                taskGoal: planningGoal,
                categories: [
                  'app_sop',
                  'page_state_explanation',
                  'locator_guidance',
                  'failure_case',
                  'recovery_guidance'
                ]
              })
            : undefined
          const federated = await rpaFederatedRetrievalService.retrieve({
            query: planningGoal,
            signal: undefined,
            sources: [
              createKnowledgeRetrievalSource({ id: 'role-knowledge', owner: 'role', result: knowledgeContext }),
              ...(sessionKnowledgeContext
                ? [
                    createKnowledgeRetrievalSource({
                      id: 'session-knowledge',
                      owner: 'session',
                      result: sessionKnowledgeContext,
                      required: false
                    })
                  ]
                : []),
              ...temporaryIndexes.map((index) => createTemporaryIndexSource(index))
            ]
          })
          if (!federated.executable)
            throw new Error(federated.sourceFailures.map((failure) => failure.reason).join('; '))
          if (federated.conflicts.length) {
            rpaSessionTelemetryService.record('supplement_conflict', {
              sessionId: session.id,
              requestId,
              reason: federated.conflicts.join('; ')
            })
          }
          if (federated.provenance.injectionAttempts) {
            rpaSessionTelemetryService.record('supplement_injection_attempt', {
              sessionId: session.id,
              requestId,
              reason: String(federated.provenance.injectionAttempts)
            })
          }
          if (federated.provenance.truncated) {
            rpaSessionTelemetryService.record('supplement_truncation', {
              sessionId: session.id,
              requestId,
              reason: `${federated.omissions.length} evidence item(s) omitted`
            })
          }
          if (federated.provenance.rerankerFallback) {
            rpaSessionTelemetryService.record('supplement_reranker_fallback', {
              sessionId: session.id,
              requestId,
              reason: federated.provenance.rerankerFallback
            })
          }
          federatedEvidence = federated.evidence
          const contextSnapshot = await rpaContextSnapshotService.create({
            sessionId: session.id,
            requestId,
            role: supplements.role,
            supplementRevision,
            model: effectiveContext.modelReferences.planner,
            evidence: federated.snapshotEvidence,
            conflicts: federated.conflicts,
            omissions: federated.omissions,
            providerCalls: [],
            ranking: {
              algorithm: 'rrf',
              version: federated.provenance.version,
              k: federated.provenance.k,
              reranker: federated.provenance.reranker,
              fallback: federated.provenance.rerankerFallback
            },
            policy: {
              truncated: federated.provenance.truncated,
              redacted: federated.snapshotEvidence.some((item) => item.boundedContent?.includes('[REDACTED]')),
              injectionAttempts: federated.provenance.injectionAttempts
            },
            retention: {
              evidenceExpiresAt: Date.now() + 7 * 24 * 60 * 60 * 1_000,
              auditExpiresAt: Date.now() + 365 * 24 * 60 * 60 * 1_000,
              tombstonedSourceIds: []
            }
          })
          contextSnapshotId = contextSnapshot.id
        }
        planningRequest = rpaPlanningRequestCoordinator.start({
          requestId,
          sessionId: session.id,
          baseRevision: session.activeRevisionVersion,
          expectedVersion: session.version,
          supplementRevision,
          contextSnapshotId,
          requestedAt,
          timeoutMs: 120_000
        })
        await rpaDslSessionRepository.recordPlanningRequest(session.id, {
          requestId,
          baseRevision: planningRequest.input.baseRevision,
          expectedVersion: planningRequest.input.expectedVersion,
          supplementRevision: planningRequest.input.supplementRevision,
          contextSnapshotId,
          status: 'pending',
          startedAt: requestedAt
        })
        const taskId = `rpa-task-${Date.now()}`
        const quickCommand =
          useSessionOrchestrator &&
          (routedOutcome?.outcome === 'create_dsl' || routedOutcome?.outcome === 'create_new_task')
            ? rpaQuickCommandCompiler.compile(planningGoal, { taskId, taskName: planningGoal.slice(0, 48) })
            : undefined
        const result = quickCommand
          ? undefined
          : await rpaPlanner.plan({
              goal: planningGoal,
              baseTask,
              revisionInstruction,
              clarificationAnswers,
              deviceIds: [],
              taskId,
              taskName: planningGoal.slice(0, 48),
              assistant,
              allowedTools: selectedMcpTools.map((tool) => tool.id),
              effectiveContext,
              knowledgeContext,
              remoteKnowledge: federatedEvidence,
              supplementContext,
              signal: planningRequest.signal
            })
        const currentSession = await rpaDslSessionRepository.getById(session.id)
        if (!currentSession) throw new Error(`RPA DSL session not found: ${session.id}`)
        const currentSupplements = await rpaSessionSupplementRepository.getBySessionId(session.id)
        planningRequest.assertCurrent(currentSession, currentSupplements?.supplementRevision ?? 0, contextSnapshotId)
        session = currentSession
        if (!quickCommand && result?.clarifications?.length) {
          session = await rpaDslSessionRepository.requestClarification(
            session.id,
            session.version,
            result.clarifications
          )
          if (useSessionOrchestrator && routedOutcome) {
            session = await rpaDslSessionRepository.recordInteraction(session.id, session.version, {
              requestId,
              outcome: routedOutcome.outcome,
              phase: 'completed',
              text: goal,
              stateAfter: 'needs_clarification',
              sourceRevision: routedOutcome.sourceRevision,
              reason: 'The Planner requested the minimum required task clarification'
            })
            auditedSession = session
          }
          planningRequest.release()
          await rpaDslSessionRepository.recordPlanningRequest(session.id, {
            requestId,
            baseRevision: planningRequest.input.baseRevision,
            expectedVersion: planningRequest.input.expectedVersion,
            supplementRevision: planningRequest.input.supplementRevision,
            status: 'accepted'
          })
          await finalizeRpaMessage(
            result.clarifications.map((item) => item.question).join('\n'),
            AssistantMessageStatus.SUCCESS,
            {
              rpaSessionId: session.id,
              rpaOutcome: 'clarification_required',
              rpaClarifications: result.clarifications
            }
          )
          return
        }
        if (!quickCommand && (!result?.success || !result.task)) {
          session = await rpaDslSessionRepository.recordPlanningFailure(session.id, session.version, {
            requestId,
            sourceRevision: routedOutcome?.sourceRevision,
            candidate: result?.rawResponse ?? '',
            issues: result?.issues ?? []
          })
          auditedSession = session
          throw new Error(result?.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ') || 'Plan invalid')
        }

        const task = {
          ...(quickCommand?.task ?? result!.task!),
          deviceIds: [],
          visionModel: effectiveContext.models.vision ?? assistant.model
        }
        const validationIssues = result?.issues ?? []
        const assetWarnings = result?.assetWarnings ?? []
        const provenance = {
          ...createRpaDslProvenance(effectiveContext, task.metadata),
          supplementRevision: planningRequest.input.supplementRevision,
          supplementalContextSnapshotId: contextSnapshotId
        }
        session = await rpaDslSessionRepository.appendRevision(
          session.id,
          task,
          effectiveContext.roleContext,
          { validate: (dsl) => ({ dsl, issues: validationIssues, executable: true }) },
          {
            expectedSessionVersion: session.version,
            source:
              routedOutcome?.outcome === 'revise_dsl' || routedOutcome?.outcome === 'answer_clarification'
                ? 'revised'
                : routedOutcome?.outcome === 'create_new_task'
                  ? 'generated'
                  : existingSession
                    ? 'revised'
                    : 'generated',
            humanReadableExplanation: `Generated an editable RPA DSL revision for: ${planningGoal}`,
            requestContext: {
              requestId,
              sessionId: session.id,
              baseRevision: planningRequest.input.baseRevision,
              expectedVersion: planningRequest.input.expectedVersion,
              supplementRevision: planningRequest.input.supplementRevision,
              contextSnapshotId,
              provenance
            }
          }
        )
        planningRequest.release()
        await rpaDslSessionRepository.recordPlanningRequest(session.id, {
          requestId,
          baseRevision: planningRequest.input.baseRevision,
          expectedVersion: planningRequest.input.expectedVersion,
          supplementRevision: planningRequest.input.supplementRevision,
          contextSnapshotId,
          status: 'accepted'
        })
        if (useSessionOrchestrator && routedOutcome) {
          session = await rpaDslSessionRepository.recordInteraction(session.id, session.version, {
            requestId,
            outcome: routedOutcome.outcome,
            phase: 'completed',
            text: goal,
            stateAfter: session.interactionState,
            sourceRevision: session.activeRevisionVersion,
            reason: 'The RPA DSL revision was generated and validated'
          })
          auditedSession = session
        }
        setFiles([])
        const generatedMessage = t('device.rpa.plan_generated', {
          defaultValue: 'The RPA workflow has been generated. Review and edit the timeline before running it.'
        })
        const warningMessage = assetWarnings.length
          ? `\n\n${t('device.rpa.degraded_generation_warning', {
              defaultValue: 'Degraded generation warnings'
            })}:\n${assetWarnings.map((warning) => `- ${warning.message}`).join('\n')}`
          : ''
        await finalizeRpaMessage(`${generatedMessage}${warningMessage}`, AssistantMessageStatus.SUCCESS, {
          rpaTask: task,
          rpaSessionId: session.id,
          rpaRevisionVersion: session.activeRevisionVersion,
          rpaContextSnapshotId: contextSnapshotId,
          rpaAssetWarnings: assetWarnings,
          rpaProvenance: provenance
        })
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error)
        const planningError = resolveRpaPlanningRequestError(error, planningRequest?.signal)
        if (planningRequest && auditedSession) {
          try {
            await rpaDslSessionRepository.recordPlanningRequest(auditedSession.id, {
              requestId,
              baseRevision: planningRequest.input.baseRevision,
              expectedVersion: planningRequest.input.expectedVersion,
              supplementRevision: planningRequest.input.supplementRevision,
              contextSnapshotId,
              status: planningError?.status ?? 'failed',
              reason: errorText
            })
          } catch (auditError) {
            logger.error('Failed to persist RPA planning request audit', { auditError, requestId })
          }
        }
        if (
          planningError &&
          planningRequest?.isCurrent() &&
          useSessionOrchestrator &&
          auditedSession &&
          routedOutcome &&
          stableInteractionState
        ) {
          try {
            const currentSession = await rpaDslSessionRepository.getById(auditedSession.id)
            if (currentSession?.interactionState === 'planning') {
              auditedSession = await rpaDslSessionRepository.recordInteraction(
                currentSession.id,
                currentSession.version,
                {
                  requestId,
                  outcome: routedOutcome.outcome,
                  phase: 'failed',
                  text: goal,
                  stateAfter: stableInteractionState,
                  sourceRevision: currentSession.activeRevisionVersion,
                  reason: errorText
                }
              )
            }
          } catch (auditError) {
            logger.error('Failed to restore RPA session after interrupted planning', { auditError, requestId })
          }
        } else if (!planningError && useSessionOrchestrator && auditedSession && routedOutcome) {
          try {
            auditedSession = await rpaDslSessionRepository.recordInteraction(
              auditedSession.id,
              auditedSession.version,
              {
                requestId,
                outcome: routedOutcome.outcome,
                phase: 'failed',
                text: goal,
                stateAfter: 'failed',
                sourceRevision: auditedSession.activeRevisionVersion,
                reason: errorText
              }
            )
          } catch (auditError) {
            logger.error('Failed to persist RPA session interaction failure', { auditError, requestId })
          }
        }
        planningRequest?.release()
        logger.error('Failed to generate inline RPA workflow', {
          error,
          errorMessage: errorText,
          goal,
          modelId: assistant.model?.id
        })
        await finalizeRpaMessage(errorText, AssistantMessageStatus.ERROR)
      }
      return
    }

    if (deviceChatCommandService.isDeviceCommand(text)) {
      try {
        const result = await deviceChatCommandService.run(text)
        const baseUserMessage: MessageInputBaseParams = { assistant, topic, content: text }
        const { message: userMessage, blocks: userBlocks } = getUserMessage(baseUserMessage)
        const assistantMessage = getAssistantMessage({ assistant, topic })
        assistantMessage.askId = userMessage.id
        assistantMessage.status = AssistantMessageStatus.SUCCESS
        const assistantBlock = createMainTextBlock(assistantMessage.id, result, {
          status: MessageBlockStatus.SUCCESS
        })
        assistantMessage.blocks = [assistantBlock.id]

        await saveMessageAndBlocksToDB(topic.id, userMessage, userBlocks)
        await saveMessageAndBlocksToDB(topic.id, assistantMessage, [assistantBlock])
        dispatch(newMessagesActions.addMessage({ topicId: topic.id, message: userMessage }))
        dispatch(upsertManyBlocks(userBlocks))
        dispatch(newMessagesActions.addMessage({ topicId: topic.id, message: assistantMessage }))
        dispatch(upsertManyBlocks([assistantBlock]))

        setText('')
        setTimeoutTimer('sendMessage_1', () => setText(''), 500)
        setTimeoutTimer('sendMessage_2', () => resizeTextArea(), 0)
        focusTextarea()
      } catch (error) {
        logger.warn('Failed to run device chat command:', error as Error)
        window.toast.error(error instanceof Error ? error.message : String(error))
      }
      return
    }

    if (checkRateLimit(assistant)) {
      return
    }

    logger.info('Starting to send message')

    const parent = spanManagerService.startTrace(
      { topicId: topic.id, name: 'sendMessage', inputs: text },
      mentionedModels.length > 0 ? mentionedModels : [assistant.model]
    )
    EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE, { topicId: topic.id, traceId: parent?.spanContext().traceId })

    try {
      const uploadedFiles = await FileManager.uploadFiles(files)

      const baseUserMessage: MessageInputBaseParams = { assistant, topic, content: text }
      if (uploadedFiles) {
        baseUserMessage.files = uploadedFiles
      }
      if (mentionedModels.length) {
        baseUserMessage.mentions = mentionedModels
      }

      baseUserMessage.usage = await estimateUserPromptUsage(baseUserMessage)

      const { message, blocks } = getUserMessage(baseUserMessage)
      message.traceId = parent?.spanContext().traceId

      dispatch(_sendMessage(message, blocks, assistant, topic.id))

      setText('')
      setFiles([])
      setTimeoutTimer('sendMessage_1', () => setText(''), 500)
      setTimeoutTimer('sendMessage_2', () => resizeTextArea(), 0)
      // Restore focus to textarea after sending to maintain IME state (fcitx5 issue)
      focusTextarea()
    } catch (error) {
      logger.warn('Failed to send message:', error as Error)
      parent?.recordException(error as Error)
    }
  }, [
    assistant,
    topic,
    text,
    mentionedModels,
    files,
    dispatch,
    setText,
    setFiles,
    setTimeoutTimer,
    resizeTextArea,
    focusTextarea,
    rpaAvailable,
    knowledgeBases,
    providers,
    selectedKnowledgeBases,
    t
  ])

  const tokenCountProps = useMemo(() => {
    if (!config.showTokenCount || estimateTokenCount === undefined || !showInputEstimatedTokens) {
      return undefined
    }

    return {
      estimateTokenCount,
      inputTokenCount: estimateTokenCount,
      contextCount
    }
  }, [config.showTokenCount, contextCount, estimateTokenCount, showInputEstimatedTokens])

  const onPause = useCallback(async () => {
    if (topic.rpaRoleId) {
      const session = (await rpaDslSessionRepository.getAll()).find(
        (candidate) => candidate.topicCompatibilityId === topic.id && candidate.primaryRole?.id === topic.rpaRoleId
      )
      if (session) rpaPlanningRequestCoordinator.cancel(session.id)
    }
    await pauseMessages()
  }, [pauseMessages, topic.id, topic.rpaRoleId])

  const clearTopic = useCallback(async () => {
    if (loading) {
      await onPause()
      await delay(1)
    }

    EventEmitter.emit(EVENT_NAMES.CLEAR_MESSAGES, topic)
    focusTextarea()
  }, [focusTextarea, loading, onPause, topic])

  const onNewContext = useCallback(() => {
    if (loading) {
      onPause()
      return
    }
    EventEmitter.emit(EVENT_NAMES.NEW_CONTEXT)
  }, [loading, onPause])

  const activateNewTopic = useCallback(
    async (newTopic: Topic) => {
      await db.topics.add({ id: newTopic.id, messages: [] })

      if (assistant.defaultModel) {
        setModel(assistant.defaultModel)
      }

      addTopic(newTopic)
      setActiveTopic(newTopic)

      setTimeoutTimer('addNewTopic', () => EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR), 0)
    },
    [addTopic, assistant.defaultModel, setActiveTopic, setModel, setTimeoutTimer]
  )

  const getActiveRpaSession = useCallback(async () => {
    if (!topic.rpaRoleId) return undefined
    return (await rpaDslSessionRepository.getAll()).find(
      (session) => session.topicCompatibilityId === topic.id && session.primaryRole?.id === topic.rpaRoleId
    )
  }, [topic.id, topic.rpaRoleId])

  const createRoleTopic = useCallback(async () => {
    if (!topic.rpaRoleId) return getDefaultTopic(assistant.id)
    const [role, prompts] = await Promise.all([
      rpaAppRoleRepository.getById(topic.rpaRoleId),
      rpaRolePromptRepository.getByRoleId(topic.rpaRoleId)
    ])
    if (!role) throw new Error(`Selected RPA Role was not found: ${topic.rpaRoleId}`)
    return bindTopicToRpaRole(getDefaultTopic(assistant.id), role, prompts)
  }, [assistant.id, topic.rpaRoleId])

  const confirmTaskTransition = useCallback(
    async (sessionId: string) => confirmUnsavedRpaTaskTransition(sessionId, t),
    [t]
  )

  const addNewTopic = useCallback(async () => {
    const session = await getActiveRpaSession()
    if (session && !(await confirmTaskTransition(session.id))) return
    await activateNewTopic(await createRoleTopic())
  }, [activateNewTopic, confirmTaskTransition, createRoleTopic, getActiveRpaSession])

  const duplicateRpaTask = useCallback(async () => {
    const session = await getActiveRpaSession()
    if (!session) {
      Modal.warning({
        title: t('device.rpa.lifecycle.duplicate_task', { defaultValue: 'Duplicate task' }),
        content: t('device.rpa.lifecycle.no_task_to_duplicate', {
          defaultValue: 'Generate a task before duplicating it.'
        })
      })
      return
    }
    if (!(await confirmTaskTransition(session.id))) return
    const newTopic = await createRoleTopic()
    const duplicated = await rpaTaskLifecycleService.duplicate(session, newTopic.id)
    await activateNewTopic(newTopic)
    const revision = duplicated.revisions.find((candidate) => candidate.version === duplicated.activeRevisionVersion)
    if (!revision) return
    const assistantMessage = getAssistantMessage({ assistant, topic: newTopic })
    assistantMessage.status = AssistantMessageStatus.SUCCESS
    const block = createMainTextBlock(
      assistantMessage.id,
      t('device.rpa.lifecycle.task_duplicated', {
        defaultValue: 'The RPA task was duplicated as an independent draft.'
      }),
      {
        status: MessageBlockStatus.SUCCESS,
        metadata: {
          rpaTask: revision.dsl,
          rpaSessionId: duplicated.id,
          rpaRevisionVersion: revision.version,
          rpaOutcome: 'create_new_task'
        }
      }
    )
    assistantMessage.blocks = [block.id]
    await saveMessageAndBlocksToDB(newTopic.id, assistantMessage, [block])
    dispatch(newMessagesActions.addMessage({ topicId: newTopic.id, message: assistantMessage }))
    dispatch(upsertManyBlocks([block]))
  }, [activateNewTopic, assistant, confirmTaskTransition, createRoleTopic, dispatch, getActiveRpaSession, t])

  const endRpaTask = useCallback(async () => {
    const session = await getActiveRpaSession()
    if (!session) return
    if (!(await confirmTaskTransition(session.id))) return
    try {
      await rpaTaskLifecycleService.end(session)
      Modal.success({
        title: t('device.rpa.lifecycle.task_ended', { defaultValue: 'Task ended' }),
        content: t('device.rpa.lifecycle.task_ended_detail', {
          defaultValue: 'This task is now read-only. Create or duplicate a task to continue.'
        })
      })
    } catch (error) {
      Modal.error({
        title: t('device.rpa.lifecycle.end_task_failed', { defaultValue: 'Unable to end task' }),
        content: error instanceof Error ? error.message : String(error)
      })
    }
  }, [confirmTaskTransition, getActiveRpaSession, t])

  useEffect(() => {
    const request = readRpaRoleSessionRequest(window.location.hash)
    if (!request || handledRpaRoleSessionRequests.has(request.requestId)) return

    handledRpaRoleSessionRequests.add(request.requestId)
    void Promise.all([
      rpaAppRoleRepository.getById(request.roleId),
      rpaRolePromptRepository.getByRoleId(request.roleId)
    ])
      .then(([role, prompts]) => {
        if (!role) throw new Error(`Selected RPA Role was not found: ${request.roleId}`)
        const roleTopic = bindTopicToRpaRole(getDefaultTopic(assistant.id), role, prompts)
        return activateNewTopic(roleTopic)
      })
      .then(() => {
        const nextHash = consumeRpaRoleSessionRequest(window.location.hash)
        window.history.replaceState(
          window.history.state,
          '',
          `${window.location.pathname}${window.location.search}${nextHash}`
        )
      })
      .catch((error) => {
        handledRpaRoleSessionRequests.delete(request.requestId)
        logger.error('Failed to create a new Role-bound RPA topic', {
          error,
          roleId: request.roleId,
          requestId: request.requestId
        })
      })
  }, [activateNewTopic, assistant.id])

  const handleRemoveModel = useCallback(
    (modelToRemove: Model) => {
      setMentionedModels(mentionedModels.filter((current) => current.id !== modelToRemove.id))
    },
    [mentionedModels, setMentionedModels]
  )

  const handleRemoveKnowledgeBase = useCallback(
    (knowledgeBase: KnowledgeBase) => {
      const nextKnowledgeBases = assistant.knowledge_bases?.filter((kb) => kb.id !== knowledgeBase.id)
      updateAssistant({ ...assistant, knowledge_bases: nextKnowledgeBases })
      setSelectedKnowledgeBases(nextKnowledgeBases ?? [])
    },
    [assistant, setSelectedKnowledgeBases, updateAssistant]
  )

  const handleToggleExpanded = useCallback(
    (nextState?: boolean) => {
      const target = typeof nextState === 'boolean' ? nextState : !textareaIsExpanded
      setExpanded(target)
      focusTextarea()
    },
    [focusTextarea, setExpanded, textareaIsExpanded]
  )

  useEffect(() => {
    actionsRef.current = {
      resizeTextArea,
      addNewTopic,
      duplicateRpaTask,
      endRpaTask,
      clearTopic,
      onNewContext,
      onTextChange: setText,
      toggleExpanded: handleToggleExpanded
    }
  }, [
    resizeTextArea,
    addNewTopic,
    duplicateRpaTask,
    endRpaTask,
    clearTopic,
    onNewContext,
    setText,
    handleToggleExpanded,
    actionsRef
  ])

  useShortcut(
    'new_topic',
    () => {
      addNewTopic()
      EventEmitter.emit(EVENT_NAMES.SHOW_TOPIC_SIDEBAR)
      focusTextarea()
    },
    { preventDefault: true, enableOnFormTags: true }
  )

  useShortcut('clear_topic', clearTopic, {
    preventDefault: true,
    enableOnFormTags: true
  })

  useEffect(() => {
    const _setEstimateTokenCount = debounce(setEstimateTokenCount, 100, { leading: false, trailing: true })
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.ESTIMATED_TOKEN_COUNT, ({ tokensCount, contextCount }) => {
        _setEstimateTokenCount(tokensCount)
        setContextCount({ current: contextCount.current, max: contextCount.max })
      }),
      ...[EventEmitter.on(EVENT_NAMES.ADD_NEW_TOPIC, addNewTopic)]
    ]

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [addNewTopic])

  useEffect(() => {
    const debouncedEstimate = debounce((value: string) => {
      if (showInputEstimatedTokens) {
        const count = estimateTxtTokens(value) || 0
        setEstimateTokenCount(count)
      }
    }, 500)

    debouncedEstimate(text)
    return () => debouncedEstimate.cancel()
  }, [showInputEstimatedTokens, text])

  useEffect(() => {
    if (!document.querySelector('.topview-fullscreen-container')) {
      focusTextarea()
    }
  }, [
    topic.id,
    assistant.mcpServers,
    assistant.knowledge_bases,
    assistant.enableWebSearch,
    assistant.webSearchProviderId,
    mentionedModels,
    focusTextarea
  ])

  // TODO: Just use assistant.knowledge_bases as selectedKnowledgeBases. context state is overdesigned.
  useEffect(() => {
    setSelectedKnowledgeBases(assistant.knowledge_bases ?? [])
  }, [assistant.knowledge_bases, setSelectedKnowledgeBases])

  useEffect(() => {
    // Disable web search if model doesn't support it
    if (!isWebSearchModel(model) && assistant.enableWebSearch) {
      updateAssistant({ ...assistant, enableWebSearch: false })
    }

    // Clear web search provider if disabled or model has mandatory search
    if (
      assistant.webSearchProviderId &&
      (!WebSearchService.isWebSearchEnabled(assistant.webSearchProviderId) || isMandatoryWebSearchModel(model))
    ) {
      updateAssistant({ ...assistant, webSearchProviderId: undefined })
    }

    // Auto-enable/disable image generation based on model capabilities
    if (isGenerateImageModel(model)) {
      if (isAutoEnableImageGenerationModel(model) && !assistant.enableGenerateImage) {
        updateAssistant({ ...assistant, enableGenerateImage: true })
      }
    } else if (assistant.enableGenerateImage) {
      updateAssistant({ ...assistant, enableGenerateImage: false })
    }
  }, [assistant, model, updateAssistant])

  if (isMultiSelectMode) {
    return null
  }

  // topContent: 所有顶部预览内容
  const topContent = (
    <>
      {selectedKnowledgeBases.length > 0 && (
        <KnowledgeBaseInput
          selectedKnowledgeBases={selectedKnowledgeBases}
          onRemoveKnowledgeBase={handleRemoveKnowledgeBase}
        />
      )}

      {mentionedModels.length > 0 && (
        <MentionModelsInput selectedModels={mentionedModels} onRemoveModel={handleRemoveModel} />
      )}
    </>
  )

  // leftToolbar: 左侧工具栏
  const leftToolbar = config.showTools ? (
    <InputbarTools
      scope={scope}
      assistantId={assistant.id}
      rpaTask={topic.rpaRoleId ? { topicId: topic.id, roleId: topic.rpaRoleId } : undefined}
    />
  ) : null

  // rightToolbar: 右侧工具栏
  const rightToolbar = (
    <>
      {tokenCountProps && (
        <TokenCount
          estimateTokenCount={tokenCountProps.estimateTokenCount}
          inputTokenCount={tokenCountProps.inputTokenCount}
          contextCount={tokenCountProps.contextCount}
          onClick={onNewContext}
        />
      )}
    </>
  )

  return (
    <InputbarCore
      scope={scope}
      placeholder={placeholderText}
      text={text}
      onTextChange={setText}
      textareaRef={textareaRef}
      height={customHeight}
      onHeightChange={setCustomHeight}
      resizeTextArea={resizeTextArea}
      focusTextarea={focusTextarea}
      isLoading={loading}
      supportedExts={supportedExts}
      onPause={onPause}
      handleSendMessage={sendMessage}
      leftToolbar={leftToolbar}
      rightToolbar={rightToolbar}
      topContent={topContent}
    />
  )
}

export default Inputbar

function promptTopicOverrideSwitchDecision(
  t: (key: string, options?: Record<string, unknown>) => string
): Promise<RpaTopicOverrideSwitchDecision | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (decision?: RpaTopicOverrideSwitchDecision) => {
      if (settled) return
      settled = true
      modal.destroy()
      resolve(decision)
    }
    const modal = Modal.confirm({
      title: t('device.rpa.topic_override_assistant_changed'),
      content: t('device.rpa.topic_override_assistant_changed_detail'),
      closable: true,
      maskClosable: false,
      onCancel: () => finish(),
      footer: () => (
        <Space wrap>
          <Button onClick={() => finish('clear')}>{t('device.rpa.clear_topic_overrides')}</Button>
          <Button onClick={() => finish('remap')}>{t('device.rpa.remap_topic_overrides')}</Button>
          <Button type="primary" onClick={() => finish('preserve')}>
            {t('device.rpa.preserve_topic_overrides')}
          </Button>
        </Space>
      )
    })
  })
}

function confirmUnsavedRpaTaskTransition(
  sessionId: string,
  t: (key: string, options?: Record<string, unknown>) => string
): Promise<boolean> {
  if (!rpaSessionDraftRegistry.hasUnsavedChanges(sessionId)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      modal.destroy()
      resolve(result)
    }
    const modal = Modal.confirm({
      title: t('device.rpa.lifecycle.unsaved_title', { defaultValue: 'Unsaved RPA task changes' }),
      content: t('device.rpa.lifecycle.unsaved_detail', {
        defaultValue: 'Save or discard the current DSL changes before continuing.'
      }),
      closable: true,
      maskClosable: false,
      onCancel: () => finish(false),
      footer: () => (
        <Space wrap>
          <Button onClick={() => finish(false)}>{t('common.cancel')}</Button>
          <Button
            danger
            onClick={() => {
              rpaSessionDraftRegistry.discard(sessionId)
              finish(true)
            }}>
            {t('device.rpa.lifecycle.discard_changes', { defaultValue: 'Discard changes' })}
          </Button>
          <Button
            type="primary"
            onClick={() => {
              void rpaSessionDraftRegistry.save(sessionId).then((saved) => {
                if (saved) finish(true)
              })
            }}>
            {t('device.rpa.lifecycle.save_and_continue', { defaultValue: 'Save and continue' })}
          </Button>
        </Space>
      )
    })
  })
}
