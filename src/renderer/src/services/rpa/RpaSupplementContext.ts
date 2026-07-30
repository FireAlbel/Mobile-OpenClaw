import { loggerService } from '@logger'
import { ocr } from '@renderer/services/ocr/OcrService'
import type { FileMetadata, OcrProvider } from '@renderer/types'
import { isSupportedOcrFile } from '@renderer/types'

import type { RpaRoleVersionReference } from './RpaAppRole'
import { artifactInputFromFile, type RpaArtifact, rpaArtifactStore } from './RpaArtifactStore'
import type { RpaModelReference } from './RpaAssistantProfile'
import { redactRpaKnowledgeText } from './RpaKnowledge'

const logger = loggerService.withContext('RpaSupplementContext')

export type RpaSupplementExtractionStatus = 'ready' | 'degraded' | 'blocked' | 'unsupported'

export interface RpaSupplementChunk {
  id: string
  indexId: string
  artifactId: string
  ordinal: number
  content: string
  contentHash: string
  locator: { page?: number; section?: string; start: number; end: number }
  language?: string
  quality: number
  extractionMethod: 'text' | 'office' | 'structured' | 'ocr' | 'vlm' | 'remote' | 'mcp'
}

export interface RpaTemporaryArtifactIndex {
  schemaVersion: 1
  id: string
  sessionId: string
  requestId?: string
  artifactId: string
  artifactVersion: number
  artifactHash: string
  extractorVersion: string
  status: RpaSupplementExtractionStatus
  chunks: RpaSupplementChunk[]
  evidence: RpaSupplementEvidenceRecord[]
  warnings: string[]
  retention: { expiresAt?: number; retained: boolean; tombstonedAt?: number }
  createdAt: number
  updatedAt: number
}

export interface RpaSupplementEvidenceRecord {
  id: string
  sourceType: 'artifact_text' | 'ocr' | 'vlm' | 'remote' | 'mcp'
  sourceId: string
  contentHash: string
  boundedContent: string
  model?: RpaModelReference
  providerId?: string
  promptVersion?: string
  capturedAt: number
  redacted: boolean
  truncated: boolean
}

export interface RpaPlanningEvidenceSnapshotItem {
  evidenceId: string
  sourceId: string
  sourceType: string
  owner: 'role' | 'session' | 'execution'
  version?: string
  contentHash: string
  boundedContent?: string
  localRank: number
  fusedRank: number
  rerankedRank?: number
  locator?: string
  authority: number
  relevance: number
  freshness: number
  extractionConfidence: number
  contributingSourceIds: string[]
}

export interface RpaSupplementContextSnapshot {
  schemaVersion: 1
  id: string
  sessionId: string
  requestId: string
  revision?: number
  role: RpaRoleVersionReference
  supplementRevision: number
  model?: RpaModelReference
  evidence: RpaPlanningEvidenceSnapshotItem[]
  conflicts: string[]
  omissions: string[]
  providerCalls: Array<{ providerId: string; operation: string; status: string; durationMs?: number }>
  ranking: { algorithm: 'rrf'; version: string; k: number; reranker?: RpaModelReference; fallback?: string }
  policy: { truncated: boolean; redacted: boolean; injectionAttempts: number }
  retention: { evidenceExpiresAt?: number; auditExpiresAt?: number; tombstonedSourceIds: string[] }
  createdAt: number
}

export interface RpaSupplementPromotionProposal {
  id: string
  sessionId: string
  bindingId: string
  sourceId: string
  target: 'knowledge' | 'artifact' | 'skill' | 'prompt' | 'provider'
  status: 'pending_review' | 'approved' | 'rejected'
  reason?: string
  createdAt: number
  reviewedAt?: number
}

export interface RpaSupplementContextState {
  schemaVersion: 1
  indexes: RpaTemporaryArtifactIndex[]
  snapshots: RpaSupplementContextSnapshot[]
  promotionProposals: RpaSupplementPromotionProposal[]
}

export interface RpaSupplementContextStorage {
  load(): Promise<unknown>
  save(state: RpaSupplementContextState): Promise<void>
}

