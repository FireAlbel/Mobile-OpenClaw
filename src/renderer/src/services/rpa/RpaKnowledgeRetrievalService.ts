import type { RpaKnowledgeCategory, RpaKnowledgeEntry } from './RpaKnowledge'
import { rpaKnowledgeRepository } from './RpaKnowledge'

export interface RpaKnowledgeRetrievalQuery {
  knowledgeBaseIds?: string[]
  appPackage?: string
  taskGoal?: string
  stateId?: string
  errorClass?: string
  categories?: RpaKnowledgeCategory[]
  limit?: number
}

export interface RpaKnowledgeSummary {
  id: string
  category: RpaKnowledgeCategory
  title: string
  summary: string
  confidence: number
  knowledgeBaseId: string
  templateIds: string[]
  skills: Array<{ skillId: string; version?: string }>
}

export interface RpaKnowledgeConflict {
  entryIds: string[]
  reason: string
}

export interface RpaKnowledgeRetrievalResult {
  summaries: RpaKnowledgeSummary[]
  conflicts: RpaKnowledgeConflict[]
  warnings: string[]
}

export interface RpaKnowledgeBaseAvailability {
  knowledgeBaseId: string
  status: 'ready' | 'error'
  totalEntryCount: number
  usableEntryCount: number
  warning?: string
}

export class RpaKnowledgeRetrievalService {
  constructor(private readonly repository = rpaKnowledgeRepository) {}

  async retrieve(query: RpaKnowledgeRetrievalQuery): Promise<RpaKnowledgeRetrievalResult> {
    const entries = (await this.repository.getAll()).filter((entry) => isEligible(entry, query))
    const scored = entries
      .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
      .filter(
        (candidate) =>
          candidate.score > candidate.entry.confidence || isEntryUnscoped(candidate.entry) || isUnscopedQuery(query)
      )
      .sort((left, right) => right.score - left.score || right.entry.updatedAt - left.entry.updatedAt)
    const conflicts = detectConflicts(
      scored.map((candidate) => candidate.entry),
      query
    )
    const conflictedIds = new Set(conflicts.flatMap((conflict) => conflict.entryIds))
    const limit = Math.min(10, Math.max(1, query.limit ?? 6))
    const summaries = scored
      .filter(({ entry }) => !conflictedIds.has(entry.id))
      .slice(0, limit)
      .map(({ entry }) => toSummary(entry))

    return {
      summaries,
      conflicts,
      warnings: conflicts.map((conflict) => conflict.reason)
    }
  }

  async getAvailability(knowledgeBaseIds: string[]): Promise<RpaKnowledgeBaseAvailability[]> {
    const requestedIds = [...new Set(knowledgeBaseIds.map((id) => id.trim()).filter(Boolean))]
    const entries = await this.repository.getAll()
    return requestedIds.map((knowledgeBaseId) => {
      const boundEntries = entries.filter((entry) => entry.knowledgeBaseId === knowledgeBaseId)
      const usableEntryCount = boundEntries.filter(
        (entry) => entry.reviewStatus === 'reviewed' && entry.confidence >= 0.65
      ).length
      return {
        knowledgeBaseId,
        status: usableEntryCount > 0 ? 'ready' : 'error',
        totalEntryCount: boundEntries.length,
        usableEntryCount,
        warning:
          usableEntryCount > 0
            ? undefined
            : 'Knowledge Base has no reviewed RPA entries with confidence at or above 0.65'
      }
    })
  }
}

function isEligible(entry: RpaKnowledgeEntry, query: RpaKnowledgeRetrievalQuery): boolean {
  if (entry.reviewStatus !== 'reviewed' || entry.confidence < 0.65) return false
  if (query.knowledgeBaseIds && !query.knowledgeBaseIds.includes(entry.knowledgeBaseId)) return false
  if (query.categories?.length && !query.categories.includes(entry.category)) return false
  return true
}

function scoreEntry(entry: RpaKnowledgeEntry, query: RpaKnowledgeRetrievalQuery): number {
  let score = entry.confidence
  if (query.appPackage && entry.scope.appPackages.includes(query.appPackage)) score += 5
  if (query.stateId && (entry.scope.stateIds.includes(query.stateId) || entry.links.stateIds.includes(query.stateId))) {
    score += 5
  }
  if (query.errorClass && entry.scope.errorClasses.includes(query.errorClass)) score += 5
  if (query.taskGoal) {
    const queryTokens = tokenize(query.taskGoal)
    const entryTokens = tokenize(`${entry.title} ${entry.summary} ${entry.scope.taskGoals.join(' ')}`)
    score += [...queryTokens].filter((token) => entryTokens.has(token)).length
  }
  return score
}

function detectConflicts(entries: RpaKnowledgeEntry[], query: RpaKnowledgeRetrievalQuery): RpaKnowledgeConflict[] {
  const groups = new Map<string, RpaKnowledgeEntry[]>()
  for (const entry of entries) {
    const key = [entry.category, query.appPackage ?? '', query.stateId ?? '', query.errorClass ?? ''].join('|')
    const group = groups.get(key) ?? []
    group.push(entry)
    groups.set(key, group)
  }

  return [...groups.values()].flatMap((group) => {
    if (group.length < 2) return []
    const summaries = new Set(group.map((entry) => normalizeForConflict(entry.summary || entry.content)))
    if (summaries.size < 2) return []
    return [
      {
        entryIds: group.map((entry) => entry.id),
        reason: `Conflicting reviewed ${group[0].category} entries require user review: ${group
          .map((entry) => entry.title)
          .join(', ')}`
      }
    ]
  })
}

function toSummary(entry: RpaKnowledgeEntry): RpaKnowledgeSummary {
  return {
    id: entry.id,
    category: entry.category,
    title: entry.title,
    summary: (entry.summary || entry.content).slice(0, 800),
    confidence: entry.confidence,
    knowledgeBaseId: entry.knowledgeBaseId,
    templateIds: entry.links.templateIds,
    skills: entry.links.skills
  }
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}_.-]+/u)
      .filter((token) => token.length >= 2)
  )
}

function normalizeForConflict(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function isUnscopedQuery(query: RpaKnowledgeRetrievalQuery): boolean {
  return !query.appPackage && !query.taskGoal && !query.stateId && !query.errorClass
}

function isEntryUnscoped(entry: RpaKnowledgeEntry): boolean {
  return (
    entry.scope.appPackages.length === 0 &&
    entry.scope.taskGoals.length === 0 &&
    entry.scope.stateIds.length === 0 &&
    entry.scope.errorClasses.length === 0
  )
}

export const rpaKnowledgeRetrievalService = new RpaKnowledgeRetrievalService()
