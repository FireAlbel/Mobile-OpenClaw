import { adaptAssistantProfileToRpaAppRole, type RpaAppRole, type RpaAppRoleAssetBinding } from './RpaAppRole'
import type { RpaAssistantProfile } from './RpaAssistantProfile'
import type { RpaDslSession } from './RpaDslSession'
import type { RpaBatchRunRecord } from './RpaRunStorage'

export type RpaMigrationPhase =
  | 'not_started'
  | 'backup'
  | 'roles'
  | 'sessions'
  | 'dual_read'
  | 'complete'
  | 'rolled_back'
export interface RpaLegacyAssistantRecord {
  id: string
  name: string
  appPackages?: string[]
  profile: RpaAssistantProfile
}
export interface RpaLegacyTopicRecord {
  id: string
  goal: string
  assistantId?: string
  dsl?: unknown
  rpaRelevant: boolean
  createdAt: number
  updatedAt: number
}
export interface RpaMigrationBackup {
  id: string
  createdAt: number
  payload: unknown
}
export interface RpaDualReadDifference {
  roleId: string
  category: 'assets' | 'models' | 'prompts' | 'provenance'
  legacy: unknown
  role: unknown
}
export interface RpaMigrationCheckpoint {
  schemaVersion: 1
  phase: RpaMigrationPhase
  backupId?: string
  processedAssistantIds: string[]
  processedTopicIds: string[]
  roleLinks: Record<string, string>
  sessionLinks: Record<string, string>
  updatedAt: number
}
export interface RpaMigrationReport {
  checkpoint: RpaMigrationCheckpoint
  createdRoleIds: string[]
  createdSessionIds: string[]
  unassignedAssets: string[]
  multiplyAssignedAssets: string[]
  dualReadDifferences: RpaDualReadDifference[]
  warnings: string[]
  realDeviceAcceptance: { singleApp: boolean; crossApp: boolean; approvedAt?: number; evidenceIds: string[] }
}
export interface RpaMigrationRuntimeSnapshot {
  sessions: RpaDslSession[]
  runs: RpaBatchRunRecord[]
  capturedAt: number
}
export interface RpaRoleMigrationAdapter {
  loadCheckpoint(): Promise<RpaMigrationCheckpoint | undefined>
  saveCheckpoint(checkpoint: RpaMigrationCheckpoint): Promise<void>
  createBackup(): Promise<RpaMigrationBackup>
  restoreBackup(backupId: string): Promise<void>
  getRole(id: string): Promise<RpaAppRole | undefined>
  saveRole(role: RpaAppRole): Promise<RpaAppRole>
  getSessionByTopicId(topicId: string): Promise<RpaDslSession | undefined>
  saveSession(session: RpaDslSession): Promise<RpaDslSession>
  captureRpaRuntimeData(): Promise<RpaMigrationRuntimeSnapshot>
  restoreRpaRuntimeData(snapshot: RpaMigrationRuntimeSnapshot): Promise<void>
}

export class RpaRoleMigrationService {
  constructor(
    private readonly adapter: RpaRoleMigrationAdapter,
    private readonly now: () => number = Date.now
  ) {}

  async migrate(input: {
    assistants: RpaLegacyAssistantRecord[]
    topics: RpaLegacyTopicRecord[]
    knownAssetIds?: string[]
  }): Promise<RpaMigrationReport> {
    let checkpoint = (await this.adapter.loadCheckpoint()) ?? emptyCheckpoint(this.now())
    const createdRoleIds: string[] = []
    const createdSessionIds: string[] = []
    const warnings: string[] = []
    if (!checkpoint.backupId) {
      const backup = await this.adapter.createBackup()
      checkpoint = await this.advance(checkpoint, 'backup', { backupId: backup.id })
    }
    for (const assistant of input.assistants) {
      const roleId = `assistant-role-${assistant.id}`
      if (!checkpoint.processedAssistantIds.includes(assistant.id)) {
        const existing = await this.adapter.getRole(roleId)
        if (!existing) {
          await this.adapter.saveRole(
            adaptAssistantProfileToRpaAppRole({
              profile: assistant.profile,
              assistantName: assistant.name,
              appPackages: assistant.appPackages,
              now: this.now()
            })
          )
          createdRoleIds.push(roleId)
        }
        checkpoint = await this.advance(checkpoint, 'roles', {
          processedAssistantIds: [...checkpoint.processedAssistantIds, assistant.id],
          roleLinks: { ...checkpoint.roleLinks, [assistant.id]: roleId }
        })
      }
    }
    for (const topic of input.topics.filter((candidate) => candidate.rpaRelevant)) {
      if (checkpoint.processedTopicIds.includes(topic.id)) continue
      const existing = await this.adapter.getSessionByTopicId(topic.id)
      const roleId = topic.assistantId ? checkpoint.roleLinks[topic.assistantId] : undefined
      if (!existing) {
        const role = roleId ? await this.adapter.getRole(roleId) : undefined
        const session = createMigratedSession(topic, role)
        await this.adapter.saveSession(session)
        createdSessionIds.push(session.id)
        if (!role) warnings.push(`Topic ${topic.id} has no assigned Role and remains non-executable`)
      }
      checkpoint = await this.advance(checkpoint, 'sessions', {
        processedTopicIds: [...checkpoint.processedTopicIds, topic.id],
        sessionLinks: { ...checkpoint.sessionLinks, [topic.id]: existing?.id ?? `migrated-topic-${topic.id}` }
      })
    }
    const dualReadDifferences = await this.compareDualRead(input.assistants, checkpoint)
    checkpoint = await this.advance(checkpoint, dualReadDifferences.length ? 'dual_read' : 'complete')
    const ownership = assetOwnership(input.assistants)
    const knownAssets = new Set(input.knownAssetIds ?? [])
    return {
      checkpoint,
      createdRoleIds,
      createdSessionIds,
      unassignedAssets: [...knownAssets].filter((id) => !ownership.has(id)),
      multiplyAssignedAssets: [...ownership.entries()].filter(([, owners]) => owners.size > 1).map(([id]) => id),
      dualReadDifferences,
      warnings,
      realDeviceAcceptance: { singleApp: false, crossApp: false, evidenceIds: [] }
    }
  }

