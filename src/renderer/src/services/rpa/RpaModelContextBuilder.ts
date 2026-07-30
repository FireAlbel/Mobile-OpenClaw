import type { RpaModelReference } from './RpaAssistantProfile'
import type { RpaKnowledgeRetrievalResult } from './RpaKnowledgeRetrievalService'
import type { RpaRolePrompt } from './RpaRolePrompt'

const SECRET_VALUE = /(bearer\s+)[a-z0-9._~+/-]+=*|\bsk-[a-z0-9_-]{12,}\b/gi
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|system)(\s+system)?\s+instructions?/i,
  /override\s+(the\s+)?(system|safety|policy|schema)/i,
  /reveal\s+(the\s+)?(system\s+prompt|hidden\s+instructions?)/i,
  /忽略.{0,8}(之前|以上|系统).{0,8}(指令|提示词)/,
  /(覆盖|绕过|取消).{0,8}(安全|策略|规则|限制)/
]

export type RpaModelCallType = 'planner' | 'verification' | 'recovery'
export type RpaModelContextSourceType =
  | 'role_prompt'
  | 'local_knowledge'
  | 'remote_knowledge'
  | 'observation'
  | 'execution_history'
  | 'clarification'

export interface RpaModelContextBudgets {
  rolePrompts: number
  localKnowledge: number
  remoteKnowledge: number
  observations: number
  executionHistory: number
  clarifications: number
}

export interface RpaModelContextSourceProvenance {
  sourceType: RpaModelContextSourceType
  sourceId: string
  version?: string
  roleId?: string
  originalChars: number
  includedChars: number
  truncated: boolean
  redacted: boolean
  trust: 'trusted_role_prompt' | 'untrusted_data'
}

export interface RpaModelContextConflict {
  code: 'prompt_injection_detected' | 'prompt_precedence_conflict'
  sourceType: RpaModelContextSourceType
  sourceId: string
  message: string
}

export interface RpaModelContextProvenance {
  schemaVersion: 1
  callType: RpaModelCallType
  builtAt: number
  model?: RpaModelReference
  budgets: RpaModelContextBudgets
  sources: RpaModelContextSourceProvenance[]
  conflicts: RpaModelContextConflict[]
  truncated: boolean
  redacted: boolean
}

export interface RpaEmbeddedRolePrompt {
  id: string
  roleId: string
  version: string
  kind: RpaRolePrompt['kind']
  capability?: string
  priority: number
  content: string
}

export interface RpaEmbeddedModelContext {
  schemaVersion: 1
  systemCapabilities: string[]
  rolePrompts: RpaEmbeddedRolePrompt[]
  provenance: RpaModelContextProvenance
}

export interface RpaBoundedEvidence {
  sourceType: Exclude<RpaModelContextSourceType, 'role_prompt'>
  sourceId: string
  trust: 'untrusted_data'
  content: string
}

export interface RpaBoundedModelContext {
  roleInstructions: string[]
  systemCapabilities: string[]
  rolePrompts: RpaEmbeddedRolePrompt[]
  embeddedRolePrompts: RpaEmbeddedRolePrompt[]
  evidence: RpaBoundedEvidence[]
  provenance: RpaModelContextProvenance
}

export interface RpaModelContextBuilderInput {
  callType: RpaModelCallType
  rolePrompts?: RpaRolePrompt[] | RpaEmbeddedRolePrompt[]
  systemCapabilities?: string[]
  knowledgeContext?: RpaKnowledgeRetrievalResult
  remoteKnowledge?: unknown[]
  observations?: unknown[]
  executionHistory?: unknown[]
  clarificationAnswers?: unknown[]
  model?: RpaModelReference
  budgets?: Partial<RpaModelContextBudgets>
  now?: () => number
}

export const DEFAULT_RPA_MODEL_CONTEXT_BUDGETS: RpaModelContextBudgets = {
  rolePrompts: 6_000,
  localKnowledge: 8_000,
  remoteKnowledge: 4_000,
  observations: 8_000,
  executionHistory: 5_000,
  clarifications: 2_000
}

