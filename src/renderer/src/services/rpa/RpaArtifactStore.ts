import { loggerService } from '@logger'
import type { FileMetadata } from '@renderer/types'

import { redactRpaKnowledgeText } from './RpaKnowledge'

const logger = loggerService.withContext('RpaArtifactStore')

export const RPA_ARTIFACT_CATEGORIES = [
  'sop_import',
  'screenshot',
  'ui_tree',
  'ocr_capture',
  'run_log',
  'debug_bundle',
  'exported_dsl',
  'app_reference_image',
  'other'
] as const

export type RpaArtifactCategory = (typeof RPA_ARTIFACT_CATEGORIES)[number]
export type RpaArtifactLinkTarget =
  | 'run'
  | 'device_run'
  | 'knowledge'
  | 'rpa_template'
  | 'rpa_skill'
  | 'improvement_proposal'
  | 'bug_report'
export type RpaArtifactPolicyAction = 'stored' | 'metadata_only' | 'summarized' | 'omitted'

export interface RpaArtifactLink {
  targetType: RpaArtifactLinkTarget
  targetId: string
  relation: string
}

export interface RpaArtifactLocator {
  fileId?: string
  externalPath?: string
  originalName?: string
  extension?: string
  mimeType?: string
}

export interface RpaArtifactRetention {
  policy: 'temporary' | 'standard' | 'long_term' | 'legal_hold'
  expiresAt?: number
}

export interface RpaArtifactRedaction {
  status: 'not_required' | 'required' | 'redacted' | 'skipped'
  fields: string[]
  checkedAt?: number
}

export interface RpaArtifactImportState {
  target: 'knowledge_draft' | 'rpa_template_draft' | 'unsupported'
  status: 'not_started' | 'ready' | 'imported' | 'failed'
  targetId?: string
  issues: string[]
  importedAt?: number
}

export interface RpaArtifact {
  id: string
  version: number
  category: RpaArtifactCategory
  title: string
  description?: string
  contentHash: string
  sizeBytes: number
  source: 'uploaded' | 'generated' | 'debug_export' | 'observation' | 'legacy_file'
  locator: RpaArtifactLocator
  links: RpaArtifactLink[]
  retention: RpaArtifactRetention
  redaction: RpaArtifactRedaction
  policyAction: RpaArtifactPolicyAction
  importState?: RpaArtifactImportState
  createdAt: number
  updatedAt: number
}

export interface RpaArtifactStorage {
  loadArtifacts(): Promise<RpaArtifact[]>
  saveArtifacts(artifacts: RpaArtifact[]): Promise<void>
}

export interface RpaArtifactPolicy {
  maxTotalBytes: number
  maxArtifactBytes: number
  maxBytesByCategory: Partial<Record<RpaArtifactCategory, number>>
  retentionDaysByCategory: Partial<Record<RpaArtifactCategory, number>>
}

export interface RegisterRpaArtifactInput {
  category?: RpaArtifactCategory
  title: string
  description?: string
  contentHash?: string
  sizeBytes: number
  source: RpaArtifact['source']
  locator: RpaArtifactLocator
  links?: RpaArtifactLink[]
  retentionPolicy?: RpaArtifactRetention['policy']
  textForRedaction?: string
  importState?: RpaArtifactImportState
}

export interface RegisterRpaArtifactResult {
  artifact: RpaArtifact
  deduplicated: boolean
  policyWarnings: string[]
}

export const DEFAULT_RPA_ARTIFACT_POLICY: RpaArtifactPolicy = {
  maxTotalBytes: 512 * 1024 * 1024,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxBytesByCategory: {
    screenshot: 8 * 1024 * 1024,
    ui_tree: 5 * 1024 * 1024,
    ocr_capture: 5 * 1024 * 1024,
    run_log: 10 * 1024 * 1024,
    debug_bundle: 64 * 1024 * 1024
  },
  retentionDaysByCategory: {
    screenshot: 30,
    ui_tree: 30,
    ocr_capture: 30,
    run_log: 90,
    debug_bundle: 30,
    exported_dsl: 365,
    sop_import: 3650,
    app_reference_image: 365
  }
}

export class LocalStorageRpaArtifactStorage implements RpaArtifactStorage {
  private readonly storageKey = 'rpa_artifacts'

