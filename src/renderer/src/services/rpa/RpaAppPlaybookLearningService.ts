import type {
  RpaAppPlaybook,
  RpaAppPlaybookDefinition,
  RpaAppPlaybookEdge,
  RpaAppPlaybookRepository
} from './RpaAppPlaybookRepository'
import { rpaAppPlaybookRepository } from './RpaAppPlaybookRepository'
import type { RpaBatchRunRecord } from './RpaRunStorage'
import type { RpaAppStateRule, RpaRunStepEvent, RpaStep } from './RpaTypes'

export interface RpaAppPlaybookLearningResult {
  status: 'created' | 'versioned' | 'already_applied' | 'skipped_no_evidence' | 'skipped_version_conflict'
  playbookId?: string
  sourceVersion?: number
  appliedVersion?: number
  learnedStateCount: number
  learnedEdgeCount: number
}

export class RpaAppPlaybookLearningService {
  constructor(private readonly repository: RpaAppPlaybookRepository = rpaAppPlaybookRepository) {}

  async learn(run: RpaBatchRunRecord): Promise<RpaAppPlaybookLearningResult> {
    if (!run.deviceRuns.length || run.deviceRuns.some((deviceRun) => deviceRun.status !== 'completed')) {
      return { status: 'skipped_no_evidence', learnedStateCount: 0, learnedEdgeCount: 0 }
    }
    const packageName = readPackageName(run)
    if (!packageName) return { status: 'skipped_no_evidence', learnedStateCount: 0, learnedEdgeCount: 0 }
    const appVersion = readProfile(run)?.appVersion
    const locale = typeof run.task.metadata.locale === 'string' ? run.task.metadata.locale : '*'
    const existing = await this.repository.resolve(packageName, appVersion, locale)
    if (existing?.provenance.sourceRunIds.includes(run.id)) {
      return {
        status: 'already_applied',
        playbookId: existing.id,
        sourceVersion: existing.version,
        appliedVersion: existing.version,
        learnedStateCount: 0,
        learnedEdgeCount: 0
      }
    }

    const events = run.deviceRuns.flatMap((deviceRun) => deviceRun.events)
    const learnedStates = learnStates(run, events)
    const learnedEdges = learnEdges(events, packageName, learnedStates)
    if (!learnedStates.length && !learnedEdges.length) {
      return { status: 'skipped_no_evidence', learnedStateCount: 0, learnedEdgeCount: 0 }
    }
    const definition = mergeDefinition(existing, packageName, appVersion, locale, learnedStates, learnedEdges, run)
    try {
      const saved = await this.repository.save({
        definition,
        expectedVersion: existing?.version,
        sourceRunId: run.id
      })
      return {
        status: existing ? 'versioned' : 'created',
        playbookId: saved.id,
        sourceVersion: existing?.version,
        appliedVersion: saved.version,
        learnedStateCount: learnedStates.length,
        learnedEdgeCount: learnedEdges.length
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('version conflict')) {
        return {
          status: 'skipped_version_conflict',
          playbookId: existing?.id,
          sourceVersion: existing?.version,
          learnedStateCount: learnedStates.length,
          learnedEdgeCount: learnedEdges.length
        }
      }
      throw error
    }
  }
}

function learnStates(run: RpaBatchRunRecord, events: RpaRunStepEvent[]) {
  const states = new Map<string, RpaAppPlaybookDefinition['states'][number]>()
  for (const rule of readProfile(run)?.states ?? []) {
    states.set(rule.stateId, stateFromRule(rule))
  }
  for (const event of events) {
    for (const recognized of findRecognizedStates(event.data)) {
      if (recognized.stateId === 'UNKNOWN') continue
      const existing = states.get(recognized.stateId)
      const activityIncludes = recognized.evidence
        .filter((item) => item.matched && item.source === 'foreground_activity')
        .map((item) => item.value)
      const requiredTexts = recognized.evidence
        .filter((item) => item.matched && (item.source === 'ui_tree' || item.source === 'ocr'))
        .map((item) => item.value)
      if (!existing && !activityIncludes.length && !requiredTexts.length) continue
      states.set(recognized.stateId, {
        ...(existing ?? emptyState(recognized.stateId)),
        activityIncludes: uniqueStrings([...(existing?.activityIncludes ?? []), ...activityIncludes]),
        requiredTexts: uniqueStrings([...(existing?.requiredTexts ?? []), ...requiredTexts]),
        blockingCondition:
          existing && existing.blockingCondition !== 'none' ? existing.blockingCondition : recognized.blockingCondition,
        recoveryScope: existing?.recoveryScope === 'human' ? 'human' : recognized.recoveryScope,
        successCount: (existing?.successCount ?? 0) + 1,
        lastVerifiedAt: event.timestamp
      })
    }
  }
  return [...states.values()]
}

