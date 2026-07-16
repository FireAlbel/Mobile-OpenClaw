import type { Model } from '@renderer/types'
import * as z from 'zod'

export type RpaStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'timeout' | 'needs_human' | 'cancelled'

export type RpaVerificationStatus = 'passed' | 'failed' | 'uncertain' | 'skipped'

export type RpaRiskLevel = 'low' | 'medium' | 'high'

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
  deviceIds: z.array(z.string().min(1)).min(1),
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
