import type { RpaModuleRegistry } from './RpaModuleRegistry'
import { type RpaTask, RpaTaskSchema, type RpaValidationIssue, type RpaValidationResult } from './RpaTypes'

export class RpaTaskValidator {
  constructor(
    private readonly registry: RpaModuleRegistry,
    private readonly options: { requireDeviceIds?: boolean } = {}
  ) {}

  validate(input: unknown): RpaValidationResult {
    const parsed = RpaTaskSchema.safeParse(input)
    if (!parsed.success) {
      return {
        success: false,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      }
    }

    const issues = this.validateTaskSemantics(parsed.data)
    return {
      success: issues.length === 0,
      task: issues.length === 0 ? parsed.data : undefined,
      issues
    }
  }

  private validateTaskSemantics(task: RpaTask): RpaValidationIssue[] {
    const issues: RpaValidationIssue[] = []
    const stepIds = new Set<string>()

    if (this.options.requireDeviceIds !== false && task.deviceIds.length === 0) {
      issues.push({ path: 'deviceIds', message: 'At least one device is required' })
    }

    task.steps.forEach((step, index) => {
      const stepPath = `steps.${index}`
      if (stepIds.has(step.id)) {
        issues.push({ path: `${stepPath}.id`, message: `Duplicate step id: ${step.id}` })
      }
      stepIds.add(step.id)

      if (!this.registry.has(step.moduleId)) {
        issues.push({
          path: `${stepPath}.moduleId`,
          message: `Unknown module "${step.moduleId}". Available modules: ${this.registry
            .listMetadata()
            .map((module) => module.id)
            .join(', ')}`
        })
        return
      }

      const paramsResult = this.registry.validateParams(step.moduleId, step.params)
      for (const issue of paramsResult.issues) {
        issues.push({ path: `${stepPath}.params`, message: issue })
      }

      const module = this.registry.require(step.moduleId)
      if (step.moduleId === 'launch_app' && !['foreground_app', 'vlm_assert'].includes(step.verify?.type ?? '')) {
        issues.push({
          path: `${stepPath}.verify`,
          message: 'launch_app requires foreground_app or vlm_assert verification'
        })
      }
      if (['app.ensure_foreground', 'app.ensure_state', 'app.ensure_home'].includes(step.moduleId)) {
        issues.push({
          path: `${stepPath}.moduleId`,
          message: `${step.moduleId} is runtime-only recovery behavior and cannot appear in the primary business DSL`
        })
      }
      if (step.moduleId === 'app.restart' && step.continueOnFailure) {
        issues.push({
          path: `${stepPath}.continueOnFailure`,
          message: 'Explicit app restart cannot continue after failure'
        })
      }
      if (
        ['tap_by_vlm_target', 'swipe_until_vlm_target'].includes(step.moduleId) &&
        step.verify?.type !== 'vlm_assert'
      ) {
        issues.push({
          path: `${stepPath}.verify`,
          message: `${step.moduleId} requires vlm_assert verification of the resulting screen state`
        })
      }
      if (module.metadata.riskLevel === 'high' && step.continueOnFailure) {
        issues.push({
          path: `${stepPath}.continueOnFailure`,
          message: 'High-risk modules cannot continue automatically after failure'
        })
      }
    })

    if (task.steps.some((step) => ['tap_by_vlm_target', 'swipe_until_vlm_target'].includes(step.moduleId))) {
      const finalStep = task.steps.at(-1)
      if (finalStep?.verify?.type !== 'vlm_assert') {
        issues.push({
          path: `steps.${task.steps.length - 1}.verify`,
          message: 'Visual workflows require a final vlm_assert business outcome verification'
        })
      }
    }

    const finalStep = task.steps.at(-1)
    if (finalStep?.verify?.type === 'vlm_assert' && containsHistoricalAssertion(finalStep.verify.expectation)) {
      issues.push({
        path: `steps.${task.steps.length - 1}.verify.expectation`,
        message:
          'Final screenshot verification may assert only the current visible state, not historical actions or side effects'
      })
    }

    return issues
  }
}

function containsHistoricalAssertion(expectation: string): boolean {
  return /曾经|曾进入|之前|先前|已经返回|未修改|没有修改|without (?:changing|modifying)|previously|earlier screen|returned from/i.test(
    expectation
  )
}