class IpcRpaSupplementContextStorage implements RpaSupplementContextStorage {
  async load(): Promise<unknown> {
    if (!window.api?.rpa?.loadSupplementContext) return emptyState()
    return window.api.rpa.loadSupplementContext()
  }

  async save(state: RpaSupplementContextState): Promise<void> {
    if (!window.api?.rpa?.saveSupplementContext) return
    await window.api.rpa.saveSupplementContext(state)
  }
}

export class RpaSupplementContextRepository {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: RpaSupplementContextStorage = new IpcRpaSupplementContextStorage()) {}

  async getState(): Promise<RpaSupplementContextState> {
    await this.writeQueue
    return sanitizeState(await this.storage.load())
  }

  async saveIndex(index: RpaTemporaryArtifactIndex): Promise<RpaTemporaryArtifactIndex> {
    return this.update((state) => ({
      ...state,
      indexes: [index, ...state.indexes.filter((item) => item.id !== index.id)]
    })).then((state) => state.indexes.find((item) => item.id === index.id)!)
  }

  async saveSnapshot(snapshot: RpaSupplementContextSnapshot): Promise<RpaSupplementContextSnapshot> {
    return this.update((state) => ({
      ...state,
      snapshots: [snapshot, ...state.snapshots.filter((item) => item.id !== snapshot.id)].slice(0, 1_000)
    })).then((state) => state.snapshots.find((item) => item.id === snapshot.id)!)
  }

  async savePromotion(proposal: RpaSupplementPromotionProposal): Promise<RpaSupplementPromotionProposal> {
    return this.update((state) => ({
      ...state,
      promotionProposals: [proposal, ...state.promotionProposals.filter((item) => item.id !== proposal.id)]
    })).then((state) => state.promotionProposals.find((item) => item.id === proposal.id)!)
  }

  async cleanup(now = Date.now()): Promise<RpaSupplementContextState> {
    return this.update((state) => {
      const promotedSourceIds = new Set(
        state.promotionProposals
          .filter((proposal) => proposal.status === 'approved')
          .map((proposal) => proposal.sourceId)
      )
      return {
        ...state,
        indexes: state.indexes.map((index) =>
          index.retention.expiresAt &&
          index.retention.expiresAt <= now &&
          !index.retention.retained &&
          !promotedSourceIds.has(index.id) &&
          !promotedSourceIds.has(index.artifactId)
            ? {
                ...index,
                chunks: [],
                evidence: [],
                retention: { ...index.retention, tombstonedAt: now },
                updatedAt: now
              }
            : index
        ),
        snapshots: state.snapshots.map((snapshot) =>
          snapshot.retention.evidenceExpiresAt && snapshot.retention.evidenceExpiresAt <= now
            ? {
                ...snapshot,
                evidence: snapshot.evidence.map((item) => ({ ...item, boundedContent: undefined })),
                retention: {
                  ...snapshot.retention,
                  tombstonedSourceIds: uniqueStrings([
                    ...snapshot.retention.tombstonedSourceIds,
                    ...snapshot.evidence.map((item) => item.sourceId)
                  ])
                }
              }
            : snapshot
        )
      }
    })
  }

  private update(updater: (state: RpaSupplementContextState) => RpaSupplementContextState) {
    const operation = this.writeQueue.then(async () => {
      const next = sanitizeState(updater(sanitizeState(await this.storage.load())))
      await this.storage.save(next)
      return next
    })
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }
}

export interface RpaArtifactExtractionInput {
  sessionId: string
  requestId?: string
  file: FileMetadata
  retentionDays?: number
  maxTextChars?: number
  ocrProvider?: OcrProvider
  vlm?: {
    model: RpaModelReference
    providerId: string
    promptVersion: string
    analyze(file: FileMetadata, signal?: AbortSignal): Promise<string>
  }
  signal?: AbortSignal
}

export interface RpaArtifactExtractionResult {
  artifact: RpaArtifact
  index: RpaTemporaryArtifactIndex
}

export class RpaArtifactExtractionService {
  constructor(
    private readonly repository = new RpaSupplementContextRepository(),
    private readonly now: () => number = Date.now
  ) {}

