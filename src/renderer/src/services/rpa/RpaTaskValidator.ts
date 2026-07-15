import type { RpaModuleRegistry } from './RpaModuleRegistry'
import { type RpaTask, RpaTaskSchema, type RpaValidationIssue, type RpaValidationResult } from './RpaTypes'

export class RpaTaskValidator {
  constructor(private readonly registry: RpaModuleRegistry) {}

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
      if (module.metadata.riskLevel === 'high' && step.continueOnFailure) {
        issues.push({
          path: `${stepPath}.continueOnFailure`,
          message: 'High-risk modules cannot continue automatically after failure'
        })
      }
    })

    return issues
  }
}
