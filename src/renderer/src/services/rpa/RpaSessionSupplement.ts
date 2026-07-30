import { loggerService } from '@logger'

import type { RpaRoleVersionReference } from './RpaAppRole'

const logger = loggerService.withContext('RpaSessionSupplement')

export const RPA_SESSION_SUPPLEMENT_SOURCE_TYPES = [
  'knowledge',
  'artifact',
  'temporary_index',
  'approved_url',
  'retrieval_provider',
  'artifact_provider',
  'tool_selection'
] as const

export const RPA_SESSION_SUPPLEMENT_LIFECYCLE_STATES = [
  'pending',
  'ready',
  'degraded',
  'blocked',
  'removed',
  'expired',
  'retained',
  'promotion_proposed',
  'promoted'
] as const

export type RpaSessionSupplementSourceType = (typeof RPA_SESSION_SUPPLEMENT_SOURCE_TYPES)[number]
export type RpaSessionSupplementLifecycle = (typeof RPA_SESSION_SUPPLEMENT_LIFECYCLE_STATES)[number]
export type RpaSessionSupplementScope = 'request' | 'session'
export type RpaSessionSupplementRequirement = 'required' | 'optional'

export interface RpaSessionSupplementRetention {
  mode: 'request_chain' | 'session' | 'until' | 'manual'
  expiresAt?: number
}

export interface RpaSessionSupplementTrust {
  classification: 'untrusted' | 'role_authorized'
  reviewed: boolean
  authority?: string
}

export interface RpaSessionSupplementProvenance {
  actor: 'user' | 'system' | 'migration'
  requestId?: string
  reason?: string
  at: number
}

export interface RpaSessionSupplementBinding {
  id: string
  sessionId: string
  sourceType: RpaSessionSupplementSourceType
  sourceId: string
  sourceVersion?: string
  contentHash?: string
  sourceUri?: string
  credentialRef?: string
  toolNames: string[]
  scope: RpaSessionSupplementScope
  requestId?: string
  requirement: RpaSessionSupplementRequirement
  lifecycle: RpaSessionSupplementLifecycle
  trust: RpaSessionSupplementTrust
  retention: RpaSessionSupplementRetention
  created: RpaSessionSupplementProvenance
  removed?: RpaSessionSupplementProvenance
  updatedAt: number
}

export interface RpaSessionSupplementAuditEvent {
  id: string
  bindingId: string
  type: 'bound' | 'lifecycle_changed' | 'removed' | 'expired'
  from?: RpaSessionSupplementLifecycle
  to: RpaSessionSupplementLifecycle
  provenance: RpaSessionSupplementProvenance
}

export interface RpaSessionSupplements {
  schemaVersion: 1
  sessionId: string
  role: RpaRoleVersionReference
  supplementRevision: number
  bindings: RpaSessionSupplementBinding[]
  auditEvents: RpaSessionSupplementAuditEvent[]
  createdAt: number
  updatedAt: number
}

export interface RpaSessionSupplementStorage {
  loadRecords(): Promise<RpaSessionSupplements[]>
  saveRecords(records: RpaSessionSupplements[]): Promise<void>
}

export interface RpaSessionSupplementAuthorization {
  role: RpaRoleVersionReference
  workspaceProviderIds?: string[]
  toolAllowlist?: Record<string, string[]>
}

export interface BindRpaSessionSupplementInput {
  sessionId: string
  sourceType: RpaSessionSupplementSourceType
  sourceId: string
  sourceVersion?: string
  contentHash?: string
  sourceUri?: string
  credentialRef?: string
  toolNames?: string[]
  scope: RpaSessionSupplementScope
  requestId?: string
  requirement?: RpaSessionSupplementRequirement
  lifecycle?: RpaSessionSupplementLifecycle
  trust?: Partial<RpaSessionSupplementTrust>
  retention?: Partial<RpaSessionSupplementRetention>
  actor?: RpaSessionSupplementProvenance['actor']
  reason?: string
}

class LocalStorageRpaSessionSupplementStorage implements RpaSessionSupplementStorage {
  private readonly key = 'rpa_session_supplements'