export function buildRpaModelContext(input: RpaModelContextBuilderInput): RpaBoundedModelContext {
  const budgets = sanitizeBudgets(input.budgets)
  const sources: RpaModelContextSourceProvenance[] = []
  const conflicts: RpaModelContextConflict[] = []
  const selectedPrompts = selectPrompts(input.rolePrompts ?? [], input.callType, input.systemCapabilities ?? [])
  const rolePrompts = boundRolePrompts(selectedPrompts, budgets.rolePrompts, sources, conflicts)
  const embeddedRolePrompts = boundRolePrompts(
    (input.rolePrompts ?? []).filter((prompt) => !('status' in prompt) || prompt.status === 'enabled'),
    budgets.rolePrompts,
    [],
    []
  )
  const evidence = [
    ...boundValues(
      'local_knowledge',
      input.knowledgeContext?.summaries ?? [],
      budgets.localKnowledge,
      sources,
      conflicts
    ),
    ...boundValues('remote_knowledge', input.remoteKnowledge ?? [], budgets.remoteKnowledge, sources, conflicts),
    ...boundValues('observation', input.observations ?? [], budgets.observations, sources, conflicts),
    ...boundValues('execution_history', input.executionHistory ?? [], budgets.executionHistory, sources, conflicts),
    ...boundValues('clarification', input.clarificationAnswers ?? [], budgets.clarifications, sources, conflicts)
  ]
  const provenance: RpaModelContextProvenance = {
    schemaVersion: 1,
    callType: input.callType,
    builtAt: input.now?.() ?? Date.now(),
    model: input.model ? { ...input.model } : undefined,
    budgets,
    sources,
    conflicts,
    truncated: sources.some((source) => source.truncated),
    redacted: sources.some((source) => source.redacted)
  }
  return {
    roleInstructions: rolePrompts.map((prompt) => prompt.content),
    systemCapabilities: uniqueStrings(input.systemCapabilities ?? []),
    rolePrompts,
    embeddedRolePrompts,
    evidence,
    provenance
  }
}

export function createEmbeddedRpaModelContext(context: RpaBoundedModelContext): RpaEmbeddedModelContext {
  return {
    schemaVersion: 1,
    systemCapabilities: [...context.systemCapabilities],
    rolePrompts: context.embeddedRolePrompts.map((prompt) => ({ ...prompt })),
    provenance: structuredClone(context.provenance)
  }
}

export function readEmbeddedRpaModelContext(value: unknown): RpaEmbeddedModelContext | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.rolePrompts) ||
    !isRecord(value.provenance)
  ) {
    return undefined
  }
  const rolePrompts = value.rolePrompts.flatMap((candidate) => {
    if (!isRecord(candidate)) return []
    const id = cleanText(candidate.id, 256)
    const roleId = cleanText(candidate.roleId, 256)
    const version = cleanText(candidate.version, 128)
    const content = cleanText(candidate.content, DEFAULT_RPA_MODEL_CONTEXT_BUDGETS.rolePrompts)
    const kind = candidate.kind
    if (
      !id ||
      !roleId ||
      !version ||
      !content ||
      !['system', 'planner', 'verification', 'recovery', 'capability'].includes(String(kind))
    )
      return []
    return [
      {
        id,
        roleId,
        version,
        kind: kind as RpaRolePrompt['kind'],
        capability: cleanOptional(candidate.capability, 256),
        priority: boundedNumber(candidate.priority, -100, 100),
        content
      }
    ]
  })
  return {
    schemaVersion: 1,
    systemCapabilities: uniqueStrings(Array.isArray(value.systemCapabilities) ? value.systemCapabilities : []),
    rolePrompts,
    provenance: sanitizeRpaModelContextProvenance(value.provenance)
  }
}

