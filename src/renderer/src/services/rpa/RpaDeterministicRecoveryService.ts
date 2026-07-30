import { type RpaFailureFingerprintRepository, rpaFailureFingerprintRepository } from './RpaFailureFingerprint'
import type { RpaModuleRegistry } from './RpaModuleRegistry'
import type { RpaDeviceObservation, RpaStep, RpaTask } from './RpaTypes'

export interface RpaDeterministicRecoveryPolicy {
  id: string
  fromStateIds: string[]
  targetStateIds: string[]
  priority: number
  steps: RpaStep[]
}

export interface RpaDeterministicRecoveryInput {
  task: RpaTask
  observation: RpaDeviceObservation
  expectedStateId?: string
  depth: number
  attemptedPolicyIds: string[]
}

export type RpaDeterministicRecoveryPlan =
  | {
      status: 'steps'
      policyId: string
      reason: string
      steps: RpaStep[]
      targetStateIds: string[]
    }
  | { status: 'human_required'; reason: string; interventionCode: string }
  | { status: 'not_applicable' | 'exhausted'; reason: string }

export class RpaDeterministicRecoveryService {
  constructor(
    private readonly registry: RpaModuleRegistry,
    private readonly failureFingerprints: RpaFailureFingerprintRepository = rpaFailureFingerprintRepository
  ) {}

  async plan(input: RpaDeterministicRecoveryInput): Promise<RpaDeterministicRecoveryPlan> {
    const state = input.observation.recognizedState
    if (!state) return { status: 'not_applicable', reason: 'No recognized app state is available' }

    if (isHumanOnlyState(state.blockingCondition, state.recoveryScope)) {
      return {
        status: 'human_required',
        reason: `State ${state.stateId} requires human intervention (${state.blockingCondition})`,
        interventionCode: `state_${state.blockingCondition}`
      }
    }

    const attempted = new Set(input.attemptedPolicyIds)
    const matchInput = {
      appPackage: readAppPackage(input.task),
      taskGoal: input.task.goal,
      stateId: state.stateId
    }
    const knownFailures = await this.failureFingerprints.findMatches(matchInput)
    const humanFingerprint = knownFailures.find((fingerprint) => fingerprint.disposition === 'human_required')
    if (humanFingerprint) {
      return {
        status: 'human_required',
        reason: `Known failure ${humanFingerprint.id} requires human intervention`,
        interventionCode: `known_failure_${humanFingerprint.failureClass.toLocaleLowerCase()}`
      }
    }
    const configured = readPolicies(input.task)
      .filter((policy) => policy.fromStateIds.includes(state.stateId) || policy.fromStateIds.includes('*'))
      .filter((policy) => !attempted.has(policy.id))
      .sort((left, right) => right.priority - left.priority)
    for (const policy of configured) {
      if (await this.failureFingerprints.shouldSkipPolicy(matchInput, policy.id)) continue
      const validationError = this.validatePolicy(policy)
      if (!validationError) {
        return {
          status: 'steps',
          policyId: policy.id,
          reason: `Apply configured recovery policy ${policy.id} from ${state.stateId}`,
          steps: policy.steps,
          targetStateIds: policy.targetStateIds
        }
      }
    }

    const builtin = this.builtinPlan(input)
    if (
      builtin &&
      !attempted.has(builtin.policyId) &&
      !(await this.failureFingerprints.shouldSkipPolicy(matchInput, builtin.policyId)) &&
      !this.validatePolicy(toPolicy(builtin))
    ) {
      return builtin
    }
    return {
      status: configured.length ? 'exhausted' : 'not_applicable',
      reason: `No remaining deterministic recovery rule applies to ${state.stateId}`
    }
  }

  isRecovered(plan: Extract<RpaDeterministicRecoveryPlan, { status: 'steps' }>, next: RpaDeviceObservation): boolean {
    const state = next.recognizedState
    if (!state) return false
    if (plan.targetStateIds.length) return plan.targetStateIds.includes(state.stateId)
    return state.stateId !== 'UNKNOWN' && !state.blocking
  }

