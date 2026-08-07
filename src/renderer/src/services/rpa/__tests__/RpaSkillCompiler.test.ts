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
      steps: [
        {
          moduleId: 'wait',
          params: { durationMs: 750 },
          recoveryPolicyRef: {
            appPackage: 'com.example.app',
            expectedStateId: 'HOME',
            skillId: 'open-example-detail',
            skillVersion: '1.0.0'
          }
        }
      ],
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

  it('keeps state-specific fallback steps out of the primary business DSL', () => {
    const compiler = new RpaSkillCompiler(createDefaultRpaModuleRegistry())

    const result = compiler.compile({ skill: record(), deviceIds: [], currentStateId: 'DETAIL' })

    expect(result.success).toBe(true)
    expect(result.usedFallbackRule).toBe('DETAIL')
    expect(result.task?.steps.map((step) => step.moduleId)).toEqual(['wait'])
    expect(result.task?.metadata.deterministicRecoveryPolicies).toMatchObject([
      { fromStateIds: ['DETAIL'], targetStateIds: ['HOME'], steps: [{ moduleId: 'press_back' }] }
    ])
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

  it('compiles a Skill locator and search policy into deterministic list scan parameters', () => {
    const compiler = new RpaSkillCompiler(createDefaultRpaModuleRegistry())
    const skill = record({
      locators: [
        {
          ...validSkill().locators[0],
          id: 'about-device',
          value: '关于本机',
          aliases: ['关于手机', 'About phone'],
          resourceIds: ['android:id/title'],
          searchPolicy: {
            ...validSkill().locators[0].searchPolicy,
            maxScanSwipes: 12,
            includeOcr: true
          }
        }
      ],
      transitions: [
        {
          id: 'find-about',
          fromStateIds: ['HOME'],
          toStateId: 'DETAIL',
          priority: 10,
          steps: [
            {
              id: 'scan-about',
              name: 'Scan for About phone',
              moduleId: 'list.scan_target',
              params: { locatorId: 'about-device' },
              continueOnFailure: false
            }
          ]
        }
      ]
    })

    const result = compiler.compile({ skill, deviceIds: ['device-1'] })

    expect(result.success).toBe(true)
    expect(result.task?.steps[0]).toMatchObject({
      moduleId: 'list.scan_target',
      params: {
        target: '关于本机',
        targetAliases: ['关于本机', '关于手机', 'About phone'],
        resourceIds: ['android:id/title'],
        maxScanSwipes: 12,
        includeOcr: true
      }
    })
    expect(result.task?.metadata.compiledSkill).toMatchObject({
      navigationContext: [{ locatorId: 'about-device', aliases: ['关于手机', 'About phone'] }]
    })
  })
})