  async loadRecords(): Promise<RpaSessionSupplements[]> {
    if (typeof localStorage === 'undefined') return []
    try {
      const raw = localStorage.getItem(this.key)
      return raw ? sanitizeRpaSessionSupplementRecords(JSON.parse(raw)) : []
    } catch (error) {
      logger.warn('Failed to load local RPA Session Supplements', { error })
      return []
    }
  }

  async saveRecords(records: RpaSessionSupplements[]): Promise<void> {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(this.key, JSON.stringify(sanitizeRpaSessionSupplementRecords(records)))
    }
  }
}

class IpcRpaSessionSupplementStorage implements RpaSessionSupplementStorage {
  constructor(private readonly fallback: RpaSessionSupplementStorage = new LocalStorageRpaSessionSupplementStorage()) {}

  async loadRecords(): Promise<RpaSessionSupplements[]> {
    if (!window.api?.rpa?.loadSessionSupplements) return this.fallback.loadRecords()
    try {
      return sanitizeRpaSessionSupplementRecords(await window.api.rpa.loadSessionSupplements())
    } catch (error) {
      logger.warn('Failed to load RPA Session Supplements through IPC', { error })
      return this.fallback.loadRecords()
    }
  }

  async saveRecords(records: RpaSessionSupplements[]): Promise<void> {
    const sanitized = sanitizeRpaSessionSupplementRecords(records)
    if (!window.api?.rpa?.saveSessionSupplements) return this.fallback.saveRecords(sanitized)
    try {
      await window.api.rpa.saveSessionSupplements(sanitized)
    } catch (error) {
      logger.warn('Failed to save RPA Session Supplements through IPC', { error })
      await this.fallback.saveRecords(sanitized)
    }
  }
}

