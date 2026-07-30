import { loggerService } from '@logger'

import type { RpaArtifactStore } from './RpaArtifactStore'
import { rpaArtifactStore } from './RpaArtifactStore'
import { createDefaultRpaModuleRegistry } from './RpaDefaultRegistry'
import {
  createDefaultRpaKnowledgeEntry,
  type RpaKnowledgeCategory,
  type RpaKnowledgeRepository,
  rpaKnowledgeRepository
} from './RpaKnowledge'
import type { RpaBatchRunRecord } from './RpaRunStorage'
import {
  getRpaSkillDefinition,
  type RpaSkillDefinition,
  type RpaSkillRepository,
  rpaSkillRepository
} from './RpaSkillRepository'
import { RpaTaskValidator } from './RpaTaskValidator'
import type { RpaTemplateRepository } from './RpaTemplateRepository'
import { rpaTemplateRepository } from './RpaTemplateRepository'

const logger = loggerService.withContext('RpaImprovementProposal')

export const RPA_IMPROVEMENT_PROPOSAL_STATUSES = [
  'draft',
  'awaiting_review',
  'approved',
  'rejected',
  'applying',
  'applied',
  'application_failed',
  'approved_pending_dependency'
] as const

export type RpaImprovementProposalStatus = (typeof RPA_IMPROVEMENT_PROPOSAL_STATUSES)[number]
export type RpaImprovementTargetType = 'template' | 'skill' | 'knowledge'

export interface RpaImprovementTarget {
  type: RpaImprovementTargetType
  id?: string
  baseVersion?: string
}

export interface RpaImprovementValidationResult {
  status: 'pending' | 'passed' | 'failed'
  issues: string[]
  validatedAt?: number
}

export interface RpaImprovementApplicationResult {
  status: 'not_started' | 'applied' | 'failed' | 'pending_dependency'
  targetId?: string
  targetVersion?: string
  error?: string
  appliedAt?: number
}

export interface RpaImprovementProposal {
  id: string
  version: number
  status: RpaImprovementProposalStatus
  sourceRunIds: string[]
  sourceDeviceRunIds: string[]
  sourceTemplate?: { id: string; version?: string }
  target: RpaImprovementTarget
  traceSummary: string
  failureClass: string
  confidence: number
  evidenceArtifactIds: string[]
  proposedChanges: Record<string, unknown>
  validation: RpaImprovementValidationResult
  application: RpaImprovementApplicationResult
  analysisSource: 'trace_learning' | 'manual_draft'
  reviewer?: string
  reviewNote?: string
  reviewedAt?: number
  createdAt: number
  updatedAt: number
}

export interface RpaImprovementProposalStorage {
  loadProposals(): Promise<RpaImprovementProposal[]>
  saveProposals(proposals: RpaImprovementProposal[]): Promise<void>
}

export interface CreateRpaImprovementProposalInput {
  sourceRunIds: string[]
  sourceDeviceRunIds?: string[]
  sourceTemplate?: RpaImprovementProposal['sourceTemplate']
  target: RpaImprovementTarget
  traceSummary: string
  failureClass: string
  confidence: number
  evidenceArtifactIds?: string[]
  proposedChanges: Record<string, unknown>
  analysisSource?: RpaImprovementProposal['analysisSource']
  status?: 'draft' | 'awaiting_review'
}

export class LocalStorageRpaImprovementProposalStorage implements RpaImprovementProposalStorage {
  private readonly storageKey = 'rpa_improvement_proposals'

  async loadProposals(): Promise<RpaImprovementProposal[]> {
    if (typeof localStorage === 'undefined') return []
    try {
      const stored = localStorage.getItem(this.storageKey)
      return stored ? sanitizeRpaImprovementProposals(JSON.parse(stored)) : []
    } catch (error) {
      logger.warn('Failed to load local RPA improvement proposals', { error })
      return []
    }
  }

  async saveProposals(proposals: RpaImprovementProposal[]): Promise<void> {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(this.storageKey, JSON.stringify(sanitizeRpaImprovementProposals(proposals)))
  }
}

export class IpcRpaImprovementProposalStorage implements RpaImprovementProposalStorage {
  constructor(
    private readonly fallback: RpaImprovementProposalStorage = new LocalStorageRpaImprovementProposalStorage()
  ) {}