  async loadArtifacts(): Promise<RpaArtifact[]> {
    if (typeof localStorage === 'undefined') return []
    try {
      const stored = localStorage.getItem(this.storageKey)
      return stored ? sanitizeRpaArtifacts(JSON.parse(stored)) : []
    } catch (error) {
      logger.warn('Failed to load local RPA artifacts', { error })
      return []
    }
  }

  async saveArtifacts(artifacts: RpaArtifact[]): Promise<void> {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(this.storageKey, JSON.stringify(sanitizeRpaArtifacts(artifacts)))
  }
}

export class IpcRpaArtifactStorage implements RpaArtifactStorage {
  constructor(private readonly fallback: RpaArtifactStorage = new LocalStorageRpaArtifactStorage()) {}

  async loadArtifacts(): Promise<RpaArtifact[]> {
    if (!window.api?.rpa?.loadArtifacts) return this.fallback.loadArtifacts()
    try {
      return sanitizeRpaArtifacts(await window.api.rpa.loadArtifacts())
    } catch (error) {
      logger.warn('Failed to load RPA artifacts through IPC', { error })
      return this.fallback.loadArtifacts()
    }
  }

  async saveArtifacts(artifacts: RpaArtifact[]): Promise<void> {
    const sanitized = sanitizeRpaArtifacts(artifacts)
    if (!window.api?.rpa?.saveArtifacts) return this.fallback.saveArtifacts(sanitized)
    try {
      await window.api.rpa.saveArtifacts(sanitized)
    } catch (error) {
      logger.warn('Failed to save RPA artifacts through IPC', { error })
      await this.fallback.saveArtifacts(sanitized)
    }
  }
}