export class RpaSessionSupplementRepository {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: RpaSessionSupplementStorage = new IpcRpaSessionSupplementStorage(),
    private readonly now: () => number = Date.now
  ) {}

  async getAll(): Promise<RpaSessionSupplements[]> {
    await this.writeQueue
    return sanitizeRpaSessionSupplementRecords(await this.storage.loadRecords())
  }

  async getBySessionId(sessionId: string): Promise<RpaSessionSupplements | undefined> {
    const id = requireText(sessionId, 'sessionId')
    return (await this.getAll()).find((record) => record.sessionId === id)
  }

  async initialize(sessionId: string, role: RpaRoleVersionReference): Promise<RpaSessionSupplements> {
    const id = requireText(sessionId, 'sessionId')
    const normalizedRole = sanitizeRole(role)
    if (!normalizedRole) throw new Error('A valid immutable Role version is required')
    return this.enqueue(async () => {
      const records = sanitizeRpaSessionSupplementRecords(await this.storage.loadRecords())
      const existing = records.find((record) => record.sessionId === id)
      if (existing) {
        assertSameRole(existing.role, normalizedRole)
        return existing
      }
      const now = this.now()
      const record: RpaSessionSupplements = {
        schemaVersion: 1,
        sessionId: id,
        role: normalizedRole,
        supplementRevision: 0,
        bindings: [],
        auditEvents: [],
        createdAt: now,
        updatedAt: now
      }
      await this.storage.saveRecords([record, ...records])
      return record
    })
  }

  async update(
    sessionId: string,
    expectedRevision: number,
    updater: (record: RpaSessionSupplements) => RpaSessionSupplements
  ): Promise<RpaSessionSupplements> {
    const id = requireText(sessionId, 'sessionId')
    return this.enqueue(async () => {
      const records = sanitizeRpaSessionSupplementRecords(await this.storage.loadRecords())
      const existing = records.find((record) => record.sessionId === id)
      if (!existing) throw new Error(`RPA Session Supplements not found: ${id}`)
      if (existing.supplementRevision !== expectedRevision) {
        throw new Error(
          `RPA Session Supplement revision conflict: expected ${expectedRevision}, current ${existing.supplementRevision}`
        )
      }
      const candidate = sanitizeRpaSessionSupplements({
        ...updater(structuredClone(existing)),
        sessionId: existing.sessionId,
        role: existing.role,
        supplementRevision: existing.supplementRevision + 1,
        createdAt: existing.createdAt,
        updatedAt: this.now()
      })
      if (!candidate) throw new Error('Invalid RPA Session Supplement update')
      assertSameRole(candidate.role, existing.role)
      await this.storage.saveRecords([candidate, ...records.filter((record) => record.sessionId !== id)])
      return candidate
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

export class RpaSessionSupplementService {
  constructor(
    private readonly repository: RpaSessionSupplementRepository = new RpaSessionSupplementRepository(),
    private readonly now: () => number = Date.now
  ) {}

  initialize(sessionId: string, role: RpaRoleVersionReference): Promise<RpaSessionSupplements> {
    return this.repository.initialize(sessionId, role)
  }

  async bind(
    input: BindRpaSessionSupplementInput,
    expectedRevision: number,
    authorization: RpaSessionSupplementAuthorization
  ): Promise<RpaSessionSupplements> {
    const sessionId = requireText(input.sessionId, 'sessionId')
    const record = await this.repository.getBySessionId(sessionId)
    if (!record) throw new Error(`RPA Session Supplements not found: ${sessionId}`)
    assertSameRole(record.role, authorization.role)
    const binding = createBinding(input, authorization, this.now())
    if (binding.sessionId !== record.sessionId) throw new Error('Cross-session Supplement binding is blocked')
    return this.repository.update(sessionId, expectedRevision, (current) => ({
      ...current,
      bindings: [...current.bindings, binding],
      auditEvents: [...current.auditEvents, eventFor(binding, 'bound', undefined, binding.lifecycle)].slice(-500)
    }))
  }

  async transition(
    sessionId: string,
    bindingId: string,
    lifecycle: RpaSessionSupplementLifecycle,
    expectedRevision: number,
    provenance: Omit<RpaSessionSupplementProvenance, 'at'> & { at?: number }
  ): Promise<RpaSessionSupplements> {
    const target = requireText(bindingId, 'bindingId')
    return this.repository.update(sessionId, expectedRevision, (current) => {
      const binding = current.bindings.find((candidate) => candidate.id === target)
      if (!binding) throw new Error(`RPA Session Supplement binding not found: ${target}`)
      assertLifecycleTransition(binding.lifecycle, lifecycle)
      const at = provenance.at ?? this.now()
      const auditProvenance = sanitizeProvenance({ ...provenance, at }, at)
      const updated: RpaSessionSupplementBinding = {
        ...binding,
        lifecycle,
        updatedAt: at,
        removed: lifecycle === 'removed' || lifecycle === 'expired' ? auditProvenance : binding.removed
      }
      const type = lifecycle === 'removed' ? 'removed' : lifecycle === 'expired' ? 'expired' : 'lifecycle_changed'
      return {
        ...current,
        bindings: current.bindings.map((candidate) => (candidate.id === target ? updated : candidate)),
        auditEvents: [
          ...current.auditEvents,
          eventFor(updated, type, binding.lifecycle, lifecycle, auditProvenance)
        ].slice(-500)
      }
    })
  }

  async expireRequestScope(
    sessionId: string,
    requestId: string,
    expectedRevision: number,
    reason: string
  ): Promise<RpaSessionSupplements> {
    const request = requireText(requestId, 'requestId')
    return this.repository.update(sessionId, expectedRevision, (current) => {
      const now = this.now()
      const events: RpaSessionSupplementAuditEvent[] = []
      const bindings = current.bindings.map((binding) => {
        if (
          binding.scope !== 'request' ||
          binding.requestId !== request ||
          ['removed', 'expired', 'promoted'].includes(binding.lifecycle)
        ) {
          return binding
        }
        const provenance = sanitizeProvenance({ actor: 'system', requestId: request, reason, at: now }, now)
        const expired = { ...binding, lifecycle: 'expired' as const, removed: provenance, updatedAt: now }
        events.push(eventFor(expired, 'expired', binding.lifecycle, 'expired', provenance))
        return expired
      })
      return { ...current, bindings, auditEvents: [...current.auditEvents, ...events].slice(-500) }
    })
  }
}

export function sanitizeRpaSessionSupplements(value: unknown): RpaSessionSupplements | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined
  const sessionId = text(value.sessionId, 256)
  const role = sanitizeRole(value.role)
  if (!sessionId || !role) return undefined
  const createdAt = timestamp(value.createdAt)
  const bindings = Array.isArray(value.bindings)
    ? value.bindings.flatMap((candidate) => {
        const binding = sanitizeBinding(candidate, sessionId)
        return binding ? [binding] : []
      })
    : []
  return {
    schemaVersion: 1,
    sessionId,
    role,
    supplementRevision: nonNegativeInteger(value.supplementRevision),
    bindings: uniqueById(bindings),
    auditEvents: Array.isArray(value.auditEvents)
      ? value.auditEvents
          .flatMap((candidate) => {
            const event = sanitizeAuditEvent(candidate)
            return event ? [event] : []
          })
          .slice(-500)
      : [],
    createdAt,
    updatedAt: Math.max(createdAt, timestamp(value.updatedAt))
  }
}

export function sanitizeRpaSessionSupplementRecords(value: unknown): RpaSessionSupplements[] {
  if (!Array.isArray(value)) return []
  const records = new Map<string, RpaSessionSupplements>()
  for (const candidate of value) {
    const record = sanitizeRpaSessionSupplements(candidate)
    const existing = record ? records.get(record.sessionId) : undefined
    if (record && (!existing || existing.supplementRevision < record.supplementRevision)) {
      records.set(record.sessionId, record)
    }
  }
  return [...records.values()].sort((left, right) => right.updatedAt - left.updatedAt)
}

function createBinding(
  input: BindRpaSessionSupplementInput,
  authorization: RpaSessionSupplementAuthorization,
  now: number
): RpaSessionSupplementBinding {
  const sessionId = requireText(input.sessionId, 'sessionId')
  const sourceId = requireText(input.sourceId, 'sourceId')
  if (!RPA_SESSION_SUPPLEMENT_SOURCE_TYPES.includes(input.sourceType)) throw new Error('Unsupported Supplement source')
  const requestId = text(input.requestId, 256) || undefined
  if (input.scope === 'request' && !requestId) throw new Error('Request-scoped Supplements require requestId')
  const sourceUri = input.sourceUri ? sanitizeUri(input.sourceUri) : undefined
  const toolNames = uniqueStrings(input.toolNames)
  authorizeBinding(input.sourceType, sourceId, toolNames, authorization)
  const created = sanitizeProvenance({ actor: input.actor ?? 'user', requestId, reason: input.reason, at: now }, now)
  const retention = sanitizeRetention(input.retention, input.scope)
  return {
    id: `supplement-${now}-${Math.random().toString(36).slice(2, 10)}`,
    sessionId,
    sourceType: input.sourceType,
    sourceId,
    sourceVersion: text(input.sourceVersion, 256) || undefined,
    contentHash: text(input.contentHash, 256) || undefined,
    sourceUri,
    credentialRef: sanitizeCredentialRef(input.credentialRef),
    toolNames,
    scope: input.scope,
    requestId,
    requirement: input.requirement === 'required' ? 'required' : 'optional',
    lifecycle:
      input.lifecycle && RPA_SESSION_SUPPLEMENT_LIFECYCLE_STATES.includes(input.lifecycle)
        ? input.lifecycle
        : 'pending',
    trust: sanitizeTrust(input.trust, input.sourceType),
    retention,
    created,
    updatedAt: now
  }
}

function authorizeBinding(
  sourceType: RpaSessionSupplementSourceType,
  sourceId: string,
  toolNames: string[],
  authorization: RpaSessionSupplementAuthorization
): void {
  if (sourceType === 'retrieval_provider' || sourceType === 'artifact_provider') {
    if (!uniqueStrings(authorization.workspaceProviderIds).includes(sourceId)) {
      throw new Error(`Provider is not trusted by the current workspace: ${sourceId}`)
    }
  }
  if (sourceType === 'tool_selection') {
    if (!toolNames.length) throw new Error('Tool selection requires at least one tool')
    const allowed = new Set(uniqueStrings(authorization.toolAllowlist?.[sourceId]))
    const blocked = toolNames.filter((name) => !allowed.has(name))
    if (blocked.length) throw new Error(`Tools are not authorized by the immutable Role: ${blocked.join(', ')}`)
  }
}

function sanitizeBinding(value: unknown, sessionId: string): RpaSessionSupplementBinding | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id, 256)
  const bindingSessionId = text(value.sessionId, 256)
  const sourceId = text(value.sourceId, 512)
  if (
    !id ||
    bindingSessionId !== sessionId ||
    !sourceId ||
    !RPA_SESSION_SUPPLEMENT_SOURCE_TYPES.includes(value.sourceType as RpaSessionSupplementSourceType)
  )
    return undefined
  const scope = value.scope === 'request' ? 'request' : 'session'
  const requestId = text(value.requestId, 256) || undefined
  if (scope === 'request' && !requestId) return undefined
  const created = sanitizeProvenance(value.created, timestamp(value.updatedAt))
  return {
    id,
    sessionId,
    sourceType: value.sourceType as RpaSessionSupplementSourceType,
    sourceId,
    sourceVersion: text(value.sourceVersion, 256) || undefined,
    contentHash: text(value.contentHash, 256) || undefined,
    sourceUri: value.sourceUri ? sanitizeUri(String(value.sourceUri)) : undefined,
    credentialRef: sanitizeStoredCredentialRef(value.credentialRef),
    toolNames: uniqueStrings(value.toolNames),
    scope,
    requestId,
    requirement: value.requirement === 'required' ? 'required' : 'optional',
    lifecycle: RPA_SESSION_SUPPLEMENT_LIFECYCLE_STATES.includes(value.lifecycle as RpaSessionSupplementLifecycle)
      ? (value.lifecycle as RpaSessionSupplementLifecycle)
      : 'pending',
    trust: sanitizeTrust(value.trust, value.sourceType as RpaSessionSupplementSourceType),
    retention: sanitizeRetention(value.retention, scope),
    created,
    removed: value.removed ? sanitizeProvenance(value.removed, created.at) : undefined,
    updatedAt: Math.max(created.at, timestamp(value.updatedAt))
  }
}

