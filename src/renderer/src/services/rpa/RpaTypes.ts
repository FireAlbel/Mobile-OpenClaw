import type { Model } from '@renderer/types'
import * as z from 'zod'

export type RpaStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'timeout' | 'needs_human' | 'cancelled'

export type RpaVerificationStatus = 'passed' | 'failed' | 'uncertain' | 'skipped'

export type RpaRiskLevel = 'low' | 'medium' | 'high'

export type RpaSafetyDecisionType = 'allow' | 'delay' | 'confirmation_required' | 'blocked'

export interface RpaModuleSafetyMetadata {
  requiresConfirmation?: boolean
  rateLimitCategory?: string
  textParamPaths?: string[]
}

export interface RpaSafetyDecision {
  decision: RpaSafetyDecisionType
  riskLevel: RpaRiskLevel
  target: string
  reason: string
  evaluatedAt: number
  delayMs?: number
  rateLimit?: {
    scope: 'device' | 'task'
    limit: number
    windowMs: number
    current: number
  }
}

export interface RpaSafetyApproval {
  id: string
  taskId: string
  taskFingerprint: string
  approvedTargets: string[]
  deviceIds: string[]
  grantedAt: number
  expiresAt: number
}

export interface RpaTaskRiskSummary {
  highestRisk: RpaRiskLevel
  highRiskTargets: string[]
  mediumRiskTargets: string[]
}

export const RpaCorrectionActionSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    type: z.literal('tap'),
    x: z.number().int().min(0),
    y: z.number().int().min(0)
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('swipe'),
    x1: z.number().int().min(0),
    y1: z.number().int().min(0),
    x2: z.number().int().min(0),
    y2: z.number().int().min(0),
    durationMs: z.number().int().min(100).max(5_000).default(500)
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('key'),
    key: z.enum(['back', 'home', 'enter', 'recent_apps'])
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('start_app'),
    packageName: z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/)
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('wait'),
    durationMs: z.number().int().min(100).max(10_000)
  }),
  z.object({
    id: z.string().min(1),
    type: z.literal('permission_action'),
    action: z.enum(['allow', 'deny', 'allow_once'])
  })
])

const RpaCorrectionDecisionBaseSchema = z.object({
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1)
})

export const RpaCorrectionDecisionSchema = z.discriminatedUnion('decision', [
  RpaCorrectionDecisionBaseSchema.extend({
    decision: z.literal('execute_actions'),
    actions: z.array(RpaCorrectionActionSchema).min(1).max(5),
    expectedOutcome: z.string().min(1)
  }),
  RpaCorrectionDecisionBaseSchema.extend({
    decision: z.literal('replan'),
    objective: z.string().min(1)
  }),
  RpaCorrectionDecisionBaseSchema.extend({
    decision: z.literal('human_required'),
    interventionCode: z.string().min(1)
  }),
  RpaCorrectionDecisionBaseSchema.extend({
    decision: z.literal('goal_achieved'),
    evidence: z.string().min(1)
  })
])

export type RpaCorrectionAction = z.infer<typeof RpaCorrectionActionSchema>
export type RpaCorrectionDecision = z.infer<typeof RpaCorrectionDecisionSchema>

export type RpaRunEventPhase =
  | 'original_step'
  | 'original_failure'
  | 'correction_observation'
  | 'correction_decision'
  | 'temporary_action'
  | 'temporary_step'
  | 'correction_verification'
  | 'correction_terminal'
  | 'safety_policy'

export const RpaRetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(1),
  backoffMs: z.number().int().min(0).max(60_000).default(0),
  retryOn: z.array(z.enum(['failed', 'timeout', 'uncertain'])).default(['failed', 'timeout'])
})

export const RpaTimeoutPolicySchema = z.object({
  stepTimeoutMs: z
    .number()
    .int()
    .min(100)
    .max(10 * 60_000)
    .default(30_000),
  taskTimeoutMs: z
    .number()
    .int()
    .min(100)
    .max(24 * 60 * 60_000)
    .optional()
})

export const RpaVerificationSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('none')
  }),
  z.object({
    type: z.literal('screenshot_exists')
  }),
  z.object({
    type: z.literal('foreground_app'),
    packageName: z.string().min(1)
  }),
  z.object({
    type: z.literal('module_result_success')
  }),
  z.object({
    type: z.literal('observation_has_screenshot')
  }),
  z.object({
    type: z.literal('vlm_assert'),
    expectation: z.string().min(1),
    minConfidence: z.number().min(0).max(1).default(0.7),
    settleMs: z.number().int().min(0).max(10_000).default(1200)
  })
])

export const RpaStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  moduleId: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z
    .number()
    .int()
    .min(100)
    .max(10 * 60_000)
    .optional(),
  retry: RpaRetryPolicySchema.optional(),
  verify: RpaVerificationSchema.optional(),
  continueOnFailure: z.boolean().default(false)
})

export const RpaVisionModelSchema = z.custom<Model>(
  (value) => {
    if (!value || typeof value !== 'object') return false
    const model = value as Partial<Model>
    return Boolean(model.id && model.provider && model.name && model.group)
  },
  { message: 'Invalid RPA vision model' }
)

