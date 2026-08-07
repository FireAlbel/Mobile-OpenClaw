import { describe, expect, it } from 'vitest'

import { RpaAppPlaybookLearningService } from '../RpaAppPlaybookLearningService'
import { type RpaAppPlaybook, RpaAppPlaybookRepository, type RpaAppPlaybookStorage } from '../RpaAppPlaybookRepository'
import type { RpaBatchRunRecord } from '../RpaRunStorage'

class MemoryStorage implements RpaAppPlaybookStorage {
  playbooks: RpaAppPlaybook[] = []
  async loadPlaybooks() {
    return structuredClone(this.playbooks)
  }
  async savePlaybooks(playbooks: RpaAppPlaybook[]) {
    this.playbooks = structuredClone(playbooks)
  }
}

function successfulRun(): RpaBatchRunRecord {
  return {
    id: 'run-1',
    task: {
      id: 'task-1',
      name: 'Return home',
      goal: 'Return to app home',
      deviceIds: ['device-1'],
      steps: [
        {
          id: 'ensure-home',
          name: 'Ensure home',
          moduleId: 'app.ensure_home',
          params: { packageName: 'com.example.app' },
          continueOnFailure: false
        }
      ],
      metadata: {
        locale: 'zh-CN',
        appStateProfile: {
          appPackage: 'com.example.app',
          appVersion: '2.0.0',
          states: [
            { stateId: 'HOME', activityIncludes: ['MainActivity'], requiredTexts: ['首页'] },
            {
              stateId: 'DETAIL',
              activityIncludes: ['DetailActivity'],
              requiredTexts: ['详情'],
              recoveryScope: 'navigate'
            }
          ]
        }
      }
    },
    deviceIds: ['device-1'],
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
    deviceRuns: [
      {
        id: 'run-1-device-1',
        batchRunId: 'run-1',
        taskId: 'task-1',
        deviceId: 'device-1',
        status: 'completed',
        createdAt: 1,
        updatedAt: 2,
        events: [
          {
            taskId: 'task-1',
            deviceId: 'device-1',
            stepId: 'ensure-home',
            stepName: 'Ensure home',
            status: 'passed',
            attempt: 1,
            message: 'App normalization goal_achieved: HOME',
            timestamp: 2,
            phase: 'app_normalization_terminal',
            data: {
              outcome: 'goal_achieved',
              initialState: {
                stateId: 'DETAIL',
                blockingCondition: 'none',
                recoveryScope: 'navigate',
                evidence: [{ source: 'foreground_activity', value: 'DetailActivity', matched: true }]
              },
              finalState: {
                stateId: 'HOME',
                blockingCondition: 'none',
                recoveryScope: 'none',
                evidence: [{ source: 'ui_tree', value: '首页', matched: true }]
              },
              actionGroups: [
                {
                  stage: 'bounded_back',
                  success: true,
                  beforeStateId: 'DETAIL',
                  afterStateId: 'HOME',
                  actions: [{ type: 'key', detail: 'back' }],
                  verification: { status: 'passed', confidence: 0.95, message: 'HOME reached' }
                }
              ]
            }
          }
        ]
      }
    ]
  }
}

describe('RpaAppPlaybookLearningService', () => {
  it('creates one versioned playbook edge and applies the same run idempotently', async () => {
    const repository = new RpaAppPlaybookRepository(new MemoryStorage(), () => 100)
    const learning = new RpaAppPlaybookLearningService(repository)
    const run = successfulRun()

    const first = await learning.learn(run)
    const repeated = await learning.learn(run)
    const playbook = await repository.resolve('com.example.app', '2.0.0', 'zh-CN')

    expect(first).toMatchObject({ status: 'created', appliedVersion: 1, learnedEdgeCount: 1 })
    expect(repeated).toMatchObject({ status: 'already_applied', appliedVersion: 1 })
    expect(playbook?.edges).toMatchObject([
      { fromStateIds: ['DETAIL'], toStateId: 'HOME', steps: [{ moduleId: 'press_back' }] }
    ])
  })

  it('does not learn executable edges from protected states', async () => {
    const repository = new RpaAppPlaybookRepository(new MemoryStorage())
    const learning = new RpaAppPlaybookLearningService(repository)
    const run = successfulRun()
    const profile = run.task.metadata.appStateProfile as { states: Array<Record<string, unknown>> }
    profile.states[1] = {
      ...profile.states[1],
      blockingCondition: 'authentication',
      recoveryScope: 'human'
    }

    const result = await learning.learn(run)
    const playbook = await repository.resolve('com.example.app', '2.0.0', 'zh-CN')

    expect(result.learnedEdgeCount).toBe(0)
    expect(playbook?.edges).toEqual([])
  })
})