  async extract(input: RpaArtifactExtractionInput): Promise<RpaArtifactExtractionResult> {
    if (input.signal?.aborted) throw new DOMException('Artifact extraction was cancelled', 'AbortError')
    const maxTextChars = Math.min(120_000, Math.max(2_000, input.maxTextChars ?? 40_000))
    const registration = await rpaArtifactStore.register(
      artifactInputFromFile(input.file, {
        source: 'uploaded',
        retentionPolicy: 'temporary',
        links: [{ targetType: 'run', targetId: input.sessionId, relation: 'session_supplement' }]
      })
    )
    const artifact = registration.artifact
    const now = this.now()
    const warnings = [...registration.policyWarnings]
    const evidence: RpaSupplementEvidenceRecord[] = []
    let text = ''
    let method: RpaSupplementChunk['extractionMethod'] = 'text'

    try {
      if (isSupportedOcrFile(input.file)) {
        const provider = input.ocrProvider ?? defaultOcrProvider()
        const result = await ocr(input.file, provider)
        text = result.text
        method = 'ocr'
        evidence.push(createEvidence('ocr', artifact.id, text, now, maxTextChars, { providerId: provider.id }))
        if (input.vlm) {
          try {
            const vlmText = await input.vlm.analyze(input.file, input.signal)
            evidence.push(
              createEvidence('vlm', artifact.id, vlmText, this.now(), maxTextChars, {
                providerId: input.vlm.providerId,
                model: input.vlm.model,
                promptVersion: input.vlm.promptVersion
              })
            )
            text = [text, vlmText].filter(Boolean).join('\n\n')
          } catch (error) {
            warnings.push(`VLM evidence unavailable: ${errorMessage(error)}`)
          }
        }
      } else if (input.file.path) {
        text = String(await window.api.file.readExternal(input.file.path, true))
        method = structuredExtensions.has(normalizeExtension(input.file.ext)) ? 'structured' : 'office'
        evidence.push(createEvidence('artifact_text', artifact.id, text, now, maxTextChars))
      }
    } catch (error) {
      warnings.push(`Artifact extraction failed: ${errorMessage(error)}`)
      logger.warn('RPA Supplement artifact extraction degraded', { artifactId: artifact.id, error })
    }

    const redacted = redactRpaKnowledgeText(text, maxTextChars)
    const chunks = chunkText(redacted.text, artifact.id, method)
    const status: RpaSupplementExtractionStatus = chunks.length ? (warnings.length ? 'degraded' : 'ready') : 'blocked'
    const index: RpaTemporaryArtifactIndex = {
      schemaVersion: 1,
      id: `rpa-index-${now}-${stableHash(artifact.id).slice(0, 8)}`,
      sessionId: input.sessionId,
      requestId: input.requestId,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      artifactHash: artifact.contentHash,
      extractorVersion: 'supplement-extractor/1',
      status,
      chunks,
      evidence,
      warnings,
      retention: {
        expiresAt: now + Math.max(1, input.retentionDays ?? 7) * 24 * 60 * 60 * 1_000,
        retained: false
      },
      createdAt: now,
      updatedAt: now
    }
    await this.repository.saveIndex(index)
    return { artifact, index }
  }
}

export class RpaContextSnapshotService {
  constructor(
    private readonly repository = new RpaSupplementContextRepository(),
    private readonly now: () => number = Date.now
  ) {}

  async create(
    input: Omit<RpaSupplementContextSnapshot, 'schemaVersion' | 'id' | 'createdAt'>
  ): Promise<RpaSupplementContextSnapshot> {
    const now = this.now()
    return this.repository.saveSnapshot({
      ...structuredClone(input),
      schemaVersion: 1,
      id: `rpa-context-${now}-${stableHash(`${input.sessionId}:${input.requestId}:${input.supplementRevision}`)}`,
      createdAt: now
    })
  }

