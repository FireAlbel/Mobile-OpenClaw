import type { RpaSkillDefinition } from '../RpaSkillRepository'

export function validSkill(overrides: Partial<RpaSkillDefinition> = {}): RpaSkillDefinition {
  return {
    id: 'open-example-detail',
    version: '1.0.0',
    name: 'Open example detail',
    description: 'Open the app and enter the detail page',
    status: 'ready',
    appPackage: 'com.example.app',
    goals: ['打开详情页面', 'open detail'],
    tags: ['example'],
    parameters: [{ name: 'durationMs', type: 'number', required: true, defaultValue: 300 }],
    locators: [
      {
        id: 'detail-tab',
        stateIds: ['HOME'],
        strategy: 'ui_text',
        value: '详情',
        fallbackLocatorIds: [],
        minConfidence: 0.8
      }
    ],
    states: [
      {
        stateId: 'HOME',
        aliases: ['MAIN'],
        priority: 0,
        packageNames: ['com.example.app'],
        activityIncludes: [],
        requiredTexts: [],
        anyTexts: ['首页'],
        excludedTexts: [],
        requireScreenshot: false,
        blockingCondition: 'none',
        recoveryScope: 'none',
        suggestedTransitions: ['DETAIL']
      },
      {
        stateId: 'DETAIL',
        aliases: [],
        priority: 0,
        packageNames: ['com.example.app'],
        activityIncludes: [],
        requiredTexts: [],
        anyTexts: ['详情'],
        excludedTexts: [],
        requireScreenshot: false,
        blockingCondition: 'none',
        recoveryScope: 'none',
        suggestedTransitions: []
      }
    ],
    entryStateIds: ['HOME'],
    successStateIds: ['DETAIL'],
    transitions: [
      {
        id: 'home-to-detail',
        fromStateIds: ['HOME'],
        toStateId: 'DETAIL',
        priority: 10,
        steps: [
          {
            id: 'wait-ready',
            name: 'Wait for detail',
            moduleId: 'wait',
            params: { durationMs: '{{durationMs}}' },
            continueOnFailure: false,
            verify: { type: 'module_result_success' }
          }
        ]
      }
    ],
    fallbackRules: [
      {
        stateId: 'DETAIL',
        resumeStateId: 'HOME',
        steps: [{ id: 'back-home', name: 'Return home', moduleId: 'press_back', params: {}, continueOnFailure: false }]
      }
    ],
    successVerification: { type: 'module_result_success' },
    prohibitedModuleIds: [],
    metadata: {},
    ...overrides
  }
}