export const RpaTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  goal: z.string().min(1),
  deviceIds: z.array(z.string().min(1)),
  steps: z.array(RpaStepSchema).min(1),
  retry: RpaRetryPolicySchema.optional(),
  timeout: RpaTimeoutPolicySchema.optional(),
  visionModel: RpaVisionModelSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
})

export type RpaRetryPolicy = z.infer<typeof RpaRetryPolicySchema>
export type RpaTimeoutPolicy = z.infer<typeof RpaTimeoutPolicySchema>
export type RpaVerification = z.infer<typeof RpaVerificationSchema>
export type RpaStep = z.infer<typeof RpaStepSchema>
export type RpaTask = z.infer<typeof RpaTaskSchema>

export interface RpaValidationIssue {
  path: string
  message: string
}

export interface RpaValidationResult {
  success: boolean
  task?: RpaTask
  issues: RpaValidationIssue[]
}

export interface RpaModuleMetadata {
  id: string
  name: string
  description: string
  riskLevel: RpaRiskLevel
  defaultTimeoutMs: number
  defaultRetry: RpaRetryPolicy
  plannerHints?: string[]
  safety?: RpaModuleSafetyMetadata
}

export interface RpaModuleExecutionContext {
  deviceId: string
  task: RpaTask
  step: RpaStep
  attempt: number
  runtime: RpaDeviceRuntime
  signal?: AbortSignal
}

export interface RpaModuleResult {
  success: boolean
  status: RpaStepStatus
  message: string
  data?: unknown
  artifacts?: Record<string, unknown>
  startedAt: number
  finishedAt: number
}

export interface RpaVerificationResult {
  status: RpaVerificationStatus
  confidence: number
  message: string
  evidence?: unknown
}

export interface RpaObservationWarning {
  source: 'screenshot' | 'foreground_app' | 'screen_size'
  message: string
}

export interface RpaDeviceObservation {
  deviceId: string
  capturedAt: number
  screenshot?: unknown
  foregroundApp?: unknown
  screenSize?: { width: number; height: number }
  warnings: RpaObservationWarning[]
  artifacts: Record<string, unknown>
}

export interface RpaObservationOptions {
  includeScreenshot?: boolean
  includeForegroundApp?: boolean
  includeScreenSize?: boolean
}

export interface RpaDeviceRuntimeResult<TData = unknown> {
  success: boolean
  message: string
  data?: TData
  startedAt: number
  finishedAt: number
}

export interface RpaDeviceRuntime {
  screenshot(deviceId: string): Promise<RpaDeviceRuntimeResult>
  tap(deviceId: string, x: number, y: number): Promise<RpaDeviceRuntimeResult>
  swipe(
    deviceId: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    duration?: number
  ): Promise<RpaDeviceRuntimeResult>
  key(deviceId: string, keyCode: number): Promise<RpaDeviceRuntimeResult>
  startApp(deviceId: string, packageName: string): Promise<RpaDeviceRuntimeResult>
  getForegroundApp(deviceId: string): Promise<RpaDeviceRuntimeResult>
  getScreenSize(deviceId: string): Promise<RpaDeviceRuntimeResult<{ width: number; height: number }>>
  handlePermissionDialog(
    deviceId: string,
    action: 'allow' | 'deny' | 'allow_once'
  ): Promise<RpaDeviceRuntimeResult<boolean>>
  visionInstruction(
    deviceId: string,
    instruction: string,
    allowedActions?: Array<'tap' | 'swipe'>,
    model?: Model,
    signal?: AbortSignal
  ): Promise<RpaDeviceRuntimeResult>
  locateVisualTarget(
    deviceId: string,
    target: string,
    model?: Model,
    signal?: AbortSignal
  ): Promise<
    RpaDeviceRuntimeResult<{
      found: boolean
      confidence: number
      reason: string
      needsHuman?: boolean
      rawResponse?: string
    }>
  >
  executeCorrectionAction(
    deviceId: string,
    action: RpaCorrectionAction,
    signal?: AbortSignal
  ): Promise<RpaDeviceRuntimeResult<{ transport: string; action: RpaCorrectionAction; result?: unknown }>>
}

export interface RpaActionModule<TParams = unknown> {
  metadata: RpaModuleMetadata
  paramsSchema: z.ZodType<TParams>
  execute(context: RpaModuleExecutionContext, params: TParams): Promise<RpaModuleResult>
}

export interface RpaRunStepEvent {
  taskId: string
  deviceId: string
  stepId: string
  stepName: string
  status: RpaStepStatus
  attempt: number
  message: string
  timestamp: number
  phase?: RpaRunEventPhase
  recoveryRound?: number
  parentStepId?: string
  temporary?: boolean
  action?: RpaCorrectionAction
  verification?: RpaVerificationResult
  safety?: RpaSafetyDecision
  data?: unknown
}

export interface RpaFailureContext {
  task: RpaTask
  deviceId: string
  failedStep: RpaStep
  failedStepIndex: number
  result: RpaModuleResult
  verification: RpaVerificationResult
  events: RpaRunStepEvent[]
  reason: string
  occurredAt: number
}

export interface RpaRunResult {
  taskId: string
  deviceId: string
  success: boolean
  status: 'completed' | 'failed' | 'cancelled' | 'needs_human'
  events: RpaRunStepEvent[]
  error?: string
  failureContext?: RpaFailureContext
  startedAt: number
  finishedAt: number
}