export class RpaArtifactStore {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: RpaArtifactStorage = new IpcRpaArtifactStorage(),
    private readonly policy: RpaArtifactPolicy = DEFAULT_RPA_ARTIFACT_POLICY,
    private readonly now: () => number = Date.now
  ) {}

  async getAll(): Promise<RpaArtifact[]> {
    await this.writeQueue
    return sanitizeRpaArtifacts(await this.storage.loadArtifacts())
  }

  async getById(id: string): Promise<RpaArtifact | undefined> {
    const normalizedId = requireId(id, 'id')
    return (await this.getAll()).find((artifact) => artifact.id === normalizedId)
  }

  async findByLink(targetType: RpaArtifactLinkTarget, targetId: string): Promise<RpaArtifact[]> {
    const normalizedId = requireId(targetId, 'targetId')
    return (await this.getAll()).filter((artifact) =>
      artifact.links.some((link) => link.targetType === targetType && link.targetId === normalizedId)
    )
  }

  async register(input: RegisterRpaArtifactInput): Promise<RegisterRpaArtifactResult> {
    const normalized = normalizeRegistrationInput(input, this.now(), this.policy)
    return this.enqueueWrite(async () => {
      const artifacts = sanitizeRpaArtifacts(await this.storage.loadArtifacts())
      const existing = artifacts.find((artifact) => artifact.contentHash === normalized.artifact.contentHash)
      if (existing) {
        const mergedLinks = sanitizeLinks([...existing.links, ...normalized.artifact.links])
        const changed = JSON.stringify(mergedLinks) !== JSON.stringify(existing.links)
        if (!changed) return { artifact: existing, deduplicated: true, policyWarnings: normalized.policyWarnings }

        const updated = { ...existing, links: mergedLinks, version: existing.version + 1, updatedAt: this.now() }
        await this.storage.saveArtifacts([...artifacts.filter((artifact) => artifact.id !== existing.id), updated])
        return { artifact: updated, deduplicated: true, policyWarnings: normalized.policyWarnings }
      }

      const activeBytes = artifacts
        .filter((artifact) => artifact.policyAction !== 'omitted')
        .reduce((total, artifact) => total + artifact.sizeBytes, 0)
      let artifact = normalized.artifact
      const policyWarnings = [...normalized.policyWarnings]
      if (activeBytes + artifact.sizeBytes > this.policy.maxTotalBytes) {
        artifact = { ...artifact, policyAction: 'metadata_only' }
        policyWarnings.push('Artifact total capacity limit reached; only metadata was retained')
      }

      await this.storage.saveArtifacts([artifact, ...artifacts])
      return { artifact, deduplicated: false, policyWarnings }
    })
  }

  async update(artifact: RpaArtifact): Promise<RpaArtifact> {
    const sanitized = sanitizeRpaArtifact(artifact)
    if (!sanitized) throw new Error('Invalid RPA artifact')
    return this.enqueueWrite(async () => {
      const artifacts = sanitizeRpaArtifacts(await this.storage.loadArtifacts())
      const existing = artifacts.find((candidate) => candidate.id === sanitized.id)
      if (!existing) throw new Error(`RPA artifact not found: ${sanitized.id}`)
      const saved = {
        ...sanitized,
        version: existing.version + 1,
        createdAt: existing.createdAt,
        updatedAt: this.now()
      }
      await this.storage.saveArtifacts([...artifacts.filter((candidate) => candidate.id !== saved.id), saved])
      return saved
    })
  }

  async link(id: string, link: RpaArtifactLink): Promise<RpaArtifact> {
    const artifact = await this.getById(id)
    if (!artifact) throw new Error(`RPA artifact not found: ${id}`)
    const links = sanitizeLinks([...artifact.links, link])
    if (JSON.stringify(links) === JSON.stringify(artifact.links)) return artifact
    return this.update({ ...artifact, links })
  }

  async removeMetadata(id: string): Promise<boolean> {
    const normalizedId = requireId(id, 'id')
    return this.enqueueWrite(async () => {
      const artifacts = sanitizeRpaArtifacts(await this.storage.loadArtifacts())
      const next = artifacts.filter((artifact) => artifact.id !== normalizedId)
      if (next.length === artifacts.length) return false
      await this.storage.saveArtifacts(next)
      return true
    })
  }

  async cleanupExpired(now = this.now()): Promise<string[]> {
    return this.enqueueWrite(async () => {
      const artifacts = sanitizeRpaArtifacts(await this.storage.loadArtifacts())
      const expired = artifacts.filter(
        (artifact) =>
          artifact.retention.policy !== 'legal_hold' &&
          artifact.retention.expiresAt !== undefined &&
          artifact.retention.expiresAt <= now
      )
      if (!expired.length) return []
      const expiredIds = new Set(expired.map((artifact) => artifact.id))
      await this.storage.saveArtifacts(artifacts.filter((artifact) => !expiredIds.has(artifact.id)))
      return [...expiredIds]
    })
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export function artifactInputFromFile(
  file: FileMetadata,
  overrides: Partial<RegisterRpaArtifactInput> = {}
): RegisterRpaArtifactInput {
  return {
    title: file.origin_name || file.name,
    category: categorizeRpaArtifact(file.ext, file.type),
    contentHash: `file:${file.id}`,
    sizeBytes: file.size,
    source: 'legacy_file',
    locator: {
      fileId: file.id,
      originalName: file.origin_name,
      extension: normalizeExtension(file.ext)
    },
    ...overrides
  }
}

export function categorizeRpaArtifact(extension?: string, fileType?: string): RpaArtifactCategory {
  const ext = normalizeExtension(extension)
  if (['.md', '.txt', '.pdf', '.doc', '.docx', '.html'].includes(ext)) return 'sop_import'
  if (['.json', '.yaml', '.yml'].includes(ext)) return 'exported_dsl'
  if (['.xml', '.uix'].includes(ext)) return 'ui_tree'
  if (['.log'].includes(ext)) return 'run_log'
  if (ext === '.zip') return 'debug_bundle'
  if (fileType === 'image' || ['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'app_reference_image'
  return 'other'
}

export function sanitizeRpaArtifact(value: unknown): RpaArtifact | undefined {
  if (!isRecord(value)) return undefined
  const id = normalizeId(value.id)
  const title = normalizeText(value.title, 240)
  const contentHash = normalizeId(value.contentHash)
  if (!id || !title || !contentHash || !isCategory(value.category)) return undefined
  const createdAt = normalizeTimestamp(value.createdAt, 0)
  const updatedAt = Math.max(createdAt, normalizeTimestamp(value.updatedAt, createdAt))
  return {
    id,
    version: normalizePositiveInteger(value.version, 1),
    category: value.category,
    title,
    description: normalizeOptionalText(value.description, 2_000),
    contentHash,
    sizeBytes: normalizeNonNegativeInteger(value.sizeBytes),
    source: isSource(value.source) ? value.source : 'generated',
    locator: sanitizeLocator(value.locator),
    links: sanitizeLinks(value.links),
    retention: sanitizeRetention(value.retention),
    redaction: sanitizeRedaction(value.redaction),
    policyAction: isPolicyAction(value.policyAction) ? value.policyAction : 'metadata_only',
    importState: sanitizeImportState(value.importState),
    createdAt,
    updatedAt
  }
}

export function sanitizeRpaArtifacts(value: unknown): RpaArtifact[] {
  if (!Array.isArray(value)) return []
  const artifacts = new Map<string, RpaArtifact>()
  const hashes = new Map<string, string>()
  for (const candidate of value) {
    const artifact = sanitizeRpaArtifact(candidate)
    if (!artifact) continue
    const existingId = hashes.get(artifact.contentHash)
    if (existingId) {
      const existing = artifacts.get(existingId)!
      artifacts.set(existingId, {
        ...(artifact.version > existing.version ? artifact : existing),
        links: sanitizeLinks([...existing.links, ...artifact.links])
      })
      continue
    }
    artifacts.set(artifact.id, artifact)
    hashes.set(artifact.contentHash, artifact.id)
  }
  return [...artifacts.values()].sort((left, right) => right.updatedAt - left.updatedAt)
}

function normalizeRegistrationInput(
  input: RegisterRpaArtifactInput,
  now: number,
  policy: RpaArtifactPolicy
): { artifact: RpaArtifact; policyWarnings: string[] } {
  const title = normalizeText(input.title, 240)
  if (!title) throw new Error('Artifact title is required')
  const sizeBytes = normalizeNonNegativeInteger(input.sizeBytes)
  const category = input.category ?? categorizeRpaArtifact(input.locator.extension)
  const contentHash = normalizeId(input.contentHash) ?? fallbackContentHash(input.locator, sizeBytes)
  const redacted = redactRpaKnowledgeText(input.textForRedaction ?? '', 2_000)
  const retention = createRetention(category, input.retentionPolicy ?? 'standard', now, policy)
  const categoryLimit = policy.maxBytesByCategory[category] ?? policy.maxArtifactBytes
  const policyWarnings: string[] = []
  let policyAction: RpaArtifactPolicyAction = 'stored'
  if (sizeBytes > categoryLimit) {
    policyAction = isTextCategory(category) ? 'summarized' : 'metadata_only'
    policyWarnings.push(`Artifact exceeds the ${category} size limit; content persistence was reduced`)
  }

  return {
    artifact: {
      id: `rpa-artifact-${now}-${Math.random().toString(36).slice(2, 10)}`,
      version: 1,
      category,
      title,
      description: redacted.text || normalizeOptionalText(input.description, 2_000),
      contentHash,
      sizeBytes,
      source: input.source,
      locator: sanitizeLocator(input.locator),
      links: sanitizeLinks(input.links),
      retention,
      redaction: {
        status: redacted.redactions.length ? 'redacted' : requiresRedaction(category) ? 'required' : 'not_required',
        fields: redacted.redactions,
        checkedAt: redacted.redactions.length ? now : undefined
      },
      policyAction,
      importState: input.importState,
      createdAt: now,
      updatedAt: now
    },
    policyWarnings
  }
}

function createRetention(
  category: RpaArtifactCategory,
  retentionPolicy: RpaArtifactRetention['policy'],
  now: number,
  policy: RpaArtifactPolicy
): RpaArtifactRetention {
  if (retentionPolicy === 'legal_hold') return { policy: retentionPolicy }
  const defaultDays = policy.retentionDaysByCategory[category] ?? (retentionPolicy === 'temporary' ? 7 : 90)
  const days = retentionPolicy === 'long_term' ? Math.max(365, defaultDays) : defaultDays
  return { policy: retentionPolicy, expiresAt: now + days * 24 * 60 * 60 * 1_000 }
}

function sanitizeLocator(value: unknown): RpaArtifactLocator {
  const source = isRecord(value) ? value : {}
  return {
    fileId: normalizeId(source.fileId),
    externalPath: normalizeId(source.externalPath),
    originalName: normalizeId(source.originalName),
    extension: normalizeExtension(source.extension),
    mimeType: normalizeId(source.mimeType)
  }
}

function sanitizeLinks(value: unknown): RpaArtifactLink[] {
  if (!Array.isArray(value)) return []
  const links = new Map<string, RpaArtifactLink>()
  for (const candidate of value) {
    if (!isRecord(candidate) || !isLinkTarget(candidate.targetType)) continue
    const targetId = normalizeId(candidate.targetId)
    const relation = normalizeText(candidate.relation, 120)
    if (!targetId || !relation) continue
    const link = { targetType: candidate.targetType, targetId, relation }
    links.set(`${link.targetType}:${link.targetId}:${link.relation}`, link)
  }
  return [...links.values()]
}

function sanitizeRetention(value: unknown): RpaArtifactRetention {
  if (!isRecord(value) || !isRetentionPolicy(value.policy)) return { policy: 'standard' }
  return {
    policy: value.policy,
    expiresAt: value.expiresAt === undefined ? undefined : normalizeTimestamp(value.expiresAt, 0)
  }
}

function sanitizeRedaction(value: unknown): RpaArtifactRedaction {
  if (!isRecord(value) || !isRedactionStatus(value.status)) return { status: 'required', fields: [] }
  return {
    status: value.status,
    fields: sanitizeStringList(value.fields),
    checkedAt: value.checkedAt === undefined ? undefined : normalizeTimestamp(value.checkedAt, 0)
  }
}

function sanitizeImportState(value: unknown): RpaArtifactImportState | undefined {
  if (!isRecord(value) || !isImportTarget(value.target) || !isImportStatus(value.status)) return undefined
  return {
    target: value.target,
    status: value.status,
    targetId: normalizeId(value.targetId),
    issues: sanitizeStringList(value.issues),
    importedAt: value.importedAt === undefined ? undefined : normalizeTimestamp(value.importedAt, 0)
  }
}

function fallbackContentHash(locator: RpaArtifactLocator, sizeBytes: number): string {
  const identity = locator.fileId ?? locator.externalPath
  if (!identity) throw new Error('Artifact requires contentHash, fileId, or externalPath')
  return `ref-${simpleHash(`${identity}:${sizeBytes}`)}`
}

function simpleHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function normalizeExtension(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  const normalized = value.trim().toLowerCase()
  return normalized.startsWith('.') ? normalized : `.${normalized}`
}

function normalizeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function requireId(value: unknown, field: string): string {
  const normalized = normalizeId(value)
  if (!normalized) throw new Error(`${field} is required`)
  return normalized
}

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function normalizeOptionalText(value: unknown, maxLength: number): string | undefined {
  return normalizeText(value, maxLength) || undefined
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(normalizeId).filter((item): item is string => Boolean(item)))].sort()
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback
}

function normalizeNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function isCategory(value: unknown): value is RpaArtifactCategory {
  return typeof value === 'string' && (RPA_ARTIFACT_CATEGORIES as readonly string[]).includes(value)
}

function isSource(value: unknown): value is RpaArtifact['source'] {
  return ['uploaded', 'generated', 'debug_export', 'observation', 'legacy_file'].includes(String(value))
}

function isLinkTarget(value: unknown): value is RpaArtifactLinkTarget {
  return ['run', 'device_run', 'knowledge', 'rpa_template', 'rpa_skill', 'improvement_proposal', 'bug_report'].includes(
    String(value)
  )
}

function isRetentionPolicy(value: unknown): value is RpaArtifactRetention['policy'] {
  return ['temporary', 'standard', 'long_term', 'legal_hold'].includes(String(value))
}

function isRedactionStatus(value: unknown): value is RpaArtifactRedaction['status'] {
  return ['not_required', 'required', 'redacted', 'skipped'].includes(String(value))
}

function isPolicyAction(value: unknown): value is RpaArtifactPolicyAction {
  return ['stored', 'metadata_only', 'summarized', 'omitted'].includes(String(value))
}

function isImportTarget(value: unknown): value is RpaArtifactImportState['target'] {
  return ['knowledge_draft', 'rpa_template_draft', 'unsupported'].includes(String(value))
}

function isImportStatus(value: unknown): value is RpaArtifactImportState['status'] {
  return ['not_started', 'ready', 'imported', 'failed'].includes(String(value))
}

function requiresRedaction(category: RpaArtifactCategory): boolean {
  return ['screenshot', 'ui_tree', 'ocr_capture', 'run_log', 'debug_bundle'].includes(category)
}

function isTextCategory(category: RpaArtifactCategory): boolean {
  return ['sop_import', 'ui_tree', 'ocr_capture', 'run_log', 'exported_dsl'].includes(category)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const rpaArtifactStore = new RpaArtifactStore()