function sanitizeAuditEvent(value: unknown): RpaSessionSupplementAuditEvent | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id, 256)
  const bindingId = text(value.bindingId, 256)
  const type = ['bound', 'lifecycle_changed', 'removed', 'expired'].includes(String(value.type))
    ? (value.type as RpaSessionSupplementAuditEvent['type'])
    : undefined
  const to = RPA_SESSION_SUPPLEMENT_LIFECYCLE_STATES.includes(value.to as RpaSessionSupplementLifecycle)
    ? (value.to as RpaSessionSupplementLifecycle)
    : undefined
  if (!id || !bindingId || !type || !to) return undefined
  return {
    id,
    bindingId,
    type,
    from: RPA_SESSION_SUPPLEMENT_LIFECYCLE_STATES.includes(value.from as RpaSessionSupplementLifecycle)
      ? (value.from as RpaSessionSupplementLifecycle)
      : undefined,
    to,
    provenance: sanitizeProvenance(value.provenance, 0)
  }
}

function eventFor(
  binding: RpaSessionSupplementBinding,
  type: RpaSessionSupplementAuditEvent['type'],
  from: RpaSessionSupplementLifecycle | undefined,
  to: RpaSessionSupplementLifecycle,
  provenance = binding.created
): RpaSessionSupplementAuditEvent {
  return {
    id: `supplement-event-${provenance.at}-${Math.random().toString(36).slice(2, 10)}`,
    bindingId: binding.id,
    type,
    from,
    to,
    provenance
  }
}