function learnEdges(
  events: RpaRunStepEvent[],
  packageName: string,
  states: RpaAppPlaybookDefinition['states']
): RpaAppPlaybookEdge[] {
  const protectedStateIds = new Set(
    states
      .filter((state) => state.recoveryScope === 'human' || state.blockingCondition !== 'none')
      .map((state) => state.stateId)
  )
  return events
    .filter((event) => event.phase === 'app_normalization_terminal')
    .flatMap((event) => findNormalizationGroups(event.data).map((group) => ({ event, group })))
    .flatMap(({ event, group }, index) => {
      if (
        !group.success ||
        group.verificationStatus !== 'passed' ||
        !group.beforeStateId ||
        !group.afterStateId ||
        group.beforeStateId === group.afterStateId ||
        protectedStateIds.has(group.beforeStateId) ||
        protectedStateIds.has(group.afterStateId)
      ) {
        return []
      }
      const steps = actionsToSteps(group.actions, packageName, event.stepId)
      if (!steps.length) return []
      return [
        {
          id: `learned-${event.stepId}-${index + 1}`,
          fromStateIds: [group.beforeStateId],
          toStateId: group.afterStateId,
          steps,
          priority: 20,
          status: 'active' as const,
          successCount: 1,
          failureCount: 0,
          confidence: Math.max(0.7, group.confidence),
          evidenceArtifactIds: uniqueStrings(findStringProperties(group.raw, 'artifactId')),
          lastVerifiedAt: event.timestamp
        }
      ]
    })
}

function mergeDefinition(
  existing: RpaAppPlaybook | undefined,
  packageName: string,
  appVersion: string | undefined,
  locale: string,
  states: RpaAppPlaybookDefinition['states'],
  edges: RpaAppPlaybookEdge[],
  run: RpaBatchRunRecord
): RpaAppPlaybookDefinition {
  const stateIds = new Set(states.map((state) => state.stateId))
  const homeStateId =
    existing?.launchBehavior.homeStateId ??
    states.find((state) => /^(home|app_home|main)$/i.test(state.stateId))?.stateId
  return {
    schemaVersion: 1,
    id: existing?.id ?? packageName,
    packageName,
    appVersionRange: existing?.appVersionRange ?? (appVersion ? `=${appVersion}` : '*'),
    locale: existing?.locale ?? locale,
    compatibilityScope: existing?.compatibilityScope ?? (appVersion ? 'exact' : 'package'),
    launchBehavior: existing?.launchBehavior ?? {
      homeStateId,
      softRelaunchPreservesState: true,
      hardRestartExpectedStateId: homeStateId
    },
    states: [...(existing?.states.filter((state) => !stateIds.has(state.stateId)) ?? []), ...states],
    edges: [...(existing?.edges ?? []), ...edges],
    disabledHandlerIds: existing?.disabledHandlerIds ?? [],
    provenance: {
      sourceRunIds: uniqueStrings([...(existing?.provenance.sourceRunIds ?? []), run.id]),
      sourceDeviceRunIds: uniqueStrings([
        ...(existing?.provenance.sourceDeviceRunIds ?? []),
        ...run.deviceRuns.map((deviceRun) => deviceRun.id)
      ]),
      evidenceArtifactIds: uniqueStrings(existing?.provenance.evidenceArtifactIds ?? [])
    }
  }
}

function readPackageName(run: RpaBatchRunRecord): string | undefined {
  return readProfile(run)?.appPackage ?? run.contextSnapshot?.appPackages[0]
}

function readProfile(
  run: RpaBatchRunRecord
): { appPackage?: string; appVersion?: string; states: RpaAppStateRule[] } | undefined {
  const value = run.task.metadata.appStateProfile
  if (!value || typeof value !== 'object' || !Array.isArray((value as { states?: unknown }).states)) return undefined
  return value as { appPackage?: string; appVersion?: string; states: RpaAppStateRule[] }
}

function stateFromRule(rule: RpaAppStateRule): RpaAppPlaybookDefinition['states'][number] {
  return {
    ...emptyState(rule.stateId),
    label: rule.label,
    priority: rule.priority ?? 0,
    activityIncludes: rule.activityIncludes ?? [],
    requiredTexts: rule.requiredTexts ?? [],
    anyTexts: rule.anyTexts ?? [],
    excludedTexts: rule.excludedTexts ?? [],
    blockingCondition: rule.blockingCondition ?? 'none',
    recoveryScope: rule.recoveryScope ?? 'none'
  }
}

