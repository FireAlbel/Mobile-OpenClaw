import type {
  RpaActionModule,
  RpaCorrectionAction,
  RpaModuleMetadata,
  RpaRiskLevel,
  RpaSafetyApproval,
  RpaSafetyDecision,
  RpaStep,
  RpaTask,
  RpaTaskRiskSummary
} from './RpaTypes'

export interface RpaSafetyRateLimit {
  scope: 'device' | 'task'
  maxActions: number
  windowMs: number
  category?: string
  behavior?: 'delay' | 'block'
}

export interface RpaContentModerationInput {
  taskId: string
  deviceId: string
  target: string
  texts: string[]
}

export interface RpaContentModerationResult {
  allowed: boolean
  reason?: string
}

export interface RpaSafetyPolicyOptions {
  now?: () => number
  confirmationTtlMs?: number
  blockedTargets?: string[]
  rateLimits?: RpaSafetyRateLimit[]
  moderateContent?: (input: RpaContentModerationInput) => Promise<RpaContentModerationResult>
}

interface PolicyInput {
  task: RpaTask
  deviceId: string
  target: string
  riskLevel: RpaRiskLevel
  requiresConfirmation: boolean
  rateLimitCategory: string
  texts: string[]
  approval?: RpaSafetyApproval
}

const RISK_ORDER: Record<RpaRiskLevel, number> = { low: 0, medium: 1, high: 2 }
const DEFAULT_RATE_LIMITS: RpaSafetyRateLimit[] = [
  { scope: 'device', maxActions: 120, windowMs: 60_000, behavior: 'delay' },
  { scope: 'task', maxActions: 500, windowMs: 60 * 60_000, behavior: 'delay' }
]

export class RpaSafetyPolicyEngine {
  private readonly history = new Map<string, number[]>()

  constructor(private readonly options: RpaSafetyPolicyOptions = {}) {}

  analyzeTask(task: RpaTask, modules: RpaModuleMetadata[]): RpaTaskRiskSummary {
    const moduleById = new Map(modules.map((module) => [module.id, module]))
    const highRiskTargets: string[] = []
    const mediumRiskTargets: string[] = []
    let highestRisk: RpaRiskLevel = 'low'

    for (const step of task.steps) {
      const metadata = moduleById.get(step.moduleId)
      if (!metadata) continue
      const policy = modulePolicy(metadata, step.params)
      if (RISK_ORDER[policy.riskLevel] > RISK_ORDER[highestRisk]) highestRisk = policy.riskLevel
      if (policy.riskLevel === 'high' || policy.requiresConfirmation) highRiskTargets.push(policy.target)
      else if (policy.riskLevel === 'medium') mediumRiskTargets.push(policy.target)
    }

    return {
      highestRisk,
      highRiskTargets: [...new Set(highRiskTargets)],
      mediumRiskTargets: [...new Set(mediumRiskTargets)]
    }
  }

  createApproval(task: RpaTask, approvedTargets: string[], deviceIds: string[] = task.deviceIds): RpaSafetyApproval {
    const grantedAt = this.now()
    return {
      id: `safety-approval-${grantedAt}-${Math.random().toString(36).slice(2, 10)}`,
      taskId: task.id,
      taskFingerprint: taskFingerprint(task),
      approvedTargets: [...new Set(approvedTargets)],
      deviceIds: [...new Set(deviceIds)],
      grantedAt,
      expiresAt: grantedAt + (this.options.confirmationTtlMs ?? 10 * 60_000)
    }
  }

  async evaluateModule(input: {
    task: RpaTask
    deviceId: string
    step: RpaStep
    module: RpaActionModule
    params: unknown
    approval?: RpaSafetyApproval
  }): Promise<RpaSafetyDecision> {
    const metadata = input.module.metadata
    const policy = modulePolicy(metadata, input.params)
    return await this.evaluate({
      task: input.task,
      deviceId: input.deviceId,
      target: policy.target,
      riskLevel: policy.riskLevel,
      requiresConfirmation: policy.requiresConfirmation,
      rateLimitCategory: metadata.safety?.rateLimitCategory ?? metadata.id,
      texts: extractTextParams(input.params, metadata.safety?.textParamPaths),
      approval: input.approval
    })
  }

  async evaluateCorrectionAction(input: {
    task: RpaTask
    deviceId: string
    action: RpaCorrectionAction
    approval?: RpaSafetyApproval
  }): Promise<RpaSafetyDecision> {
    const target = correctionTarget(input.action)
    const riskLevel = correctionRisk(input.action)
    return await this.evaluate({
      task: input.task,
      deviceId: input.deviceId,
      target,
      riskLevel,
      requiresConfirmation: riskLevel === 'high',
      rateLimitCategory: `correction:${input.action.type}`,
      texts: [],
      approval: input.approval
    })
  }

  reset(): void {
    this.history.clear()
  }

