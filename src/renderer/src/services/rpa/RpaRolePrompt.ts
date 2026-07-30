export const RPA_ROLE_PROMPT_KINDS = ['system', 'planner', 'verification', 'recovery', 'capability'] as const

export type RpaRolePromptKind = (typeof RPA_ROLE_PROMPT_KINDS)[number]
export type RpaRolePromptStatus = 'enabled' | 'disabled'

export interface RpaRolePrompt {
  schemaVersion: 1
  id: string
  roleId: string
  version: string
  kind: RpaRolePromptKind
  content: string
  capability?: string
  priority: number
  status: RpaRolePromptStatus
  createdAt: number
  updatedAt: number
}

export interface RpaRolePromptStorage {
  loadRolePrompts(): Promise<RpaRolePrompt[]>
  saveRolePrompts(prompts: RpaRolePrompt[]): Promise<void>
}

export function sanitizeRpaRolePrompt(value: unknown): RpaRolePrompt | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined
  const id = cleanText(value.id, 256)
  const roleId = cleanText(value.roleId, 256)
  const version = cleanText(value.version, 128)
  const content = cleanText(value.content, 50_000)
  const kind = RPA_ROLE_PROMPT_KINDS.includes(value.kind as RpaRolePromptKind)
    ? (value.kind as RpaRolePromptKind)
    : undefined
  if (!id || !roleId || !version || !content || !kind) return undefined
  const createdAt = timestamp(value.createdAt)
  return {
    schemaVersion: 1,
    id,
    roleId,
    version,
    kind,
    content,
    capability: kind === 'capability' ? cleanOptional(value.capability, 256) : undefined,
    priority: boundedNumber(value.priority, -100, 100),
    status: value.status === 'disabled' ? 'disabled' : 'enabled',
    createdAt,
    updatedAt: Math.max(createdAt, timestamp(value.updatedAt))
  }
}

export function sanitizeRpaRolePrompts(value: unknown): RpaRolePrompt[] {
  if (!Array.isArray(value)) return []
  const prompts = new Map<string, RpaRolePrompt>()
  for (const candidate of value) {
    const prompt = sanitizeRpaRolePrompt(candidate)
    if (!prompt) continue
    prompts.set(`${prompt.roleId}:${prompt.id}:${prompt.version}`, prompt)
  }
  return [...prompts.values()].sort(
    (left, right) =>
      right.priority - left.priority || left.roleId.localeCompare(right.roleId) || left.id.localeCompare(right.id)
  )
}

class LocalStorageRpaRolePromptStorage implements RpaRolePromptStorage {
  private readonly storageKey = 'rpa_role_prompts'

  async loadRolePrompts(): Promise<RpaRolePrompt[]> {
    if (typeof localStorage === 'undefined') return []
    try {
      const stored = localStorage.getItem(this.storageKey)
      return stored ? sanitizeRpaRolePrompts(JSON.parse(stored)) : []
    } catch (error) {
      logger.warn('Failed to load local RPA Role prompts', { error })
      return []
    }
  }

  async saveRolePrompts(prompts: RpaRolePrompt[]): Promise<void> {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(this.storageKey, JSON.stringify(sanitizeRpaRolePrompts(prompts)))
  }
}

class IpcRpaRolePromptStorage implements RpaRolePromptStorage {
  constructor(private readonly fallback: RpaRolePromptStorage = new LocalStorageRpaRolePromptStorage()) {}

  async loadRolePrompts(): Promise<RpaRolePrompt[]> {
    if (!window.api?.rpa?.loadRolePrompts) return this.fallback.loadRolePrompts()
    try {
      return sanitizeRpaRolePrompts(await window.api.rpa.loadRolePrompts())
    } catch (error) {
      logger.warn('Failed to load RPA Role prompts through IPC', { error })
      return this.fallback.loadRolePrompts()
    }
  }

  async saveRolePrompts(prompts: RpaRolePrompt[]): Promise<void> {
    const sanitized = sanitizeRpaRolePrompts(prompts)
    if (!window.api?.rpa?.saveRolePrompts) return this.fallback.saveRolePrompts(sanitized)
    try {
      await window.api.rpa.saveRolePrompts(sanitized)
    } catch (error) {
      logger.warn('Failed to save RPA Role prompts through IPC', { error })
      await this.fallback.saveRolePrompts(sanitized)
    }
  }
}

export class RpaRolePromptRepository {
  private writeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: RpaRolePromptStorage = new IpcRpaRolePromptStorage(),
    private readonly now: () => number = Date.now
  ) {}

  async getAll(): Promise<RpaRolePrompt[]> {
    await this.writeQueue
    return sanitizeRpaRolePrompts(await this.storage.loadRolePrompts())
  }

  async getByRoleId(roleId: string): Promise<RpaRolePrompt[]> {
    const normalized = roleId.trim()
    return (await this.getAll()).filter((prompt) => prompt.roleId === normalized)
  }

  async save(prompt: RpaRolePrompt): Promise<RpaRolePrompt> {
    const input = sanitizeRpaRolePrompt(prompt)
    if (!input) throw new Error('Invalid RPA Role prompt')
    return this.enqueue(async () => {
      const prompts = await this.storage.loadRolePrompts()
      const previousVersions = prompts.filter(
        (candidate) => candidate.roleId === input.roleId && candidate.id === input.id
      )
      const saved = sanitizeRpaRolePrompt({
        ...input,
        version: nextPromptVersion(previousVersions, input.version),
        createdAt: previousVersions[0]?.createdAt ?? input.createdAt ?? this.now(),
        updatedAt: this.now()
      })!
      await this.storage.saveRolePrompts([
        saved,
        ...prompts.filter(
          (candidate) =>
            candidate.roleId !== saved.roleId || candidate.id !== saved.id || candidate.version !== saved.version
        )
      ])
      return saved
    })
  }

  async remove(roleId: string, promptId: string, version?: string): Promise<boolean> {
    return this.enqueue(async () => {
      const prompts = await this.storage.loadRolePrompts()
      const next = prompts.filter(
        (prompt) =>
          prompt.roleId !== roleId || prompt.id !== promptId || (version !== undefined && prompt.version !== version)
      )
      if (next.length === prompts.length) return false
      await this.storage.saveRolePrompts(next)
      return true
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

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function cleanOptional(value: unknown, maxLength: number): string | undefined {
  const text = cleanText(value, maxLength)
  return text || undefined
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : 0
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function nextPromptVersion(existing: RpaRolePrompt[], requested: string): string {
  if (!existing.length) return requested || '1'
  const numeric = existing.map((prompt) => Number(prompt.version)).filter(Number.isFinite)
  return numeric.length === existing.length ? String(Math.max(...numeric) + 1) : requested
}

export const rpaRolePromptRepository = new RpaRolePromptRepository()
import { loggerService } from '@logger'

const logger = loggerService.withContext('RpaRolePrompt')