  private builtinPlan(
    input: RpaDeterministicRecoveryInput
  ): Extract<RpaDeterministicRecoveryPlan, { status: 'steps' }> | undefined {
    const state = input.observation.recognizedState!
    const targetStateIds = builtInTargetStates(input.task, input.expectedStateId)
    if (state.blockingCondition === 'permission_dialog') {
      return stepsPlan('builtin:permission-dialog', 'Handle the Android permission dialog', targetStateIds, [
        recoveryStep('permission-dialog', 'Handle permission dialog', 'handle_popup', {
          action: 'allow_once',
          required: true
        })
      ])
    }
    if (state.blockingCondition === 'popup' || state.recoveryScope === 'dismiss_overlay') {
      return stepsPlan('builtin:dismiss-overlay', 'Dismiss the blocking overlay with Android Back', targetStateIds, [
        recoveryStep('dismiss-overlay', 'Dismiss overlay', 'press_back')
      ])
    }

    const appPackage = readAppPackage(input.task)
    if (state.recoveryScope === 'restart_app' && appPackage) {
      return stepsPlan('builtin:restart-app', `Restart ${appPackage}`, targetStateIds, [
        recoveryStep('restart-app', 'Restart target app', 'restart_app', { packageName: appPackage })
      ])
    }
    if (state.stateId !== 'UNKNOWN' && state.recoveryScope !== 'navigate') return undefined
    if (input.depth === 0) {
      return stepsPlan('builtin:navigate-back', 'Try one bounded Back navigation', targetStateIds, [
        recoveryStep('navigate-back', 'Navigate back', 'press_back')
      ])
    }
    if (input.depth === 1 && appPackage) {
      return stepsPlan('builtin:home-and-reopen', `Return Home and reopen ${appPackage}`, targetStateIds, [
        recoveryStep('press-home', 'Return to Android Home', 'press_home'),
        recoveryStep('reopen-app', 'Reopen target app', 'launch_app', { packageName: appPackage })
      ])
    }
    if (input.depth >= 2 && appPackage) {
      return stepsPlan('builtin:restart-app', `Restart ${appPackage}`, targetStateIds, [
        recoveryStep('restart-app', 'Restart target app', 'restart_app', { packageName: appPackage })
      ])
    }
    return undefined
  }

  private validatePolicy(policy: RpaDeterministicRecoveryPolicy): string | undefined {
    if (!policy.steps.length) return 'Recovery policy has no steps'
    for (const step of policy.steps) {
      if (!this.registry.has(step.moduleId)) return `Unknown recovery module ${step.moduleId}`
      if (!this.registry.validateParams(step.moduleId, step.params).success) {
        return `Invalid params for recovery module ${step.moduleId}`
      }
    }
    return undefined
  }
}

function toPolicy(plan: Extract<RpaDeterministicRecoveryPlan, { status: 'steps' }>): RpaDeterministicRecoveryPolicy {
  return {
    id: plan.policyId,
    fromStateIds: ['*'],
    targetStateIds: plan.targetStateIds,
    priority: 0,
    steps: plan.steps
  }
}

function isHumanOnlyState(blockingCondition: string, recoveryScope: string): boolean {
  return (
    recoveryScope === 'human' ||
    ['authentication', 'captcha', 'payment', 'account_security', 'unsupported_app_version'].includes(blockingCondition)
  )
}

function readPolicies(task: RpaTask): RpaDeterministicRecoveryPolicy[] {
  const value = task.metadata.deterministicRecoveryPolicies
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !Array.isArray(candidate.steps)) return []
    const steps = candidate.steps.filter(isRecoveryStep)
    if (!steps.length) return []
    return [
      {
        id: candidate.id,
        fromStateIds: stringArray(candidate.fromStateIds),
        targetStateIds: stringArray(candidate.targetStateIds),
        priority:
          typeof candidate.priority === 'number' && Number.isFinite(candidate.priority) ? candidate.priority : 0,
        steps
      }
    ]
  })
}

function readAppPackage(task: RpaTask): string | undefined {
  const profile = task.metadata.appStateProfile
  if (isRecord(profile) && typeof profile.appPackage === 'string' && profile.appPackage.trim()) {
    return profile.appPackage.trim()
  }
  const launchStep = task.steps.find((step) => step.moduleId === 'launch_app' || step.moduleId === 'restart_app')
  return typeof launchStep?.params.packageName === 'string' ? launchStep.params.packageName : undefined
}

function builtInTargetStates(task: RpaTask, expectedStateId?: string): string[] {
  if (expectedStateId) return [expectedStateId]
  const profile = task.metadata.appStateProfile
  if (!isRecord(profile) || !Array.isArray(profile.states)) return []
  return profile.states.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.stateId !== 'string') return []
    if (candidate.blockingCondition && candidate.blockingCondition !== 'none') return []
    return [candidate.stateId]
  })
}

function stepsPlan(
  policyId: string,
  reason: string,
  targetStateIds: string[],
  steps: RpaStep[]
): Extract<RpaDeterministicRecoveryPlan, { status: 'steps' }> {
  return { status: 'steps', policyId, reason, targetStateIds, steps }
}

function recoveryStep(id: string, name: string, moduleId: string, params: Record<string, unknown> = {}): RpaStep {
  return {
    id: `deterministic-${id}`,
    name,
    moduleId,
    params,
    retry: { maxAttempts: 1, backoffMs: 0, retryOn: ['failed', 'timeout'] },
    continueOnFailure: false
  }
}

function isRecoveryStep(value: unknown): value is RpaStep {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.moduleId === 'string' &&
    isRecord(value.params)
  )
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