export function sanitizeRpaModelContextProvenance(value: unknown): RpaModelContextProvenance {
  const source = isRecord(value) ? value : {}
  const callType = ['planner', 'verification', 'recovery'].includes(String(source.callType))
    ? (source.callType as RpaModelCallType)
    : 'planner'
  const model = isRecord(source.model)
    ? {
        providerId: cleanText(source.model.providerId, 256),
        modelId: cleanText(source.model.modelId, 256)
      }
    : undefined
  const sources = Array.isArray(source.sources)
    ? source.sources.flatMap((candidate) => {
        if (!isRecord(candidate)) return []
        const sourceType = String(candidate.sourceType) as RpaModelContextSourceType
        const sourceId = cleanText(candidate.sourceId, 256)
        if (
          !sourceId ||
          ![
            'role_prompt',
            'local_knowledge',
            'remote_knowledge',
            'observation',
            'execution_history',
            'clarification'
          ].includes(sourceType)
        )
          return []
        return [
          {
            sourceType,
            sourceId,
            version: cleanOptional(candidate.version, 128),
            roleId: cleanOptional(candidate.roleId, 256),
            originalChars: nonNegativeInteger(candidate.originalChars),
            includedChars: nonNegativeInteger(candidate.includedChars),
            truncated: candidate.truncated === true,
            redacted: candidate.redacted === true,
            trust:
              candidate.trust === 'trusted_role_prompt' ? ('trusted_role_prompt' as const) : ('untrusted_data' as const)
          }
        ]
      })
    : []
  const conflicts = Array.isArray(source.conflicts)
    ? source.conflicts.flatMap((candidate) => {
        if (!isRecord(candidate)) return []
        const code = candidate.code
        const sourceType = String(candidate.sourceType) as RpaModelContextSourceType
        const sourceId = cleanText(candidate.sourceId, 256)
        const message = cleanText(candidate.message, 1_000)
        if (
          !sourceId ||
          !message ||
          !['prompt_injection_detected', 'prompt_precedence_conflict'].includes(String(code))
        )
          return []
        return [{ code: code as RpaModelContextConflict['code'], sourceType, sourceId, message }]
      })
    : []
  return {
    schemaVersion: 1,
    callType,
    builtAt: nonNegativeInteger(source.builtAt),
    model: model?.providerId && model.modelId ? model : undefined,
    budgets: sanitizeBudgets(isRecord(source.budgets) ? source.budgets : undefined),
    sources,
    conflicts,
    truncated: source.truncated === true,
    redacted: source.redacted === true
  }
}

function selectPrompts(
  prompts: Array<RpaRolePrompt | RpaEmbeddedRolePrompt>,
  callType: RpaModelCallType,
  capabilities: string[]
): Array<RpaRolePrompt | RpaEmbeddedRolePrompt> {
  const capabilitySet = new Set(capabilities)
  return prompts
    .filter((prompt) => !('status' in prompt) || prompt.status === 'enabled')
    .filter(
      (prompt) =>
        prompt.kind === 'system' ||
        prompt.kind === callType ||
        (prompt.kind === 'capability' && Boolean(prompt.capability && capabilitySet.has(prompt.capability)))
    )
    .sort(
      (left, right) =>
        right.priority - left.priority ||
        promptKindRank(left.kind, callType) - promptKindRank(right.kind, callType) ||
        left.roleId.localeCompare(right.roleId) ||
        left.id.localeCompare(right.id)
    )
}

function promptKindRank(kind: RpaRolePrompt['kind'], callType: RpaModelCallType): number {
  if (kind === 'system') return 0
  if (kind === callType) return 1
  return 2
}

function boundRolePrompts(
  prompts: Array<RpaRolePrompt | RpaEmbeddedRolePrompt>,
  budget: number,
  sources: RpaModelContextSourceProvenance[],
  conflicts: RpaModelContextConflict[]
): RpaEmbeddedRolePrompt[] {
  let remaining = budget
  const result: RpaEmbeddedRolePrompt[] = []
  const kinds = new Map<string, string>()
  for (const prompt of prompts) {
    if (remaining <= 0) break
    const bounded = boundText(prompt.content, remaining)
    remaining -= bounded.text.length
    recordSource(sources, conflicts, 'role_prompt', prompt.id, bounded, {
      roleId: prompt.roleId,
      version: prompt.version,
      trust: 'trusted_role_prompt'
    })
    const conflictKey = `${prompt.kind}:${prompt.capability ?? ''}`
    const current = kinds.get(conflictKey)
    if (current && current !== bounded.text) {
      conflicts.push({
        code: 'prompt_precedence_conflict',
        sourceType: 'role_prompt',
        sourceId: prompt.id,
        message: `Multiple Role prompts target ${conflictKey}; priority order was applied`
      })
    }
    kinds.set(conflictKey, bounded.text)
    result.push({
      id: prompt.id,
      roleId: prompt.roleId,
      version: prompt.version,
      kind: prompt.kind,
      capability: prompt.capability,
      priority: prompt.priority,
      content: bounded.text
    })
  }
  return result
}

