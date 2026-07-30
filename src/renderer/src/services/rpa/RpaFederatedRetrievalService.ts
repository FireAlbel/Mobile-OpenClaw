import { loggerService } from '@logger'

import type { RpaModelReference } from './RpaAssistantProfile'
import type { RpaKnowledgeRetrievalResult } from './RpaKnowledgeRetrievalService'
import type { RpaPlanningEvidenceSnapshotItem, RpaTemporaryArtifactIndex } from './RpaSupplementContext'
import { stableHash } from './RpaSupplementContext'

const logger = loggerService.withContext('RpaFederatedRetrievalService')

export type RpaPlanningEvidenceSourceType =
  | 'role_knowledge'
  | 'session_knowledge'
  | 'temporary_index'
  | 'remote_provider'
  | 'mcp_resource'
  | 'execution_history'

export interface RpaPlanningEvidence {
  id: string
  sourceId: string
  sourceType: RpaPlanningEvidenceSourceType
  owner: 'role' | 'session' | 'execution'
  version?: string
  contentHash: string
  content: string
  localRank: number
  nativeScore?: number
  authority: number
  relevance: number
  freshness: number
  extractionConfidence: number
  timestamp: number
  locator?: string
  retrievalMetadata: Record<string, unknown>
  contributingSourceIds: string[]
}

export interface RpaFederatedRetrievalSource {
  id: string
  type: RpaPlanningEvidenceSourceType
  required: boolean
  quota: number
  timeoutMs: number
  search(input: { query: string; limit: number; signal: AbortSignal }): Promise<RpaPlanningEvidence[]>
}

export interface RpaEvidenceReranker {
  model: RpaModelReference
  rerank(input: { query: string; evidence: RpaPlanningEvidence[]; signal: AbortSignal }): Promise<string[]>
}

export interface RpaFederatedRetrievalInput {
  query: string
  sources: RpaFederatedRetrievalSource[]
  deadlineMs?: number
  limit?: number
  maxContextChars?: number
  rrfK?: number
  reranker?: RpaEvidenceReranker
  signal?: AbortSignal
}

export interface RpaFederatedRetrievalResult {
  evidence: RpaPlanningEvidence[]
  snapshotEvidence: RpaPlanningEvidenceSnapshotItem[]
  sourceFailures: Array<{ sourceId: string; required: boolean; reason: string }>
  conflicts: string[]
  omissions: string[]
  warnings: string[]
  executable: boolean
  provenance: {
    algorithm: 'rrf'
    version: '1'
    k: number
    reranker?: RpaModelReference
    rerankerFallback?: string
    sourceRanks: Record<string, string[]>
    truncated: boolean
    injectionAttempts: number
  }
}