  private async evaluate(input: PolicyInput): Promise<RpaSafetyDecision> {
    const evaluatedAt = this.now()
    if (this.options.blockedTargets?.includes(input.target)) {
      return this.decision('blocked', input, `Safety policy blocks ${input.target}`, evaluatedAt)
    }

    if (input.texts.length && this.options.moderateContent) {
      const moderation = await this.options.moderateContent({
        taskId: input.task.id,
        deviceId: input.deviceId,
        target: input.target,
        texts: input.texts
      })
      if (!moderation.allowed) {
        return this.decision('blocked', input, moderation.reason || 'Generated text was rejected', evaluatedAt)
      }
    }

    if (
      input.requiresConfirmation &&
      !this.isApproved(input.task, input.deviceId, input.target, input.approval, evaluatedAt)
    ) {
      return this.decision('confirmation_required', input, `Confirmation required for ${input.target}`, evaluatedAt)
    }

    for (const limit of this.options.rateLimits ?? DEFAULT_RATE_LIMITS) {
      if (limit.category && limit.category !== input.rateLimitCategory) continue
      const key = rateLimitKey(limit.scope, input, limit.category ?? '*')
      const timestamps = (this.history.get(key) ?? []).filter((timestamp) => evaluatedAt - timestamp < limit.windowMs)
      this.history.set(key, timestamps)
      if (timestamps.length >= limit.maxActions) {
        const delayMs = Math.max(1, limit.windowMs - (evaluatedAt - timestamps[0]))
        return {
          ...this.decision(
            limit.behavior === 'block' ? 'blocked' : 'delay',
            input,
            `Rate limit reached for ${limit.scope}`,
            evaluatedAt
          ),
          delayMs: limit.behavior === 'block' ? undefined : delayMs,
          rateLimit: {
            scope: limit.scope,
            limit: limit.maxActions,
            windowMs: limit.windowMs,
            current: timestamps.length
          }
        }
      }
    }

    for (const limit of this.options.rateLimits ?? DEFAULT_RATE_LIMITS) {
      if (limit.category && limit.category !== input.rateLimitCategory) continue
      const key = rateLimitKey(limit.scope, input, limit.category ?? '*')
      this.history.set(key, [...(this.history.get(key) ?? []), evaluatedAt])
    }
    return this.decision('allow', input, `Safety policy allowed ${input.target}`, evaluatedAt)
  }

  private isApproved(
    task: RpaTask,
    deviceId: string,
    target: string,
    approval: RpaSafetyApproval | undefined,
    now: number
  ): boolean {
    return Boolean(
      approval &&
        approval.taskId === task.id &&
        approval.taskFingerprint === taskFingerprint(task) &&
        approval.expiresAt >= now &&
        approval.deviceIds.includes(deviceId) &&
        approval.approvedTargets.includes(target)
    )
  }

  private decision(
    decision: RpaSafetyDecision['decision'],
    input: PolicyInput,
    reason: string,
    evaluatedAt: number
  ): RpaSafetyDecision {
    return { decision, riskLevel: input.riskLevel, target: input.target, reason, evaluatedAt }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

export function taskFingerprint(task: RpaTask): string {
  const value = JSON.stringify({
    id: task.id,
    goal: task.goal,
    deviceIds: [...task.deviceIds].sort(),
    steps: task.steps.map((step) => ({
      id: step.id,
      moduleId: step.moduleId,
      params: step.params,
      timeoutMs: step.timeoutMs,
      retry: step.retry,
      verify: step.verify,
      continueOnFailure: step.continueOnFailure
    }))
  })
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function moduleTarget(moduleId: string): string {
  return `module:${moduleId}`
}

function modulePolicy(metadata: RpaModuleMetadata, params: unknown) {
  if (metadata.id === 'handle_popup' && params && typeof params === 'object' && 'action' in params) {
    const action = params.action
    if (action === 'allow' || action === 'allow_once') {
      return {
        target: `${moduleTarget(metadata.id)}:${action}`,
        riskLevel: 'high' as const,
        requiresConfirmation: true
      }
    }
  }
  return {
    target: moduleTarget(metadata.id),
    riskLevel: metadata.riskLevel,
    requiresConfirmation: metadata.riskLevel === 'high' || metadata.safety?.requiresConfirmation === true
  }
}

function correctionTarget(action: RpaCorrectionAction): string {
  return action.type === 'permission_action'
    ? `correction:${action.type}:${action.action}`
    : `correction:${action.type}`
}

function correctionRisk(action: RpaCorrectionAction): RpaRiskLevel {
  if (action.type === 'permission_action' && action.action !== 'deny') return 'high'
  if (action.type === 'permission_action' || action.type === 'start_app') return 'medium'
  return 'low'
}

function rateLimitKey(scope: RpaSafetyRateLimit['scope'], input: PolicyInput, category: string): string {
  const owner = scope === 'device' ? input.deviceId : input.task.id
  return `${scope}:${owner}:${category}`
}

function extractTextParams(params: unknown, paths: string[] | undefined): string[] {
  if (!paths?.length || !params || typeof params !== 'object') return []
  const record = params as Record<string, unknown>
  return paths.flatMap((path) => {
    let current: unknown = record
    for (const segment of path.split('.')) {
      if (!current || typeof current !== 'object') return []
      current = (current as Record<string, unknown>)[segment]
    }
    return typeof current === 'string' && current.trim() ? [current] : []
  })
}

export const rpaSafetyPolicyEngine = new RpaSafetyPolicyEngine()