  async replay(
    snapshotId: string,
    mode: 'audit' | 'model'
  ): Promise<{
    available: boolean
    degraded: boolean
    snapshot?: RpaSupplementContextSnapshot
    reason?: string
  }> {
    const snapshot = (await this.repository.getState()).snapshots.find((item) => item.id === snapshotId)
    if (!snapshot) return { available: false, degraded: true, reason: 'Context Snapshot not found' }
    if (mode === 'audit') return { available: true, degraded: false, snapshot }
    const missing = snapshot.evidence.some((item) => !item.boundedContent)
    return {
      available: !missing,
      degraded: missing,
      snapshot,
      reason: missing ? 'Exact bounded evidence expired; model replay is unavailable' : undefined
    }
  }
}

function createEvidence(
  sourceType: RpaSupplementEvidenceRecord['sourceType'],
  sourceId: string,
  raw: string,
  capturedAt: number,
  maxChars: number,
  details: Partial<Pick<RpaSupplementEvidenceRecord, 'providerId' | 'model' | 'promptVersion'>> = {}
): RpaSupplementEvidenceRecord {
  const redacted = redactRpaKnowledgeText(raw, maxChars)
  return {
    id: `evidence-${capturedAt}-${stableHash(`${sourceId}:${sourceType}:${raw}`).slice(0, 10)}`,
    sourceType,
    sourceId,
    contentHash: stableHash(redacted.text),
    boundedContent: redacted.text,
    capturedAt,
    redacted: redacted.redactions.length > 0,
    truncated: raw.length > redacted.text.length,
    ...details
  }
}

function chunkText(text: string, artifactId: string, method: RpaSupplementChunk['extractionMethod']) {
  const chunks: RpaSupplementChunk[] = []
  const sections = text
    .split(/\n{2,}/)
    .map((value) => value.trim())
    .filter(Boolean)
  const indexId = `index:${artifactId}`
  let buffer = ''
  let start = 0
  const flush = () => {
    const content = buffer.trim()
    if (!content) return
    const ordinal = chunks.length
    chunks.push({
      id: `chunk-${stableHash(`${artifactId}:${ordinal}:${content}`)}`,
      indexId,
      artifactId,
      ordinal,
      content,
      contentHash: stableHash(content),
      locator: { section: `chunk-${ordinal + 1}`, start, end: start + content.length },
      quality: method === 'ocr' ? 0.75 : 0.9,
      extractionMethod: method
    })
    start += content.length
    buffer = ''
  }
  for (const section of sections) {
    if (buffer && buffer.length + section.length + 2 > 1_500) flush()
    buffer += `${buffer ? '\n\n' : ''}${section}`
    if (buffer.length >= 1_500) flush()
  }
  flush()
  return chunks.slice(0, 80)
}

function sanitizeState(value: unknown): RpaSupplementContextState {
  if (!isRecord(value) || value.schemaVersion !== 1) return emptyState()
  return {
    schemaVersion: 1,
    indexes: Array.isArray(value.indexes) ? (structuredClone(value.indexes) as RpaTemporaryArtifactIndex[]) : [],
    snapshots: Array.isArray(value.snapshots)
      ? (structuredClone(value.snapshots) as RpaSupplementContextSnapshot[])
      : [],
    promotionProposals: Array.isArray(value.promotionProposals)
      ? (structuredClone(value.promotionProposals) as RpaSupplementPromotionProposal[])
      : []
  }
}

function emptyState(): RpaSupplementContextState {
  return { schemaVersion: 1, indexes: [], snapshots: [], promotionProposals: [] }
}

function defaultOcrProvider(): OcrProvider {
  return { id: 'system', name: 'Windows System OCR', capabilities: { image: true }, config: {} }
}

const structuredExtensions = new Set(['.json', '.yaml', '.yml', '.xml', '.csv', '.tsv'])

function normalizeExtension(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().toLowerCase()
  return normalized && !normalized.startsWith('.') ? `.${normalized}` : normalized
}

export function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const rpaSupplementContextRepository = new RpaSupplementContextRepository()
export const rpaArtifactExtractionService = new RpaArtifactExtractionService(rpaSupplementContextRepository)
export const rpaContextSnapshotService = new RpaContextSnapshotService(rpaSupplementContextRepository)