const TERMINAL_LIFECYCLES = new Set<RpaSessionSupplementLifecycle>(['removed', 'expired', 'promoted'])

function assertLifecycleTransition(from: RpaSessionSupplementLifecycle, to: RpaSessionSupplementLifecycle): void {
  if (from === to) return
  if (TERMINAL_LIFECYCLES.has(from)) throw new Error(`Supplement lifecycle ${from} is terminal`)
  if (to === 'pending') throw new Error('Supplement lifecycle cannot transition back to pending')
}

function sanitizeRole(value: unknown): RpaRoleVersionReference | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id, 256)
  const version = Math.floor(Number(value.version))
  return id && version > 0 ? { id, version } : undefined
}

function assertSameRole(left: RpaRoleVersionReference, right: RpaRoleVersionReference): void {
  if (left.id !== right.id || left.version !== right.version) {
    throw new Error('Session Supplement Role does not match the immutable Session Role')
  }
}

function sanitizeTrust(value: unknown, sourceType: RpaSessionSupplementSourceType): RpaSessionSupplementTrust {
  const candidate = isRecord(value) ? value : {}
  return {
    classification:
      sourceType === 'tool_selection' && candidate.classification === 'role_authorized'
        ? 'role_authorized'
        : 'untrusted',
    reviewed: candidate.reviewed === true,
    authority: text(candidate.authority, 256) || undefined
  }
}

