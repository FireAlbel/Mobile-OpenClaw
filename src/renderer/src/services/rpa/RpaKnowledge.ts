import { loggerService } from '@logger'

const logger = loggerService.withContext('RpaKnowledge')

export const RPA_KNOWLEDGE_CATEGORIES = [
  'app_sop',
  'page_state_explanation',
  'locator_guidance',
  'failure_case',
  'recovery_guidance',
  'version_note',
  'policy_note'
] as const

export type RpaKnowledgeCategory = (typeof RPA_KNOWLEDGE_CATEGORIES)[number]
export type RpaKnowledgeReviewStatus = 'draft' | 'reviewed' | 'rejected'

export interface RpaKnowledgeSkillLink {
  skillId: string
  version?: string
}

export interface RpaKnowledgeLinks {
  templateIds: string[]
  skills: RpaKnowledgeSkillLink[]
  stateIds: string[]
  failureFingerprintIds: string[]
  artifactIds: string[]
}

export interface RpaKnowledgeScope {
  appPackages: string[]
  taskGoals: string[]
  stateIds: string[]
  errorClasses: string[]
}

export interface RpaKnowledgeSource {
  type: 'manual' | 'run_summary' | 'debug_summary' | 'imported_manual'
  runId?: string
  deviceRunIds?: string[]
}

export interface RpaKnowledgeImprovementSuggestion {
  targetType: 'rpa_template' | 'skill'
  targetId: string
  reason: string
  status: 'pending' | 'accepted' | 'rejected'
}

export interface RpaKnowledgeEntry {
  id: string
  knowledgeBaseId: string
  version: number
  category: RpaKnowledgeCategory
  title: string
  summary: string
  content: string
  reviewStatus: RpaKnowledgeReviewStatus
  confidence: number
  scope: RpaKnowledgeScope
  links: RpaKnowledgeLinks
  source: RpaKnowledgeSource
  improvementSuggestions: RpaKnowledgeImprovementSuggestion[]
  redactions: string[]
  createdAt: number
  updatedAt: number
  reviewedAt?: number
}

export interface RpaKnowledgeStorage {
  loadEntries(): Promise<RpaKnowledgeEntry[]>
  saveEntries(entries: RpaKnowledgeEntry[]): Promise<void>
}

export interface RpaKnowledgeRedactionResult {
  text: string
  redactions: string[]
}

const REDACTION_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi },
  { name: 'api_key', pattern: /\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g },
  {
    name: 'credential_field',
    pattern: /\b(?:api[_-]?key|access[_-]?token|password|passwd|secret)\s*[:=]\s*[^\s,;]+/gi
  },
  { name: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { name: 'phone', pattern: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g }
]