function emptyState(stateId: string): RpaAppPlaybookDefinition['states'][number] {
  return {
    stateId,
    priority: 0,
    activityIncludes: [],
    requiredTexts: [],
    anyTexts: [],
    excludedTexts: [],
    screenshotSignatures: [],
    evidenceArtifactIds: [],
    blockingCondition: 'none',
    recoveryScope: 'none',
    successCount: 0,
    failureCount: 0
  }
}

function findRecognizedStates(value: unknown): Array<{
  stateId: string
  blockingCondition: RpaAppPlaybookDefinition['states'][number]['blockingCondition']
  recoveryScope: RpaAppPlaybookDefinition['states'][number]['recoveryScope']
  evidence: Array<{ source: string; value: string; matched: boolean }>
}> {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(findRecognizedStates)
  const record = value as Record<string, unknown>
  const current =
    typeof record.stateId === 'string' && Array.isArray(record.evidence)
      ? [
          {
            stateId: record.stateId,
            blockingCondition: readBlockingCondition(record.blockingCondition),
            recoveryScope: readRecoveryScope(record.recoveryScope),
            evidence: record.evidence.flatMap((item) =>
              isRecord(item) && typeof item.source === 'string' && typeof item.value === 'string'
                ? [{ source: item.source, value: item.value, matched: item.matched === true }]
                : []
            )
          }
        ]
      : []
  return [...current, ...Object.values(record).flatMap(findRecognizedStates)]
}

function findNormalizationGroups(value: unknown): Array<{
  beforeStateId?: string
  afterStateId?: string
  success: boolean
  verificationStatus?: string
  confidence: number
  actions: Array<{ type: string; detail: string }>
  raw: unknown
}> {
  if (!isRecord(value) || !Array.isArray(value.actionGroups)) return []
  return value.actionGroups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.actions)) return []
    const verification = isRecord(group.verification) ? group.verification : undefined
    return [
      {
        beforeStateId: typeof group.beforeStateId === 'string' ? group.beforeStateId : undefined,
        afterStateId: typeof group.afterStateId === 'string' ? group.afterStateId : undefined,
        success: group.success === true,
        verificationStatus: typeof verification?.status === 'string' ? verification.status : undefined,
        confidence: typeof verification?.confidence === 'number' ? verification.confidence : 0.7,
        actions: group.actions.flatMap((action) =>
          isRecord(action) && typeof action.type === 'string' && typeof action.detail === 'string'
            ? [{ type: action.type, detail: action.detail }]
            : []
        ),
        raw: group
      }
    ]
  })
}

function actionsToSteps(
  actions: Array<{ type: string; detail: string }>,
  packageName: string,
  prefix: string
): RpaStep[] {
  return actions.flatMap((action, index) => {
    const base = { id: `${prefix}-learned-${index + 1}`, name: `Learned ${action.type}`, continueOnFailure: false }
    if (action.type === 'key' && action.detail === 'back') return [{ ...base, moduleId: 'press_back', params: {} }]
    if (action.type === 'key' && action.detail === 'home') return [{ ...base, moduleId: 'press_home', params: {} }]
    if (action.type === 'start_app') return [{ ...base, moduleId: 'launch_app', params: { packageName } }]
    if (action.type === 'permission_action') {
      const permissionAction = action.detail === 'deny' || action.detail === 'allow' ? action.detail : 'allow_once'
      return [{ ...base, moduleId: 'handle_popup', params: { action: permissionAction, required: true } }]
    }
    return []
  })
}

function readBlockingCondition(value: unknown): RpaAppPlaybookDefinition['states'][number]['blockingCondition'] {
  return [
    'none',
    'permission_dialog',
    'popup',
    'update_prompt',
    'promotional_overlay',
    'network_error',
    'loading_failure',
    'authentication',
    'captcha',
    'payment',
    'account_security',
    'unsupported_app_version',
    'unknown'
  ].includes(String(value))
    ? (value as RpaAppPlaybookDefinition['states'][number]['blockingCondition'])
    : 'unknown'
}

function readRecoveryScope(value: unknown): RpaAppPlaybookDefinition['states'][number]['recoveryScope'] {
  return ['none', 'dismiss_overlay', 'navigate', 'restart_app', 'human'].includes(String(value))
    ? (value as RpaAppPlaybookDefinition['states'][number]['recoveryScope'])
    : 'none'
}

function findStringProperties(value: unknown, key: string): string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item) => findStringProperties(item, key))
  const record = value as Record<string, unknown>
  return [
    ...(typeof record[key] === 'string' ? [record[key] as string] : []),
    ...Object.values(record).flatMap((item) => findStringProperties(item, key))
  ]
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