export class RpaFederatedRetrievalService {
  async retrieve(input: RpaFederatedRetrievalInput): Promise<RpaFederatedRetrievalResult> {
    const deadlineMs = Math.min(60_000, Math.max(500, input.deadlineMs ?? 10_000))
    const limit = Math.min(50, Math.max(1, input.limit ?? 12))
    const rrfK = Math.min(100, Math.max(1, input.rrfK ?? 60))
    const controller = linkedAbortController(input.signal)
    const deadline = setTimeout(() => controller.abort('federated_deadline'), deadlineMs)
    const sourceFailures: RpaFederatedRetrievalResult['sourceFailures'] = []
    try {
      const settled = await Promise.all(
        input.sources.map(async (source) => {
          try {
            return {
              source,
              evidence: await withTimeout(
                source.search({
                  query: input.query,
                  limit: Math.min(limit, Math.max(1, source.quota)),
                  signal: controller.signal
                }),
                Math.min(deadlineMs, Math.max(100, source.timeoutMs)),
                controller.signal
              )
            }
          } catch (error) {
            sourceFailures.push({ sourceId: source.id, required: source.required, reason: errorMessage(error) })
            return { source, evidence: [] }
          }
        })
      )
      const sourceRanks = Object.fromEntries(
        settled.map(({ source, evidence }) => [source.id, evidence.map((item) => item.id)])
      )
      const fused = fuseWithRrf(settled, rrfK)
      const deduplicated = deduplicateEvidence(fused)
      const conflicts = detectEvidenceConflicts(deduplicated)
      let ranked = deduplicated
      let rerankerFallback: string | undefined
      if (input.reranker && ranked.length > 1) {
        try {
          const rerankedIds = await withTimeout(
            input.reranker.rerank({ query: input.query, evidence: ranked, signal: controller.signal }),
            Math.min(5_000, deadlineMs),
            controller.signal
          )
          ranked = applyRerankerOrder(ranked, rerankedIds)
        } catch (error) {
          rerankerFallback = errorMessage(error)
          logger.warn('RPA federated reranker fell back to deterministic RRF', { error })
        }
      }
      const injectionAttempts = ranked.filter((item) => hasPromptInjection(item.content)).length
      ranked = ranked.map((item) => ({
        ...item,
        content: quoteUntrustedEvidence(item.content),
        retrievalMetadata: {
          ...item.retrievalMetadata,
          promptInjectionDetected: hasPromptInjection(item.content)
        }
      }))
      const bounded = applyDiversityAndBudget(ranked, limit, input.maxContextChars ?? 16_000)
      const selectedIds = new Set(bounded.map((item) => item.id))
      const omissions = ranked.filter((item) => !selectedIds.has(item.id)).map((item) => item.id)
      return {
        evidence: bounded,
        snapshotEvidence: bounded.map((item, index) => ({
          evidenceId: item.id,
          sourceId: item.sourceId,
          sourceType: item.sourceType,
          owner: item.owner,
          version: item.version,
          contentHash: item.contentHash,
          boundedContent: item.content,
          localRank: item.localRank,
          fusedRank: index + 1,
          rerankedRank: input.reranker && !rerankerFallback ? index + 1 : undefined,
          locator: item.locator,
          authority: item.authority,
          relevance: item.relevance,
          freshness: item.freshness,
          extractionConfidence: item.extractionConfidence,
          contributingSourceIds: item.contributingSourceIds
        })),
        sourceFailures,
        conflicts,
        omissions,
        warnings: [
          ...sourceFailures
            .filter((failure) => !failure.required)
            .map((failure) => `${failure.sourceId}: ${failure.reason}`),
          ...(rerankerFallback ? [`Reranker fallback: ${rerankerFallback}`] : []),
          ...(injectionAttempts ? [`Blocked ${injectionAttempts} prompt-injection attempt(s) from evidence`] : [])
        ],
        executable: !sourceFailures.some((failure) => failure.required),
        provenance: {
          algorithm: 'rrf',
          version: '1',
          k: rrfK,
          reranker: input.reranker?.model,
          rerankerFallback,
          sourceRanks,
          truncated: omissions.length > 0,
          injectionAttempts
        }
      }
    } finally {
      clearTimeout(deadline)
    }
  }
}

export function createKnowledgeRetrievalSource(input: {
  id: string
  owner: 'role' | 'session'
  result: RpaKnowledgeRetrievalResult
  required?: boolean
}): RpaFederatedRetrievalSource {
  return {
    id: input.id,
    type: input.owner === 'role' ? 'role_knowledge' : 'session_knowledge',
    required: input.required ?? false,
    quota: 10,
    timeoutMs: 1_000,
    async search({ limit }) {
      return input.result.summaries.slice(0, limit).map((summary, index) => ({
        id: `evidence-${summary.id}`,
        sourceId: summary.id,
        sourceType: input.owner === 'role' ? 'role_knowledge' : 'session_knowledge',
        owner: input.owner,
        contentHash: stableHash(summary.summary),
        content: summary.summary,
        localRank: index + 1,
        nativeScore: summary.confidence,
        authority: input.owner === 'role' ? 0.9 : 0.65,
        relevance: summary.confidence,
        freshness: 0.5,
        extractionConfidence: 1,
        timestamp: 0,
        locator: summary.title,
        retrievalMetadata: { knowledgeBaseId: summary.knowledgeBaseId, category: summary.category },
        contributingSourceIds: [input.id]
      }))
    }
  }
}

export function createTemporaryIndexSource(
  index: RpaTemporaryArtifactIndex,
  options: { required?: boolean; quota?: number } = {}
): RpaFederatedRetrievalSource {
  return {
    id: index.id,
    type: 'temporary_index',
    required: options.required ?? false,
    quota: options.quota ?? 8,
    timeoutMs: 1_000,
    async search({ query, limit }) {
      const queryTokens = tokenize(query)
      return index.chunks
        .map((chunk) => {
          const overlap = [...tokenize(chunk.content)].filter((token) => queryTokens.has(token)).length
          return { chunk, score: overlap + chunk.quality }
        })
        .sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal)
        .slice(0, limit)
        .map(({ chunk, score }, localIndex) => ({
          id: `evidence-${chunk.id}`,
          sourceId: chunk.id,
          sourceType: 'temporary_index',
          owner: 'session',
          version: index.extractorVersion,
          contentHash: chunk.contentHash,
          content: chunk.content,
          localRank: localIndex + 1,
          nativeScore: score,
          authority: 0.65,
          relevance: Math.min(1, score / 5),
          freshness: 1,
          extractionConfidence: chunk.quality,
          timestamp: index.updatedAt,
          locator: chunk.locator.section,
          retrievalMetadata: { artifactId: index.artifactId, extractionMethod: chunk.extractionMethod },
          contributingSourceIds: [index.id]
        }))
    }
  }
}

