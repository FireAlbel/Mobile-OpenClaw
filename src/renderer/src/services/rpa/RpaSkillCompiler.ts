import type { RpaModuleRegistry } from './RpaModuleRegistry'
import type { RpaSkillDefinition, RpaSkillRecord, RpaSkillStepTemplate } from './RpaSkillRepository'
import { RpaTaskValidator } from './RpaTaskValidator'
import type { RpaStep, RpaTask, RpaValidationIssue } from './RpaTypes'

const PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/

export interface RpaSkillCompileInput {
  skill: RpaSkillRecord
  params?: Record<string, unknown>
  deviceIds: string[]
  currentStateId?: string
  taskId?: string
  taskName?: string
}

export interface RpaSkillCompileResult {
  success: boolean
  task?: RpaTask
  issues: RpaValidationIssue[]
  transitionIds: string[]
  usedFallbackRule?: string
}

export class RpaSkillCompiler {
  private readonly validator: RpaTaskValidator

  constructor(private readonly registry: RpaModuleRegistry) {
    this.validator = new RpaTaskValidator(registry, { requireDeviceIds: false })
  }

  compile(input: RpaSkillCompileInput): RpaSkillCompileResult {
    const issues: RpaValidationIssue[] = []
    if (input.skill.status !== 'ready') {
      return {
        success: false,
        issues: [{ path: 'skill.status', message: 'Only ready Skills can be compiled' }],
        transitionIds: []
      }
    }
    const params = resolveParameters(input.skill, input.params ?? {}, issues)
    const currentStateId = resolveStateId(input.skill, input.currentStateId) ?? input.skill.entryStateIds[0]
    const fallback = input.skill.fallbackRules.find((rule) => rule.stateId === currentStateId)
    const pathStartStateId = fallback?.resumeStateId ?? currentStateId
    const path = findTransitionPath(input.skill, pathStartStateId)
    if (!path && !fallback) {
      issues.push({ path: 'currentStateId', message: `No path from ${currentStateId} to a success state` })
    }
    if (issues.length) return { success: false, issues, transitionIds: [] }

    const templates = [...(fallback?.steps ?? []), ...(path?.flatMap((transition) => transition.steps) ?? [])]
    const compileValues = {
      ...params,
      ...Object.fromEntries(input.skill.locators.flatMap((locator) => locatorValues(locator)))
    }
    const steps = templates.map((step, index) => compileStep(step, compileValues, index, issues))
    const deterministicRecoveryPolicies = input.skill.fallbackRules.map((rule, policyIndex) => ({
      id: `skill:${input.skill.id}:${rule.stateId}`,
      fromStateIds: [rule.stateId],
      targetStateIds: rule.resumeStateId ? [rule.resumeStateId] : [],
      priority: 100 - policyIndex,
      steps: rule.steps.map((step, stepIndex) =>
        compileStep(step, compileValues, steps.length + policyIndex * 100 + stepIndex, issues)
      )
    }))
    if (steps.length && input.skill.successVerification && !steps.at(-1)?.verify) {
      steps[steps.length - 1] = { ...steps[steps.length - 1], verify: input.skill.successVerification }
    }
    for (const [index, step] of steps.entries()) {
      if (input.skill.prohibitedModuleIds.includes(step.moduleId)) {
        issues.push({ path: `steps.${index}.moduleId`, message: `Skill prohibits module ${step.moduleId}` })
      }
      if (!this.registry.has(step.moduleId)) {
        issues.push({ path: `steps.${index}.moduleId`, message: `Unknown module ${step.moduleId}` })
      }
    }
    if (issues.length) return { success: false, issues, transitionIds: path?.map((item) => item.id) ?? [] }

    const taskCandidate: RpaTask = {
      id: input.taskId ?? `rpa-skill-task-${Date.now()}`,
      name: input.taskName ?? input.skill.name,
      goal: input.skill.goals[0],
      deviceIds: input.deviceIds,
      steps,
      metadata: {
        rpaAssets: { skillIds: [input.skill.id] },
        compiledSkill: {
          id: input.skill.id,
          version: input.skill.version,
          startStateId: currentStateId,
          successStateIds: input.skill.successStateIds,
          transitionIds: path?.map((item) => item.id) ?? [],
          fallbackStateId: fallback?.stateId
        },
        appStateProfile: toAppStateProfile(input.skill),
        deterministicRecoveryPolicies
      }
    }
    const validation = this.validator.validate(taskCandidate)
    return {
      success: validation.success,
      task: validation.task,
      issues: validation.issues,
      transitionIds: path?.map((item) => item.id) ?? [],
      usedFallbackRule: fallback?.stateId
    }
  }
}