export function redactRpaKnowledgeText(value: unknown, maxLength = 12_000): RpaKnowledgeRedactionResult {
  let text = typeof value === 'string' ? value : String(value ?? '')
  const redactions = new Set<string>()
  for (const rule of REDACTION_RULES) {
    text = text.replace(rule.pattern, () => {
      redactions.add(rule.name)
      return `[REDACTED:${rule.name}]`
    })
  }
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}\n[TRUNCATED]`
    redactions.add('truncated')
  }
  return { text, redactions: [...redactions] }
}

export function sanitizeRpaKnowledgeEntry(value: unknown): RpaKnowledgeEntry | undefined {
  if (!isRecord(value)) return undefined
  const id = normalizeId(value.id)
  const knowledgeBaseId = normalizeId(value.knowledgeBaseId)
  const title = normalizeText(value.title, 200)
  if (!id || !knowledgeBaseId || !title || !isCategory(value.category)) return undefined

  const summary = redactRpaKnowledgeText(normalizeText(value.summary, 2_000))
  const content = redactRpaKnowledgeText(normalizeText(value.content, 12_000))
  const createdAt = normalizeTimestamp(value.createdAt, 0)
  const updatedAt = Math.max(createdAt, normalizeTimestamp(value.updatedAt, createdAt))
  const reviewedAt = value.reviewedAt === undefined ? undefined : normalizeTimestamp(value.reviewedAt, updatedAt)

  return {
    id,
    knowledgeBaseId,
    version: normalizePositiveInteger(value.version, 1),
    category: value.category,
    title,
    summary: summary.text,
    content: content.text,
    reviewStatus: isReviewStatus(value.reviewStatus) ? value.reviewStatus : 'draft',
    confidence: clampNumber(value.confidence, 0, 1, 0.5),
    scope: sanitizeScope(value.scope),
    links: sanitizeLinks(value.links),
    source: sanitizeSource(value.source),
    improvementSuggestions: sanitizeImprovementSuggestions(value.improvementSuggestions),
    redactions: [...new Set([...sanitizeStringList(value.redactions), ...summary.redactions, ...content.redactions])],
    createdAt,
    updatedAt,
    reviewedAt
  }
}

export function sanitizeRpaKnowledgeEntries(value: unknown): RpaKnowledgeEntry[] {
  if (!Array.isArray(value)) return []
  const entries = new Map<string, RpaKnowledgeEntry>()
  for (const candidate of value) {
    const entry = sanitizeRpaKnowledgeEntry(candidate)
    if (!entry) continue
    // Legacy per-run summaries are superseded by bounded structured failure fingerprints.
    if (entry.source.type === 'run_summary') continue
    const existing = entries.get(entry.id)
    if (!existing || entry.version > existing.version || entry.updatedAt > existing.updatedAt) {
      entries.set(entry.id, entry)
    }
  }
  return [...entries.values()].sort((left, right) => right.updatedAt - left.updatedAt)
}

export class LocalStorageRpaKnowledgeStorage implements RpaKnowledgeStorage {
  private readonly storageKey = 'rpa_knowledge_entries'

  async loadEntries(): Promise<RpaKnowledgeEntry[]> {
    if (typeof localStorage === 'undefined') return []
    try {
      const stored = localStorage.getItem(this.storageKey)
      return stored ? sanitizeRpaKnowledgeEntries(JSON.parse(stored)) : []
    } catch (error) {
      logger.warn('Failed to load local RPA knowledge entries', { error })
      return []
    }
  }

  async saveEntries(entries: RpaKnowledgeEntry[]): Promise<void> {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(this.storageKey, JSON.stringify(sanitizeRpaKnowledgeEntries(entries)))
  }
}

export class IpcRpaKnowledgeStorage implements RpaKnowledgeStorage {
  constructor(private readonly fallback: RpaKnowledgeStorage = new LocalStorageRpaKnowledgeStorage()) {}

  async loadEntries(): Promise<RpaKnowledgeEntry[]> {
    if (!window.api?.rpa?.loadKnowledgeEntries) return this.fallback.loadEntries()
    try {
      return sanitizeRpaKnowledgeEntries(await window.api.rpa.loadKnowledgeEntries())
    } catch (error) {
      logger.warn('Failed to load RPA knowledge entries through IPC', { error })
      return this.fallback.loadEntries()
    }
  }

  async saveEntries(entries: RpaKnowledgeEntry[]): Promise<void> {
    const sanitized = sanitizeRpaKnowledgeEntries(entries)
    if (!window.api?.rpa?.saveKnowledgeEntries) return this.fallback.saveEntries(sanitized)
    try {
      await window.api.rpa.saveKnowledgeEntries(sanitized)
    } catch (error) {
      logger.warn('Failed to save RPA knowledge entries through IPC', { error })
      await this.fallback.saveEntries(sanitized)
    }
  }
}

export class RpaKnowledgeRepository {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: RpaKnowledgeStorage = new IpcRpaKnowledgeStorage(),
    private readonly now: () => number = Date.now
  ) {}

  async getAll(): Promise<RpaKnowledgeEntry[]> {
    await this.writeQueue
    return sanitizeRpaKnowledgeEntries(await this.storage.loadEntries())
  }

  async getByKnowledgeBaseId(knowledgeBaseId: string): Promise<RpaKnowledgeEntry[]> {
    const normalizedId = requireId(knowledgeBaseId, 'knowledgeBaseId')
    return (await this.getAll()).filter((entry) => entry.knowledgeBaseId === normalizedId)
  }

  async getById(id: string): Promise<RpaKnowledgeEntry | undefined> {
    const normalizedId = requireId(id, 'id')
    return (await this.getAll()).find((entry) => entry.id === normalizedId)
  }

  async save(input: RpaKnowledgeEntry): Promise<RpaKnowledgeEntry> {
    const sanitized = sanitizeRpaKnowledgeEntry(input)
    if (!sanitized) throw new Error('Invalid RPA knowledge entry')

    return this.enqueueWrite(async () => {
      const entries = sanitizeRpaKnowledgeEntries(await this.storage.loadEntries())
      const existing = entries.find((entry) => entry.id === sanitized.id)
      const now = this.now()
      const saved: RpaKnowledgeEntry = {
        ...sanitized,
        version: existing ? existing.version + 1 : 1,
        createdAt: existing?.createdAt ?? sanitized.createdAt ?? now,
        updatedAt: now,
        reviewedAt:
          sanitized.reviewStatus === 'reviewed' ? (sanitized.reviewedAt ?? existing?.reviewedAt ?? now) : undefined
      }
      await this.storage.saveEntries([...entries.filter((entry) => entry.id !== saved.id), saved])
      return saved
    })
  }

  async remove(id: string): Promise<boolean> {
    const normalizedId = requireId(id, 'id')
    return this.enqueueWrite(async () => {
      const entries = sanitizeRpaKnowledgeEntries(await this.storage.loadEntries())
      const next = entries.filter((entry) => entry.id !== normalizedId)
      if (next.length === entries.length) return false
      await this.storage.saveEntries(next)
      return true
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

export function createDefaultRpaKnowledgeEntry(
  knowledgeBaseId: string,
  category: RpaKnowledgeCategory = 'app_sop',
  now = Date.now()
): RpaKnowledgeEntry {
  return {
    id: `rpa-knowledge-${now}-${Math.random().toString(36).slice(2, 10)}`,
    knowledgeBaseId: requireId(knowledgeBaseId, 'knowledgeBaseId'),
    version: 1,
    category,
    title: 'New RPA knowledge entry',
    summary: '',
    content: '',
    reviewStatus: 'draft',
    confidence: 0.5,
    scope: { appPackages: [], taskGoals: [], stateIds: [], errorClasses: [] },
    links: { templateIds: [], skills: [], stateIds: [], failureFingerprintIds: [], artifactIds: [] },
    source: { type: 'manual' },
    improvementSuggestions: [],
    redactions: [],
    createdAt: now,
    updatedAt: now
  }
}

function sanitizeScope(value: unknown): RpaKnowledgeScope {
  const source = isRecord(value) ? value : {}
  return {
    appPackages: sanitizeStringList(source.appPackages),
    taskGoals: sanitizeStringList(source.taskGoals),
    stateIds: sanitizeStringList(source.stateIds),
    errorClasses: sanitizeStringList(source.errorClasses)
  }
}

function sanitizeLinks(value: unknown): RpaKnowledgeLinks {
  const source = isRecord(value) ? value : {}
  const skills = Array.isArray(source.skills)
    ? source.skills.flatMap((candidate) => {
        if (!isRecord(candidate)) return []
        const skillId = normalizeId(candidate.skillId)
        return skillId ? [{ skillId, version: normalizeId(candidate.version) }] : []
      })
    : []
  return {
    templateIds: sanitizeStringList(source.templateIds),
    skills: [...new Map(skills.map((skill) => [skill.skillId, skill])).values()],
    stateIds: sanitizeStringList(source.stateIds),
    failureFingerprintIds: sanitizeStringList(source.failureFingerprintIds),
    artifactIds: sanitizeStringList(source.artifactIds)
  }
}

function sanitizeSource(value: unknown): RpaKnowledgeSource {
  if (!isRecord(value)) return { type: 'manual' }
  const allowed = new Set<RpaKnowledgeSource['type']>(['manual', 'run_summary', 'debug_summary', 'imported_manual'])
  const type =
    typeof value.type === 'string' && allowed.has(value.type as RpaKnowledgeSource['type'])
      ? (value.type as RpaKnowledgeSource['type'])
      : 'manual'
  return { type, runId: normalizeId(value.runId), deviceRunIds: sanitizeStringList(value.deviceRunIds) }
}

function sanitizeImprovementSuggestions(value: unknown): RpaKnowledgeImprovementSuggestion[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const targetType = candidate.targetType
    const targetId = normalizeId(candidate.targetId)
    const reason = normalizeText(candidate.reason, 1_000)
    const status = candidate.status
    if (
      (targetType !== 'rpa_template' && targetType !== 'skill') ||
      !targetId ||
      !reason ||
      (status !== 'pending' && status !== 'accepted' && status !== 'rejected')
    ) {
      return []
    }
    return [{ targetType, targetId, reason, status }]
  })
}

function isCategory(value: unknown): value is RpaKnowledgeCategory {
  return typeof value === 'string' && (RPA_KNOWLEDGE_CATEGORIES as readonly string[]).includes(value)
}

function isReviewStatus(value: unknown): value is RpaKnowledgeReviewStatus {
  return value === 'draft' || value === 'reviewed' || value === 'rejected'
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

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const rpaKnowledgeRepository = new RpaKnowledgeRepository()
