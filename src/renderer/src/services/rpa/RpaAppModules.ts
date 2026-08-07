import * as z from 'zod'

import { RpaAppStateNormalizationService } from './RpaAppStateNormalizationService'
import type {
  RpaActionModule,
  RpaAppNormalizationPolicy,
  RpaAppNormalizationResult,
  RpaModuleExecutionContext,
  RpaModuleResult,
  RpaRetryPolicy
} from './RpaTypes'

const packageNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_.]+$/, 'Invalid Android package name')
const stageSchema = z.enum([
  'dismiss_transient',
  'dismiss_keyboard',
  'bounded_back',
  'known_home_action',
  'soft_relaunch',
  'hard_restart'
])
const recoveryPolicySchema = z
  .object({
    stages: z.array(stageSchema).min(1).max(6).optional(),
    maxBackCount: z.number().int().min(0).max(5).optional(),
    restartMode: z.enum(['soft', 'hard', 'soft_then_hard']).optional(),
    deadlineMs: z.number().int().min(1_000).max(120_000).optional(),
    stabilityWindowMs: z.number().int().min(0).max(5_000).optional(),
    noProgressLimit: z.number().int().min(1).max(5).optional()
  })
  .strict()
  .optional()

const defaultRetry: RpaRetryPolicy = { maxAttempts: 1, backoffMs: 0, retryOn: ['failed', 'timeout'] }

function metadata(id: string, name: string, description: string) {
  return {
    id,
    name,
    description,
    riskLevel: 'low' as const,
    defaultTimeoutMs: 125_000,
    defaultRetry,
    plannerHints: [
      description,
      'This module is idempotent and verifies the requested app state before returning success.'
    ]
  }
}

const ensureForegroundParamsSchema = z.object({
  packageName: packageNameSchema,
  recoveryPolicy: recoveryPolicySchema
})

const ensureStateParamsSchema = z.object({
  packageName: packageNameSchema,
  targetState: z.string().trim().min(1).max(160),
  appVersion: z.string().trim().max(120).optional(),
  locale: z.string().trim().max(40).optional(),
  recoveryPolicy: recoveryPolicySchema
})

const ensureHomeParamsSchema = z.object({
  packageName: packageNameSchema,
  appVersion: z.string().trim().max(120).optional(),
  locale: z.string().trim().max(40).optional(),
  recoveryPolicy: recoveryPolicySchema
})

const restartParamsSchema = z.object({
  packageName: packageNameSchema,
  restartMode: z.enum(['soft', 'hard']).default('hard'),
  targetState: z.string().trim().min(1).max(160).default('foreground'),
  appVersion: z.string().trim().max(120).optional(),
  locale: z.string().trim().max(40).optional(),
  recoveryPolicy: recoveryPolicySchema
})

export type RpaAppNormalizerFactory = (
  context: RpaModuleExecutionContext
) => Pick<RpaAppStateNormalizationService, 'normalize'>

export function createRpaAppModules(
  factory: RpaAppNormalizerFactory = (context) => new RpaAppStateNormalizationService(context.runtime)
): RpaActionModule[] {
  const execute = async (
    context: RpaModuleExecutionContext,
    params: {
      packageName: string
      targetState: string
      appVersion?: string
      locale?: string
      recoveryPolicy?: Partial<RpaAppNormalizationPolicy>
      restartFirst?: 'soft' | 'hard'
    }
  ): Promise<RpaModuleResult> => {
    const startedAt = Date.now()
    const result = await factory(context).normalize({
      deviceId: context.deviceId,
      packageName: params.packageName,
      targetState: params.targetState,
      task: context.task,
      appVersion: params.appVersion,
      locale: params.locale,
      policy: params.recoveryPolicy,
      restartFirst: params.restartFirst,
      signal: context.signal,
      reportProgress: context.reportProgress
    })
    return resultToModuleResult(result, startedAt, Boolean(context.reportProgress))
  }

  const ensureForeground: RpaActionModule<z.infer<typeof ensureForegroundParamsSchema>> = {
    metadata: metadata(
      'app.ensure_foreground',
      'Ensure app foreground',
      'Bring an app to the foreground and verify its package.'
    ),
    paramsSchema: ensureForegroundParamsSchema,
    execute: (context, params) =>
      execute(context, {
        ...params,
        targetState: 'foreground',
        recoveryPolicy: {
          stages: ['soft_relaunch', 'hard_restart'],
          ...params.recoveryPolicy
        }
      })
  }

  const ensureState: RpaActionModule<z.infer<typeof ensureStateParamsSchema>> = {
    metadata: metadata('app.ensure_state', 'Ensure app state', 'Normalize an app into a named App Playbook state.'),
    paramsSchema: ensureStateParamsSchema,
    execute: (context, params) => execute(context, params)
  }

  const ensureHome: RpaActionModule<z.infer<typeof ensureHomeParamsSchema>> = {
    metadata: metadata(
      'app.ensure_home',
      'Ensure app home',
      'Normalize an app into its verified App Playbook home state.'
    ),
    paramsSchema: ensureHomeParamsSchema,
    execute: (context, params) => execute(context, { ...params, targetState: 'home' })
  }

  const restart: RpaActionModule<z.infer<typeof restartParamsSchema>> = {
    metadata: metadata(
      'app.restart',
      'Restart app safely',
      'Softly relaunch or force-stop and reopen an app, then verify its state.'
    ),
    paramsSchema: restartParamsSchema,
    execute: (context, params) => execute(context, { ...params, restartFirst: params.restartMode })
  }

  return [ensureForeground, ensureState, ensureHome, restart]
}

function resultToModuleResult(
  result: RpaAppNormalizationResult,
  startedAt: number,
  liveProgressReported: boolean
): RpaModuleResult {
  return {
    success: result.success,
    status: result.status,
    message: result.message,
    data: { ...result, liveProgressReported },
    artifacts: {
      initialStateArtifactId: result.initialState?.artifactId,
      finalStateArtifactId: result.finalState?.artifactId,
      playbookId: result.playbookId,
      playbookVersion: result.playbookVersion
    },
    startedAt,
    finishedAt: Date.now()
  }
}

export const rpaAppModules = createRpaAppModules()