function resolveParameters(
  skill: RpaSkillDefinition,
  values: Record<string, unknown>,
  issues: RpaValidationIssue[]
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {}
  for (const parameter of skill.parameters) {
    const value = values[parameter.name] ?? parameter.defaultValue
    if (value === undefined && parameter.required) {
      issues.push({ path: `params.${parameter.name}`, message: 'Required Skill parameter is missing' })
      continue
    }
    if (value !== undefined && typeof value !== parameter.type) {
      issues.push({ path: `params.${parameter.name}`, message: `Expected ${parameter.type}` })
      continue
    }
    if (value !== undefined) resolved[parameter.name] = value
  }
  return resolved
}

function findTransitionPath(skill: RpaSkillDefinition, startStateId: string) {
  if (skill.successStateIds.includes(startStateId)) return []
  const queue: Array<{ stateId: string; path: RpaSkillDefinition['transitions'] }> = [
    { stateId: startStateId, path: [] }
  ]
  const visited = new Set([startStateId])
  while (queue.length) {
    const current = queue.shift()!
    const candidates = skill.transitions
      .filter(
        (transition) => transition.fromStateIds.includes(current.stateId) || transition.fromStateIds.includes('*')
      )
      .sort((left, right) => right.priority - left.priority)
    for (const transition of candidates) {
      const path = [...current.path, transition]
      if (skill.successStateIds.includes(transition.toStateId)) return path
      if (!visited.has(transition.toStateId)) {
        visited.add(transition.toStateId)
        queue.push({ stateId: transition.toStateId, path })
      }
    }
  }
  return undefined
}

function compileStep(
  template: RpaSkillStepTemplate,
  params: Record<string, unknown>,
  index: number,
  issues: RpaValidationIssue[]
): RpaStep {
  return {
    ...template,
    id: `${template.id}-${index + 1}`,
    params: resolvePlaceholders(template.params, params, `steps.${index}.params`, issues) as Record<string, unknown>
  }
}

function resolvePlaceholders(
  value: unknown,
  params: Record<string, unknown>,
  path: string,
  issues: RpaValidationIssue[]
): unknown {
  if (typeof value === 'string') {
    const match = value.match(PLACEHOLDER)
    if (!match) return value
    if (!(match[1] in params)) {
      issues.push({ path, message: `Unknown or unresolved Skill parameter: ${match[1]}` })
      return value
    }
    return params[match[1]]
  }
  if (Array.isArray(value))
    return value.map((item, index) => resolvePlaceholders(item, params, `${path}.${index}`, issues))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, resolvePlaceholders(nested, params, `${path}.${key}`, issues)])
    )
  }
  return value
}

function resolveStateId(skill: RpaSkillDefinition, stateId?: string): string | undefined {
  if (!stateId) return undefined
  const state = skill.states.find((candidate) => candidate.stateId === stateId || candidate.aliases.includes(stateId))
  return state?.stateId
}

function toAppStateProfile(skill: RpaSkillDefinition) {
  return {
    appPackage: skill.appPackage,
    states: skill.states.map((source) => {
      const state: Partial<typeof source> = { ...source }
      delete state.aliases
      return state
    })
  }
}

function locatorValues(locator: RpaSkillDefinition['locators'][number]): Array<[string, unknown]> {
  return [
    [`locator.${locator.id}.strategy`, locator.strategy],
    [`locator.${locator.id}.value`, locator.value],
    [`locator.${locator.id}.minConfidence`, locator.minConfidence]
  ]
}