  async loadProposals(): Promise<RpaImprovementProposal[]> {
    if (!window.api?.rpa?.loadImprovementProposals) return this.fallback.loadProposals()
    try {
      return sanitizeRpaImprovementProposals(await window.api.rpa.loadImprovementProposals())
    } catch (error) {
      logger.warn('Failed to load RPA improvement proposals through IPC', { error })
      return this.fallback.loadProposals()
    }
  }

  async saveProposals(proposals: RpaImprovementProposal[]): Promise<void> {
    const sanitized = sanitizeRpaImprovementProposals(proposals)
    if (!window.api?.rpa?.saveImprovementProposals) return this.fallback.saveProposals(sanitized)
    try {
      await window.api.rpa.saveImprovementProposals(sanitized)
    } catch (error) {
      logger.warn('Failed to save RPA improvement proposals through IPC', { error })
      await this.fallback.saveProposals(sanitized)
    }
  }
}

export class RpaImprovementProposalRepository {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: RpaImprovementProposalStorage = new IpcRpaImprovementProposalStorage(),
    private readonly now: () => number = Date.now
  ) {}

  async getAll(): Promise<RpaImprovementProposal[]> {
    await this.writeQueue
    return sanitizeRpaImprovementProposals(await this.storage.loadProposals())
  }

  async getById(id: string): Promise<RpaImprovementProposal | undefined> {
    return (await this.getAll()).find((proposal) => proposal.id === requireId(id, 'id'))
  }

  async findByRunId(runId: string): Promise<RpaImprovementProposal[]> {
    const normalized = requireId(runId, 'runId')
    return (await this.getAll()).filter((proposal) => proposal.sourceRunIds.includes(normalized))
  }

  async create(input: CreateRpaImprovementProposalInput): Promise<RpaImprovementProposal> {
    const timestamp = this.now()
    const proposal = sanitizeRpaImprovementProposal({
      ...input,
      id: `rpa-proposal-${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
      version: 1,
      status: input.status ?? 'draft',
      sourceDeviceRunIds: input.sourceDeviceRunIds ?? [],
      evidenceArtifactIds: input.evidenceArtifactIds ?? [],
      validation: { status: 'pending', issues: [] },
      application: { status: 'not_started' },
      analysisSource: input.analysisSource ?? 'manual_draft',
      createdAt: timestamp,
      updatedAt: timestamp
    })
    if (!proposal) throw new Error('Invalid RPA improvement proposal')
    return this.enqueue(async () => {
      const proposals = await this.storage.loadProposals()
      await this.storage.saveProposals([proposal, ...proposals])
      return proposal
    })
  }

  async saveDraft(
    id: string,
    changes: Pick<
      RpaImprovementProposal,
      'target' | 'traceSummary' | 'failureClass' | 'confidence' | 'evidenceArtifactIds' | 'proposedChanges'
    >
  ): Promise<RpaImprovementProposal> {
    return this.update(id, (proposal) => {
      if (!['draft', 'awaiting_review', 'application_failed'].includes(proposal.status)) {
        throw new Error(`Proposal cannot be edited in status ${proposal.status}`)
      }
      return {
        ...proposal,
        ...changes,
        status: 'awaiting_review',
        validation: { status: 'pending', issues: [] },
        application: proposal.status === 'application_failed' ? { status: 'not_started' } : proposal.application
      }
    })
  }

  async approve(id: string, reviewer: string, reviewNote?: string): Promise<RpaImprovementProposal> {
    return this.update(id, (proposal) => {
      if (proposal.status !== 'awaiting_review' && proposal.status !== 'application_failed') {
        throw new Error(`Proposal cannot be approved in status ${proposal.status}`)
      }
      return {
        ...proposal,
        status: 'approved',
        reviewer: requireId(reviewer, 'reviewer'),
        reviewNote: normalizeText(reviewNote, 2_000) || undefined,
        reviewedAt: this.now()
      }
    })
  }

  async reject(id: string, reviewer: string, reviewNote?: string): Promise<RpaImprovementProposal> {
    return this.update(id, (proposal) => {
      if (!['draft', 'awaiting_review', 'application_failed'].includes(proposal.status)) {
        throw new Error(`Proposal cannot be rejected in status ${proposal.status}`)
      }
      return {
        ...proposal,
        status: 'rejected',
        reviewer: requireId(reviewer, 'reviewer'),
        reviewNote: normalizeText(reviewNote, 2_000) || undefined,
        reviewedAt: this.now()
      }
    })
  }

  async recordApplication(
    id: string,
    status: Extract<
      RpaImprovementProposalStatus,
      'applying' | 'applied' | 'application_failed' | 'approved_pending_dependency'
    >,
    validation: RpaImprovementValidationResult,
    application: RpaImprovementApplicationResult
  ): Promise<RpaImprovementProposal> {
    return this.update(id, (proposal) => ({ ...proposal, status, validation, application }))
  }

  private async update(
    id: string,
    updater: (proposal: RpaImprovementProposal) => RpaImprovementProposal
  ): Promise<RpaImprovementProposal> {
    const normalized = requireId(id, 'id')
    return this.enqueue(async () => {
      const proposals = sanitizeRpaImprovementProposals(await this.storage.loadProposals())
      const existing = proposals.find((proposal) => proposal.id === normalized)
      if (!existing) throw new Error(`RPA improvement proposal not found: ${normalized}`)
      const updated = sanitizeRpaImprovementProposal({
        ...updater(existing),
        id: existing.id,
        version: existing.version + 1,
        createdAt: existing.createdAt,
        updatedAt: this.now()
      })
      if (!updated) throw new Error('Invalid RPA improvement proposal update')
      await this.storage.saveProposals([updated, ...proposals.filter((proposal) => proposal.id !== normalized)])
      return updated
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export interface RpaSkillImprovementAdapter {
  isAvailable(): boolean
  validate(proposal: RpaImprovementProposal): Promise<string[]>
  apply(proposal: RpaImprovementProposal): Promise<{ id: string; version: string }>
}

export class RpaSkillRepositoryImprovementAdapter implements RpaSkillImprovementAdapter {
  constructor(private readonly repository: RpaSkillRepository = rpaSkillRepository) {}

  isAvailable(): boolean {
    return true
  }

  async validate(proposal: RpaImprovementProposal): Promise<string[]> {
    try {
      const definition = await this.buildDefinition(proposal)
      return this.repository.validate(definition).map((issue) => `${issue.path}: ${issue.message}`)
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)]
    }
  }

  async apply(proposal: RpaImprovementProposal): Promise<{ id: string; version: string }> {
    const definition = await this.buildDefinition(proposal)
    const skill = await this.repository.save({
      definition,
      saveMode: 'new_version',
      nextVersion: normalizeText(proposal.proposedChanges.nextVersion) || undefined
    })
    return { id: skill.id, version: skill.version }
  }

  private async buildDefinition(proposal: RpaImprovementProposal): Promise<RpaSkillDefinition> {
    const skillId = requireId(proposal.target.id, 'skillId')
    const existing = await this.repository.getById(skillId)
    if (!existing) throw new Error(`Target Skill does not exist: ${skillId}`)
    if (proposal.target.baseVersion && proposal.target.baseVersion !== existing.version) {
      throw new Error(`Skill version conflict: expected ${proposal.target.baseVersion}, found ${existing.version}`)
    }
    const changes = isRecord(proposal.proposedChanges.definition)
      ? proposal.proposedChanges.definition
      : proposal.proposedChanges
    return {
      ...getRpaSkillDefinition(existing),
      ...changes,
      id: existing.id,
      version: existing.version
    } as RpaSkillDefinition
  }
}

export class RpaImprovementProposalService {
  private readonly validator = new RpaTaskValidator(createDefaultRpaModuleRegistry(), { requireDeviceIds: false })

  constructor(
    private readonly proposals: RpaImprovementProposalRepository = rpaImprovementProposalRepository,
    private readonly templates: RpaTemplateRepository = rpaTemplateRepository,
    private readonly knowledge: RpaKnowledgeRepository = rpaKnowledgeRepository,
    private readonly artifacts: RpaArtifactStore = rpaArtifactStore,
    private readonly skills: RpaSkillImprovementAdapter = new RpaSkillRepositoryImprovementAdapter(),
    private readonly now: () => number = Date.now
  ) {}

  async createManualDraftFromRun(run: RpaBatchRunRecord): Promise<RpaImprovementProposal> {
    if (run.status === 'pending' || run.status === 'running') throw new Error('Active runs cannot create proposals')
    const existing = (await this.proposals.findByRunId(run.id)).find((proposal) => proposal.status !== 'rejected')
    if (existing) return existing
    const sourceTemplate = run.contextSnapshot?.sourceTemplate
    const template = sourceTemplate ? await this.templates.getById(sourceTemplate.id) : undefined
    const evidence = await this.artifacts.findByLink('run', run.id)
    const errors = run.deviceRuns.map((deviceRun) => deviceRun.error).filter((value): value is string => Boolean(value))
    const failedEvents = run.deviceRuns
      .flatMap((deviceRun) => deviceRun.events)
      .filter((event) => event.status === 'failed' || event.status === 'timeout' || event.status === 'needs_human')
    const traceSummary = [
      `${run.task.name}: ${run.status}`,
      errors[0] ?? failedEvents.at(-1)?.message ?? 'No terminal error recorded',
      'P6-5 trace analysis is not available; review and edit this deterministic draft before approval.'
    ].join('\n')
    const proposal = await this.proposals.create({
      sourceRunIds: [run.id],
      sourceDeviceRunIds: run.deviceRuns.map((deviceRun) => deviceRun.id),
      sourceTemplate,
      target: template
        ? { type: 'template', id: template.id, baseVersion: String(template.version) }
        : { type: 'knowledge' },
      traceSummary,
      failureClass: classifyRunFailure(run),
      confidence: 0.5,
      evidenceArtifactIds: evidence.map((artifact) => artifact.id),
      proposedChanges: template
        ? { name: template.name, goal: template.goal, dsl: template.dsl }
        : {
            title: `${run.task.name} improvement`,
            summary: `${run.task.goal} | ${run.status}`,
            content: errors.join('\n') || traceSummary,
            category: 'recovery_guidance'
          },
      analysisSource: 'manual_draft',
      status: 'awaiting_review'
    })
    await this.linkEvidence(proposal)
    return proposal
  }

  async saveDraft(
    id: string,
    changes: Parameters<RpaImprovementProposalRepository['saveDraft']>[1]
  ): Promise<RpaImprovementProposal> {
    const proposal = await this.proposals.saveDraft(id, changes)
    await this.linkEvidence(proposal)
    return proposal
  }

  async apply(id: string): Promise<RpaImprovementProposal> {
    const proposal = await this.proposals.getById(id)
    if (!proposal) throw new Error(`RPA improvement proposal not found: ${id}`)
    if (proposal.status !== 'approved' && proposal.status !== 'application_failed') {
      throw new Error('Proposal requires explicit approval before application')
    }

    const validation = await this.validate(proposal)
    if (validation.status === 'failed') {
      return this.proposals.recordApplication(proposal.id, 'application_failed', validation, {
        status: 'failed',
        error: validation.issues.join('; ')
      })
    }

    await this.proposals.recordApplication(proposal.id, 'applying', validation, { status: 'not_started' })
    try {
      if (proposal.target.type === 'skill' && !this.skills.isAvailable()) {
        return this.proposals.recordApplication(proposal.id, 'approved_pending_dependency', validation, {
          status: 'pending_dependency',
          targetId: proposal.target.id,
          error: 'RpaSkillRepository is not available until P6-3'
        })
      }

      const applied = await this.applyTarget(proposal)
      const completed = await this.proposals.recordApplication(proposal.id, 'applied', validation, {
        status: 'applied',
        targetId: applied.id,
        targetVersion: applied.version,
        appliedAt: this.now()
      })
      await this.linkAppliedEvidence(completed, applied.id)
      return completed
    } catch (error) {
      logger.error('Failed to apply RPA improvement proposal', { error, proposalId: proposal.id })
      return this.proposals.recordApplication(proposal.id, 'application_failed', validation, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async validate(proposal: RpaImprovementProposal): Promise<RpaImprovementValidationResult> {
    const issues: string[] = []
    if (proposal.target.type === 'template') {
      if (!proposal.target.id) issues.push('Template target ID is required')
      const template = proposal.target.id ? await this.templates.getById(proposal.target.id) : undefined
      if (!template) issues.push('Target template does not exist')
      if (template && proposal.target.baseVersion && String(template.version) !== proposal.target.baseVersion) {
        issues.push(`Template version conflict: expected ${proposal.target.baseVersion}, found ${template.version}`)
      }
      const validation = this.validator.validate(proposal.proposedChanges.dsl)
      if (!validation.success) issues.push(...validation.issues.map((issue) => `${issue.path}: ${issue.message}`))
    } else if (proposal.target.type === 'knowledge') {
      issues.push('Legacy free-form Knowledge proposals are retired; structured failure fingerprints own run learning')
    } else {
      if (!proposal.target.id) issues.push('Skill target ID is required')
      if (this.skills.isAvailable()) issues.push(...(await this.skills.validate(proposal)))
    }
    return { status: issues.length ? 'failed' : 'passed', issues, validatedAt: this.now() }
  }

  private async applyTarget(proposal: RpaImprovementProposal): Promise<{ id: string; version: string }> {
    if (proposal.target.type === 'template') {
      const template = await this.templates.save({
        id: proposal.target.id,
        name: normalizeText(proposal.proposedChanges.name) || undefined,
        goal: normalizeText(proposal.proposedChanges.goal) || undefined,
        dsl: proposal.proposedChanges.dsl,
        source: 'manual',
        sourceRef: proposal.id,
        saveMode: 'new_version'
      })
      return { id: template.id, version: String(template.version) }
    }
    if (proposal.target.type === 'skill') return this.skills.apply(proposal)

    const knowledgeBaseId = requireId(proposal.proposedChanges.knowledgeBaseId, 'knowledgeBaseId')
    const base = createDefaultRpaKnowledgeEntry(
      knowledgeBaseId,
      readKnowledgeCategory(proposal.proposedChanges.category)
    )
    const saved = await this.knowledge.save({
      ...base,
      title: requireText(proposal.proposedChanges.title, 'title'),
      summary: normalizeText(proposal.proposedChanges.summary, 2_000),
      content: requireText(proposal.proposedChanges.content, 'content'),
      reviewStatus: 'reviewed',
      confidence: proposal.confidence,
      links: {
        ...base.links,
        templateIds: proposal.sourceTemplate ? [proposal.sourceTemplate.id] : [],
        artifactIds: proposal.evidenceArtifactIds
      },
      source: { type: 'run_summary', runId: proposal.sourceRunIds[0], deviceRunIds: proposal.sourceDeviceRunIds },
      reviewedAt: proposal.reviewedAt ?? this.now()
    })
    return { id: saved.id, version: String(saved.version) }
  }

  private async linkEvidence(proposal: RpaImprovementProposal): Promise<void> {
    await Promise.all(
      proposal.evidenceArtifactIds.map((artifactId) =>
        this.artifacts.link(artifactId, {
          targetType: 'improvement_proposal',
          targetId: proposal.id,
          relation: 'review_evidence'
        })
      )
    )
  }

  private async linkAppliedEvidence(proposal: RpaImprovementProposal, targetId: string): Promise<void> {
    const targetType =
      proposal.target.type === 'template'
        ? 'rpa_template'
        : proposal.target.type === 'skill'
          ? 'rpa_skill'
          : 'knowledge'
    await Promise.all(
      proposal.evidenceArtifactIds.map((artifactId) =>
        this.artifacts.link(artifactId, { targetType, targetId, relation: 'approved_improvement_evidence' })
      )
    )
  }
}

export function sanitizeRpaImprovementProposals(value: unknown): RpaImprovementProposal[] {
  if (!Array.isArray(value)) return []
  return value
    .map(sanitizeRpaImprovementProposal)
    .filter((proposal): proposal is RpaImprovementProposal => Boolean(proposal))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

function sanitizeRpaImprovementProposal(value: unknown): RpaImprovementProposal | undefined {
  if (!isRecord(value)) return undefined
  const id = normalizeText(value.id)
  const target = sanitizeTarget(value.target)
  const sourceRunIds = normalizeStrings(value.sourceRunIds)
  if (!id || !target || !sourceRunIds.length || !isRecord(value.proposedChanges)) return undefined
  const status = RPA_IMPROVEMENT_PROPOSAL_STATUSES.includes(value.status as RpaImprovementProposalStatus)
    ? (value.status as RpaImprovementProposalStatus)
    : 'draft'
  const createdAt = normalizeTimestamp(value.createdAt)
  return {
    id,
    version: normalizePositiveInteger(value.version),
    status,
    sourceRunIds,
    sourceDeviceRunIds: normalizeStrings(value.sourceDeviceRunIds),
    sourceTemplate: sanitizeSourceTemplate(value.sourceTemplate),
    target,
    traceSummary: normalizeText(value.traceSummary, 8_000),
    failureClass: normalizeText(value.failureClass, 200) || 'unknown',
    confidence: clampNumber(value.confidence, 0, 1, 0.5),
    evidenceArtifactIds: normalizeStrings(value.evidenceArtifactIds),
    proposedChanges: structuredClone(value.proposedChanges),
    validation: sanitizeValidation(value.validation),
    application: sanitizeApplication(value.application),
    analysisSource: value.analysisSource === 'trace_learning' ? 'trace_learning' : 'manual_draft',
    reviewer: normalizeText(value.reviewer, 200) || undefined,
    reviewNote: normalizeText(value.reviewNote, 2_000) || undefined,
    reviewedAt: typeof value.reviewedAt === 'number' ? normalizeTimestamp(value.reviewedAt) : undefined,
    createdAt,
    updatedAt: Math.max(createdAt, normalizeTimestamp(value.updatedAt))
  }
}

function sanitizeTarget(value: unknown): RpaImprovementTarget | undefined {
  if (!isRecord(value) || !['template', 'skill', 'knowledge'].includes(String(value.type))) return undefined
  return {
    type: value.type as RpaImprovementTargetType,
    id: normalizeText(value.id) || undefined,
    baseVersion: normalizeText(value.baseVersion) || undefined
  }
}

function sanitizeSourceTemplate(value: unknown): RpaImprovementProposal['sourceTemplate'] {
  if (!isRecord(value)) return undefined
  const id = normalizeText(value.id)
  return id ? { id, version: normalizeText(value.version) || undefined } : undefined
}

function sanitizeValidation(value: unknown): RpaImprovementValidationResult {
  if (!isRecord(value)) return { status: 'pending', issues: [] }
  const status = ['pending', 'passed', 'failed'].includes(String(value.status))
    ? (value.status as RpaImprovementValidationResult['status'])
    : 'pending'
  return {
    status,
    issues: normalizeStrings(value.issues),
    validatedAt: typeof value.validatedAt === 'number' ? normalizeTimestamp(value.validatedAt) : undefined
  }
}

function sanitizeApplication(value: unknown): RpaImprovementApplicationResult {
  if (!isRecord(value)) return { status: 'not_started' }
  const status = ['not_started', 'applied', 'failed', 'pending_dependency'].includes(String(value.status))
    ? (value.status as RpaImprovementApplicationResult['status'])
    : 'not_started'
  return {
    status,
    targetId: normalizeText(value.targetId) || undefined,
    targetVersion: normalizeText(value.targetVersion) || undefined,
    error: normalizeText(value.error, 2_000) || undefined,
    appliedAt: typeof value.appliedAt === 'number' ? normalizeTimestamp(value.appliedAt) : undefined
  }
}

function classifyRunFailure(run: RpaBatchRunRecord): string {
  if (run.deviceRuns.some((deviceRun) => deviceRun.status === 'needs_human')) return 'human_intervention_required'
  if (run.deviceRuns.some((deviceRun) => deviceRun.events.some((event) => event.status === 'timeout'))) return 'timeout'
  if (run.status === 'failed') return 'execution_failed'
  if (run.status === 'cancelled') return 'cancelled'
  return 'optimization_opportunity'
}

function readKnowledgeCategory(value: unknown): RpaKnowledgeCategory {
  const categories: RpaKnowledgeCategory[] = [
    'app_sop',
    'page_state_explanation',
    'locator_guidance',
    'failure_case',
    'recovery_guidance',
    'version_note',
    'policy_note'
  ]
  return categories.includes(value as RpaKnowledgeCategory) ? (value as RpaKnowledgeCategory) : 'recovery_guidance'
}

function normalizeText(value: unknown, maxLength = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function requireText(value: unknown, field: string): string {
  const normalized = normalizeText(value, 12_000)
  if (!normalized) throw new Error(`${field} is required`)
  return normalized
}

function requireId(value: unknown, field: string): string {
  const normalized = normalizeText(value, 300)
  if (!normalized) throw new Error(`${field} is required`)
  return normalized
}

function normalizeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => normalizeText(item)).filter(Boolean))]
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function normalizePositiveInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const rpaImprovementProposalRepository = new RpaImprovementProposalRepository()
export const rpaImprovementProposalService = new RpaImprovementProposalService()