function sanitizeRetention(value: unknown, scope: RpaSessionSupplementScope): RpaSessionSupplementRetention {
  const candidate = isRecord(value) ? value : {}
  const mode = ['request_chain', 'session', 'until', 'manual'].includes(String(candidate.mode))
    ? (candidate.mode as RpaSessionSupplementRetention['mode'])
    : scope === 'request'
      ? 'request_chain'
      : 'session'
  const expiresAt = mode === 'until' ? timestamp(candidate.expiresAt) : undefined
  if (mode === 'until' && !expiresAt) throw new Error('Until retention requires expiresAt')
  return { mode, expiresAt }
}

function sanitizeProvenance(value: unknown, fallbackAt: number): RpaSessionSupplementProvenance {
  const candidate = isRecord(value) ? value : {}
  return {
    actor: ['user', 'system', 'migration'].includes(String(candidate.actor))
      ? (candidate.actor as RpaSessionSupplementProvenance['actor'])
      : 'system',
    requestId: text(candidate.requestId, 256) || undefined,
    reason: text(candidate.reason, 2_000) || undefined,
    at: timestamp(candidate.at) || fallbackAt
  }
}

function sanitizeUri(raw: string): string {
  const url = new URL(raw)
  if (!['https:', 'http:', 'mcp:'].includes(url.protocol)) throw new Error('Supplement URL protocol is not supported')
  if (url.username || url.password) throw new Error('Credentials in Supplement URLs are blocked')
  url.hash = ''
  return url.toString()
}

function sanitizeCredentialRef(value: unknown): string | undefined {
  const reference = text(value, 256)
  if (!reference) return undefined
  if (!/^(?:credential|keychain|provider|vault):\/\/[A-Za-z0-9._:/-]+$/.test(reference)) {
    throw new Error('Supplement credentials must use a credential reference')
  }
  return reference
}

function sanitizeStoredCredentialRef(value: unknown): string | undefined {
  try {
    return sanitizeCredentialRef(value)
  } catch {
    return undefined
  }
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()]
}

function uniqueStrings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map((item) => text(item, 512)).filter(Boolean))] : []
}

function requireText(value: unknown, field: string): string {
  const normalized = text(value, 512)
  if (!normalized) throw new Error(`RPA Session Supplement ${field} is required`)
  return normalized
}

function text(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function timestamp(value: unknown): number {
  const normalized = Math.floor(Number(value))
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : 0
}

function nonNegativeInteger(value: unknown): number {
  return Math.max(0, Math.floor(Number(value) || 0))
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const rpaSessionSupplementRepository = new RpaSessionSupplementRepository()
export const rpaSessionSupplementService = new RpaSessionSupplementService(rpaSessionSupplementRepository)