function boundValues(
  sourceType: RpaBoundedEvidence['sourceType'],
  values: unknown[],
  budget: number,
  sources: RpaModelContextSourceProvenance[],
  conflicts: RpaModelContextConflict[]
): RpaBoundedEvidence[] {
  let remaining = budget
  const evidence: RpaBoundedEvidence[] = []
  for (let index = 0; index < values.length && remaining > 0; index += 1) {
    const sourceId = readSourceId(values[index]) ?? `${sourceType}-${index + 1}`
    const bounded = boundText(safeStringify(values[index]), remaining)
    remaining -= bounded.text.length
    recordSource(sources, conflicts, sourceType, sourceId, bounded, { trust: 'untrusted_data' })
    evidence.push({ sourceType, sourceId, trust: 'untrusted_data', content: bounded.text })
  }
  return evidence
}

function recordSource(
  sources: RpaModelContextSourceProvenance[],
  conflicts: RpaModelContextConflict[],
  sourceType: RpaModelContextSourceType,
  sourceId: string,
  bounded: ReturnType<typeof boundText>,
  details: { roleId?: string; version?: string; trust: RpaModelContextSourceProvenance['trust'] }
): void {
  sources.push({
    sourceType,
    sourceId,
    version: details.version,
    roleId: details.roleId,
    originalChars: bounded.originalChars,
    includedChars: bounded.text.length,
    truncated: bounded.truncated,
    redacted: bounded.redacted,
    trust: details.trust
  })
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(bounded.text))) {
    conflicts.push({
      code: 'prompt_injection_detected',
      sourceType,
      sourceId,
      message: `${sourceType} "${sourceId}" contains instructions that cannot override the fixed RPA contract`
    })
  }
}

function boundText(
  value: string,
  budget: number
): {
  text: string
  originalChars: number
  truncated: boolean
  redacted: boolean
} {
  const originalChars = value.length
  const redactedText = value.replace(SECRET_VALUE, '$1[REDACTED]')
  const text = redactedText.slice(0, Math.max(0, budget))
  return { text, originalChars, truncated: text.length < redactedText.length, redacted: redactedText !== value }
}

function sanitizeBudgets(overrides?: Partial<RpaModelContextBudgets>): RpaModelContextBudgets {
  return {
    rolePrompts: positiveBudget(overrides?.rolePrompts, DEFAULT_RPA_MODEL_CONTEXT_BUDGETS.rolePrompts),
    localKnowledge: positiveBudget(overrides?.localKnowledge, DEFAULT_RPA_MODEL_CONTEXT_BUDGETS.localKnowledge),
    remoteKnowledge: positiveBudget(overrides?.remoteKnowledge, DEFAULT_RPA_MODEL_CONTEXT_BUDGETS.remoteKnowledge),
    observations: positiveBudget(overrides?.observations, DEFAULT_RPA_MODEL_CONTEXT_BUDGETS.observations),
    executionHistory: positiveBudget(overrides?.executionHistory, DEFAULT_RPA_MODEL_CONTEXT_BUDGETS.executionHistory),
    clarifications: positiveBudget(overrides?.clarifications, DEFAULT_RPA_MODEL_CONTEXT_BUDGETS.clarifications)
  }
}

function positiveBudget(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(50_000, Math.max(0, Math.floor(value)))
    : fallback
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (key, candidate) =>
      key === 'imageBase64' && typeof candidate === 'string' ? `[BINARY_IMAGE_OMITTED:${candidate.length}]` : candidate
    )
  } catch {
    return String(value)
  }
}

function readSourceId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return cleanOptional(value.id, 256) ?? cleanOptional(value.sourceId, 256)
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

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.flatMap((value) => (typeof value === 'string' && value.trim() ? [value.trim()] : [])))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
