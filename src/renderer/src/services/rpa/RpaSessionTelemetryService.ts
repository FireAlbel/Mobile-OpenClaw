import { loggerService } from '@logger'

const logger = loggerService.withContext('RpaSessionTelemetryService')

export type RpaSessionTelemetryEventType =
  | 'compatibility_routing'
  | 'cutover_routing'
  | 'rollback_routing'
  | 'generic_fallback_attempt'
  | 'stale_revision'
  | 'clarification_loop'
  | 'non_executable_result'
  | 'successful_dsl_revision'
  | 'supplement_extraction_failure'
  | 'supplement_source_degradation'
  | 'supplement_reranker_fallback'
  | 'supplement_conflict'
  | 'supplement_injection_attempt'
  | 'supplement_truncation'
  | 'supplement_redaction'
  | 'supplement_permission_block'
  | 'supplement_stale_result'
  | 'supplement_replay_degradation'
  | 'supplement_promotion_outcome'

export interface RpaSessionTelemetryEvent {
  type: RpaSessionTelemetryEventType
  createdAt: number
  sessionId?: string
  requestId?: string
  reason?: string
}

export interface RpaSessionTelemetrySnapshot {
  schemaVersion: 1
  counters: Record<RpaSessionTelemetryEventType, number>
  recentEvents: RpaSessionTelemetryEvent[]
  updatedAt: number
}

export interface RpaSessionTelemetryStorage {
  load(): RpaSessionTelemetrySnapshot | undefined
  save(snapshot: RpaSessionTelemetrySnapshot): void
}

class LocalStorageRpaSessionTelemetryStorage implements RpaSessionTelemetryStorage {
  private readonly key = 'rpa_session_telemetry_v1'

  load(): RpaSessionTelemetrySnapshot | undefined {
    if (typeof localStorage === 'undefined') return undefined
    try {
      const value = localStorage.getItem(this.key)
      return value ? sanitizeSnapshot(JSON.parse(value)) : undefined
    } catch (error) {
      logger.warn('Failed to load RPA session telemetry', { error })
      return undefined
    }
  }

  save(snapshot: RpaSessionTelemetrySnapshot): void {
    if (typeof localStorage === 'undefined') return
    try {
      localStorage.setItem(this.key, JSON.stringify(snapshot))
    } catch (error) {
      logger.warn('Failed to save RPA session telemetry', { error })
    }
  }
}

const EVENT_TYPES: RpaSessionTelemetryEventType[] = [
  'compatibility_routing',
  'cutover_routing',
  'rollback_routing',
  'generic_fallback_attempt',
  'stale_revision',
  'clarification_loop',
  'non_executable_result',
  'successful_dsl_revision',
  'supplement_extraction_failure',
  'supplement_source_degradation',
  'supplement_reranker_fallback',
  'supplement_conflict',
  'supplement_injection_attempt',
  'supplement_truncation',
  'supplement_redaction',
  'supplement_permission_block',
  'supplement_stale_result',
  'supplement_replay_degradation',
  'supplement_promotion_outcome'
]

export class RpaSessionTelemetryService {
  constructor(
    private readonly storage: RpaSessionTelemetryStorage = new LocalStorageRpaSessionTelemetryStorage(),
    private readonly now: () => number = Date.now,
    private readonly eventLimit = 100
  ) {}

  getSnapshot(): RpaSessionTelemetrySnapshot {
    return this.storage.load() ?? emptySnapshot(this.now())
  }

  record(type: RpaSessionTelemetryEventType, context: Omit<RpaSessionTelemetryEvent, 'type' | 'createdAt'> = {}): void {
    const current = this.getSnapshot()
    const createdAt = this.now()
    const event: RpaSessionTelemetryEvent = {
      type,
      createdAt,
      sessionId: boundedText(context.sessionId, 256),
      requestId: boundedText(context.requestId, 256),
      reason: boundedText(context.reason, 1_000)
    }
    this.storage.save({
      schemaVersion: 1,
      counters: { ...current.counters, [type]: Math.min(Number.MAX_SAFE_INTEGER, current.counters[type] + 1) },
      recentEvents: [...current.recentEvents, event].slice(-Math.max(1, this.eventLimit)),
      updatedAt: createdAt
    })
  }
}

function emptyCounters(): Record<RpaSessionTelemetryEventType, number> {
  return Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])) as Record<RpaSessionTelemetryEventType, number>
}

function emptySnapshot(now: number): RpaSessionTelemetrySnapshot {
  return { schemaVersion: 1, counters: emptyCounters(), recentEvents: [], updatedAt: now }
}

function sanitizeSnapshot(value: unknown): RpaSessionTelemetrySnapshot | undefined {
  if (!value || typeof value !== 'object' || (value as { schemaVersion?: unknown }).schemaVersion !== 1)
    return undefined
  const candidate = value as Partial<RpaSessionTelemetrySnapshot>
  const counters = emptyCounters()
  for (const type of EVENT_TYPES) {
    const count = Number(candidate.counters?.[type])
    counters[type] = Number.isSafeInteger(count) && count >= 0 ? count : 0
  }
  const recentEvents = Array.isArray(candidate.recentEvents)
    ? candidate.recentEvents
        .map(sanitizeEvent)
        .filter((event): event is RpaSessionTelemetryEvent => Boolean(event))
        .slice(-100)
    : []
  return {
    schemaVersion: 1,
    counters,
    recentEvents,
    updatedAt: finiteTime(candidate.updatedAt)
  }
}

function sanitizeEvent(value: unknown): RpaSessionTelemetryEvent | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<RpaSessionTelemetryEvent>
  if (!EVENT_TYPES.includes(candidate.type as RpaSessionTelemetryEventType)) return undefined
  return {
    type: candidate.type as RpaSessionTelemetryEventType,
    createdAt: finiteTime(candidate.createdAt),
    sessionId: boundedText(candidate.sessionId, 256),
    requestId: boundedText(candidate.requestId, 256),
    reason: boundedText(candidate.reason, 1_000)
  }
}

function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().slice(0, limit)
  return normalized || undefined
}

function finiteTime(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

export const rpaSessionTelemetryService = new RpaSessionTelemetryService()