function fuseWithRrf(
  sources: Array<{ source: RpaFederatedRetrievalSource; evidence: RpaPlanningEvidence[] }>,
  k: number
): RpaPlanningEvidence[] {
  const fused = new Map<string, { item: RpaPlanningEvidence; score: number }>()
  for (const { source, evidence } of sources) {
    evidence.slice(0, source.quota).forEach((item, index) => {
      const rank = index + 1
      const existing = fused.get(item.id)
      if (existing) {
        existing.score += 1 / (k + rank)
        existing.item.contributingSourceIds = uniqueStrings([...existing.item.contributingSourceIds, source.id])
      } else {
        fused.set(item.id, {
          item: {
            ...item,
            localRank: rank,
            contributingSourceIds: uniqueStrings([...item.contributingSourceIds, source.id])
          },
          score: 1 / (k + rank)
        })
      }
    })
  }
  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
    .map(({ item, score }) => ({ ...item, retrievalMetadata: { ...item.retrievalMetadata, rrfScore: score } }))
}

function deduplicateEvidence(items: RpaPlanningEvidence[]): RpaPlanningEvidence[] {
  const selected: RpaPlanningEvidence[] = []
  for (const item of items) {
    const duplicate = selected.find(
      (candidate) => candidate.contentHash === item.contentHash || similarity(candidate.content, item.content) >= 0.92
    )
    if (!duplicate) {
      selected.push(item)
      continue
    }
    duplicate.contributingSourceIds = uniqueStrings([
      ...duplicate.contributingSourceIds,
      ...item.contributingSourceIds,
      item.sourceId
    ])
  }
  return selected
}

function detectEvidenceConflicts(items: RpaPlanningEvidence[]): string[] {
  const groups = new Map<string, RpaPlanningEvidence[]>()
  for (const item of items) {
    const key = item.locator?.trim().toLowerCase()
    if (!key) continue
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  return [...groups.entries()].flatMap(([locator, group]) => {
    if (group.length < 2 || new Set(group.map((item) => item.contentHash)).size < 2) return []
    return [`Conflicting evidence retained for ${locator}: ${group.map((item) => item.sourceId).join(', ')}`]
  })
}

function applyRerankerOrder(items: RpaPlanningEvidence[], ids: string[]): RpaPlanningEvidence[] {
  const order = new Map(ids.map((id, index) => [id, index]))
  return [...items].sort(
    (left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER)
  )
}

function applyDiversityAndBudget(items: RpaPlanningEvidence[], limit: number, maxChars: number) {
  const sourceCounts = new Map<string, number>()
  const selected: RpaPlanningEvidence[] = []
  let remaining = Math.max(1_000, maxChars)
  for (const item of items) {
    if (selected.length >= limit || remaining <= 0) break
    const sourceKey = `${item.sourceType}:${item.contributingSourceIds[0] ?? item.sourceId}`
    if ((sourceCounts.get(sourceKey) ?? 0) >= Math.max(2, Math.ceil(limit / 2))) continue
    const content = item.content.slice(0, remaining)
    if (!content) continue
    selected.push({ ...item, content })
    sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) ?? 0) + 1)
    remaining -= content.length
  }
  return selected
}

function quoteUntrustedEvidence(content: string): string {
  return `<untrusted-evidence>\n${content}\n</untrusted-evidence>`
}

function hasPromptInjection(content: string): boolean {
  return [
    /ignore\s+(all\s+)?(previous|prior|system)(\s+system)?\s+instructions?/i,
    /override\s+(the\s+)?(system|safety|policy|schema)/i,
    /reveal\s+(the\s+)?(system\s+prompt|hidden\s+instructions?)/i,
    /(忽略|覆盖|绕过).{0,12}(系统|安全|策略|规则|指令)/
  ].some((pattern) => pattern.test(content))
}

function similarity(left: string, right: string): number {
  const leftTokens = tokenize(left)
  const rightTokens = tokenize(right)
  if (!leftTokens.size || !rightTokens.size) return left.trim() === right.trim() ? 1 : 0
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length
  return intersection / new Set([...leftTokens, ...rightTokens]).size
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}_.-]+/u)
      .filter((token) => token.length >= 2)
  )
}

function linkedAbortController(signal?: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  return controller
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException('Retrieval cancelled', 'AbortError')
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
    const abort = () => reject(new DOMException('Retrieval cancelled', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const rpaFederatedRetrievalService = new RpaFederatedRetrievalService()
