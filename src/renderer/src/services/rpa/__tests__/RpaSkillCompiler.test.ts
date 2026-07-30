import { describe, expect, it } from 'vitest'

import { createDefaultRpaModuleRegistry } from '../RpaDefaultRegistry'
import { RpaSkillCompiler } from '../RpaSkillCompiler'
import type { RpaSkillRecord } from '../RpaSkillRepository'
import { validSkill } from './RpaSkillTestFixtures'

function record(overrides: Partial<RpaSkillRecord> = {}): RpaSkillRecord {
  return {
    ...validSkill(),
    validationIssues: [],
    revisions: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('RpaSkillCompiler', () => {
  it('compiles a state path with resolved parameters and Skill provenance', () => {
    const compiler = new RpaSkillCompiler(createDefaultRpaModuleRegistry())

    const result = compiler.compile({
      skill: record(),
      params: { durationMs: 750 },
      deviceIds: ['device-1'],
      currentStateId: 'MAIN',
      taskId: 'compiled-task'
    })

    expect(result.success).toBe(true)
    expect(result.transitionIds).toEqual(['home-to-detail'])
    expect(result.task).toMatchObject({
      id: 'compiled-task',
      deviceIds: ['device-1'],
      steps: [{ moduleId: 'wait', params: { durationMs: 750 } }],
      metadata: {
        rpaAssets: { skillIds: ['open-example-detail'] },
        compiledSkill: { id: 'open-example-detail', version: '1.0.0' },
        appStateProfile: { appPackage: 'com.example.app' },
        deterministicRecoveryPolicies: [
          {
            id: 'skill:open-example-detail:DETAIL',
            fromStateIds: ['DETAIL'],
            targetStateIds: ['HOME'],
            steps: [{ moduleId: 'press_back' }]
          }
        ]
      }
    })
  })

  it('prepends a state-specific fallback before compiling the recovery path', () => {
    const compiler = new RpaSkillCompiler(createDefaultRpaModuleRegistry())

    const result = compiler.compile({ skill: record(), deviceIds: [], currentStateId: 'DETAIL' })

    expect(result.success).toBe(true)
    expect(result.usedFallbackRule).toBe('DETAIL')
    expect(result.task?.steps.map((step) => step.moduleId)).toEqual(['press_back', 'wait'])
  })

  it('rejects missing parameters, prohibited modules, and unknown states', () => {
    const compiler = new RpaSkillCompiler(createDefaultRpaModuleRegistry())
    const missingParam = record({ parameters: [{ name: 'durationMs', type: 'number', required: true }] })
    const prohibited = record({ prohibitedModuleIds: ['wait'] })

    expect(compiler.compile({ skill: missingParam, deviceIds: [], currentStateId: 'HOME' }).issues[0].path).toBe(
      'params.durationMs'
    )
    expect(compiler.compile({ skill: prohibited, deviceIds: [], currentStateId: 'HOME' }).issues[0].message).toContain(
      'prohibits'
    )
    expect(compiler.compile({ skill: record(), deviceIds: [], currentStateId: 'UNKNOWN' }).success).toBe(true)
  })
})