  async rollback(): Promise<RpaMigrationCheckpoint> {
    const checkpoint = await this.adapter.loadCheckpoint()
    if (!checkpoint?.backupId) throw new Error('No migration backup is available')
    const runtimeSnapshot = await this.adapter.captureRpaRuntimeData()
    await this.adapter.restoreBackup(checkpoint.backupId)
    await this.adapter.restoreRpaRuntimeData(runtimeSnapshot)
    return this.advance(checkpoint, 'rolled_back')
  }

  private async compareDualRead(
    assistants: RpaLegacyAssistantRecord[],
    checkpoint: RpaMigrationCheckpoint
  ): Promise<RpaDualReadDifference[]> {
    const differences: RpaDualReadDifference[] = []
    for (const assistant of assistants) {
      const roleId = checkpoint.roleLinks[assistant.id]
      if (!roleId) continue
      const role = await this.adapter.getRole(roleId)
      if (!role) {
        differences.push({ roleId, category: 'provenance', legacy: assistant.id, role: undefined })
        continue
      }
      const expected = adaptAssistantProfileToRpaAppRole({
        profile: assistant.profile,
        assistantName: assistant.name,
        appPackages: assistant.appPackages,
        now: role.updatedAt
      })
      compare(
        differences,
        roleId,
        'assets',
        normalizeBindings(expected.assetBindings),
        normalizeBindings(role.assetBindings)
      )
      compare(differences, roleId, 'models', expected.modelDefaults ?? {}, role.modelDefaults ?? {})
      compare(differences, roleId, 'provenance', expected.compatibility, role.compatibility)
    }
    return differences
  }

  private async advance(
    checkpoint: RpaMigrationCheckpoint,
    phase: RpaMigrationPhase,
    patch: Partial<RpaMigrationCheckpoint> = {}
  ): Promise<RpaMigrationCheckpoint> {
    const next = { ...checkpoint, ...patch, phase, updatedAt: this.now() }
    await this.adapter.saveCheckpoint(next)
    return next
  }
}

export function canApproveRpaMigrationCutover(report: RpaMigrationReport): boolean {
  return (
    report.checkpoint.phase === 'complete' &&
    report.dualReadDifferences.length === 0 &&
    report.realDeviceAcceptance.singleApp &&
    report.realDeviceAcceptance.crossApp
  )
}
function createMigratedSession(topic: RpaLegacyTopicRecord, role?: RpaAppRole): RpaDslSession {
  const context = role
    ? {
        primaryRole: { id: role.id, version: role.version },
        supportingRoles: role.supportingRoleIds.map((id) => ({ id, version: 1 })),
        systemCapabilities: role.systemCapabilities,
        compatibility: role.compatibility
      }
    : undefined
  const revision =
    topic.dsl && context
      ? [
          {
            version: 1,
            dsl: JSON.parse(JSON.stringify(topic.dsl)),
            validationIssues: [],
            executable: false,
            humanReadableExplanation: 'Migrated DSL requires validation before execution',
            roleContext: context,
            createdAt: topic.updatedAt,
            source: 'generated' as const
          }
        ]
      : []
  return {
    schemaVersion: 1,
    id: `migrated-topic-${topic.id}`,
    version: 1,
    primaryRole: context?.primaryRole,
    supportingRoles: context?.supportingRoles ?? [],
    goal: topic.goal,
    attachments: [],
    observations: [],
    clarifications: [],
    revisions: revision,
    activeRevisionVersion: revision.length ? 1 : undefined,
    status: role ? 'draft' : 'non_executable',
    interactionState: role ? (revision.length ? 'draft' : 'empty') : 'non_executable',
    interactionEvents: [],
    topicCompatibilityId: topic.id,
    templateIds: [],
    runIds: [],
    replayRunIds: [],
    improvementIds: [],
    createdAt: topic.createdAt,
    updatedAt: topic.updatedAt
  }
}
function assetOwnership(assistants: RpaLegacyAssistantRecord[]): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const assistant of assistants) {
    const ids = [
      ...assistant.profile.knowledgeBindings.map((item) => item.knowledgeId),
      ...assistant.profile.skillBindings.map((item) => item.skillId),
      ...assistant.profile.templateBindings.map((item) => item.templateId)
    ]
    for (const id of ids) {
      const owners = result.get(id) ?? new Set<string>()
      owners.add(assistant.id)
      result.set(id, owners)
    }
  }
  return result
}
function normalizeBindings(bindings: RpaAppRoleAssetBinding[]): unknown {
  return bindings
    .map((item) => ({
      type: item.ref.assetType,
      id: item.ref.assetId,
      version: item.ref.version,
      enabled: item.enabled,
      priority: item.priority
    }))
    .sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`))
}
function compare(
  output: RpaDualReadDifference[],
  roleId: string,
  category: RpaDualReadDifference['category'],
  legacy: unknown,
  role: unknown
): void {
  if (JSON.stringify(legacy) !== JSON.stringify(role)) output.push({ roleId, category, legacy, role })
}
function emptyCheckpoint(now: number): RpaMigrationCheckpoint {
  return {
    schemaVersion: 1,
    phase: 'not_started',
    processedAssistantIds: [],
    processedTopicIds: [],
    roleLinks: {},
    sessionLinks: {},
    updatedAt: now
  }
}
