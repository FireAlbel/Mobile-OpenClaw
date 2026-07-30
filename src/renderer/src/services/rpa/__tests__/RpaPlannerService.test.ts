import type { Assistant, Model } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/config/models/vision', () => ({ isVisionModel: () => true }))

import { resolveEffectiveRpaRoleContext } from '../EffectiveRpaRoleContextResolver'
import { createDefaultRpaAppRole } from '../RpaAppRole'
import { createDefaultRpaAssistantProfile } from '../RpaAssistantProfile'
import { createDefaultRpaModuleRegistry } from '../RpaDefaultRegistry'
import type { RpaFailureFingerprintRepository } from '../RpaFailureFingerprint'
import type { RpaModelClient } from '../RpaModelClient'
import { RpaPlannerService } from '../RpaPlannerService'
import type { EffectiveRpaSessionSupplementSnapshot } from '../RpaSessionSupplementResolver'
import { RpaSkillCompiler } from '../RpaSkillCompiler'
import { type RpaSkillRecord, RpaSkillRepository, type RpaSkillStorage } from '../RpaSkillRepository'
import { validSkill } from './RpaSkillTestFixtures'

class MemorySkillStorage implements RpaSkillStorage {
  skills: RpaSkillRecord[] = []
  async loadSkills() {
    return structuredClone(this.skills)
  }
  async saveSkills(skills: RpaSkillRecord[]) {
    this.skills = structuredClone(skills)
  }
}

function modelClient(responses: string[]): RpaModelClient {
  const complete = vi.fn()
  for (const response of responses) {
    complete.mockResolvedValueOnce(response)
  }
  return { complete }
}

function validTaskJson() {
  return JSON.stringify({
    id: 'task-1',
    name: 'Open app',
    goal: 'Open app',
    deviceIds: ['device-1'],
    metadata: {},
    steps: [
      {
        id: 'step-1',
        name: 'Launch',
        moduleId: 'launch_app',
        params: { packageName: 'com.example.app' },
        verify: { type: 'foreground_app', packageName: 'com.example.app' },
        continueOnFailure: false
      }
    ]
  })
}

function supplementContext(
  overrides: Partial<EffectiveRpaSessionSupplementSnapshot> = {}
): EffectiveRpaSessionSupplementSnapshot {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    role: { id: 'role-1', version: 1 },
    supplementRevision: 2,
    bindings: [],
    evidenceSources: [],
    providerSelections: [],
    toolAllowlist: {},
    issues: [],
    executable: true,
    resolvedAt: 1,
    ...overrides
  }
}

describe('RpaPlannerService', () => {
  it('returns a validated DSL task from model output', async () => {
    const client = modelClient([validTaskJson()])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: ['device-1'] })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(false)
    expect(result.task?.steps[0].moduleId).toBe('launch_app')
  })

  it('forwards the selected chat assistant and MCP tool allowlist to the model client', async () => {
    const client = modelClient([validTaskJson()])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })
    const assistant = {
      id: 'assistant-1',
      name: 'RPA assistant',
      prompt: 'Plan a device workflow',
      model: { id: 'gpt-5', name: 'GPT-5', provider: 'openai', group: 'gpt' } as Model,
      topics: [],
      type: 'assistant',
      mcpMode: 'manual',
      mcpServers: [{ id: 'browser', name: '@cherry/browser', isActive: true }]
    } as Assistant

    await service.plan({
      goal: 'open a page',
      deviceIds: [],
      assistant,
      allowedTools: ['browser__open']
    })

    expect(client.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        assistant,
        allowedTools: ['browser__open']
      })
    )
  })

  it('blocks planning before model invocation when required Session Supplements are unavailable', async () => {
    const client = modelClient([validTaskJson()])
    const service = new RpaPlannerService({ registry: createDefaultRpaModuleRegistry(), modelClient: client })
    const result = await service.plan({
      goal: 'open app',
      deviceIds: [],
      supplementContext: supplementContext({
        executable: false,
        issues: [
          {
            severity: 'error',
            code: 'required_source_unavailable',
            message: 'Required manual is unavailable'
          }
        ]
      })
    })

    expect(result).toMatchObject({
      success: false,
      issues: [{ path: '$.sessionSupplements', message: 'Required manual is unavailable' }]
    })
    expect(client.complete).not.toHaveBeenCalled()
  })

  it('provides only the resolved immutable Supplement snapshot to the Planner', async () => {
    const client = modelClient([validTaskJson()])
    const service = new RpaPlannerService({ registry: createDefaultRpaModuleRegistry(), modelClient: client })

    await service.plan({
      goal: 'open app',
      deviceIds: [],
      supplementContext: supplementContext({
        evidenceSources: [
          {
            bindingId: 'binding-1',
            sourceType: 'artifact',
            sourceId: 'artifact-1',
            contentHash: 'sha256:artifact',
            scope: 'session',
            requirement: 'optional',
            lifecycle: 'ready',
            status: 'ready',
            trust: { classification: 'untrusted', reviewed: false },
            retention: { mode: 'session' }
          }
        ],
        toolAllowlist: { 'device-tools': ['tap'] }
      })
    })

    const prompt = JSON.stringify(vi.mocked(client.complete).mock.calls[0][0].messages)
    expect(prompt).toContain('sessionSupplements')
    expect(prompt).toContain('artifact-1')
    expect(prompt).toContain('sha256:artifact')
    expect(prompt).toContain('device-tools')
  })

  it('returns a bounded clarification outcome instead of repairing it as invalid DSL', async () => {
    const client = modelClient([
      JSON.stringify({
        outcome: 'needs_clarification',
        questions: [{ id: 'target-app', question: 'Which app should be opened?', required: true }]
      })
    ])
    const service = new RpaPlannerService({ registry: createDefaultRpaModuleRegistry(), modelClient: client })

    const result = await service.plan({ goal: 'Open it', deviceIds: [] })

    expect(result).toMatchObject({
      success: false,
      repaired: false,
      clarifications: [{ id: 'target-app', question: 'Which app should be opened?', required: true }]
    })
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it('supplies the immutable base task and bounded revision instruction to the Planner', async () => {
    const client = modelClient([validTaskJson()])
    const service = new RpaPlannerService({ registry: createDefaultRpaModuleRegistry(), modelClient: client })

    await service.plan({
      goal: 'Open app',
      baseTask: { id: 'base-task', steps: [] },
      revisionInstruction: 'Wait before launching',
      deviceIds: []
    })

    const prompt = JSON.stringify(vi.mocked(client.complete).mock.calls[0][0].messages)
    expect(prompt).toContain('base-task')
    expect(prompt).toContain('Wait before launching')
  })

  it('generates a draft when no device is connected', async () => {
    const client = modelClient([validTaskJson().replace('["device-1"]', '[]')])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: [] })

    expect(result.success).toBe(true)
    expect(result.task?.deviceIds).toEqual([])
  })

  it('publishes separate action module and verification contracts to the model', async () => {
    const client = modelClient([validTaskJson()])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    await service.plan({ goal: 'open app', deviceIds: [] })

    const prompt = JSON.stringify(vi.mocked(client.complete).mock.calls[0][0].messages)
    expect(prompt).toContain('Every step MUST use the exact property name moduleId')
    expect(prompt).toContain('paramsJsonSchema')
    expect(prompt).toContain('packageName')
    expect(prompt).toContain('availableVerificationTypes')
    expect(prompt).toContain('vlm_assert is a step.verify.type and never a moduleId')
    expect(prompt).toContain('minConfidence')
    expect(prompt).toContain('Generate replay-safe workflows from a deterministic start state')
    expect(prompt).toContain('do not add navigation that depends on the screen observed before launch_app')
  })

  it('includes Role context in planning and persists it in generated DSL metadata', async () => {
    const client = modelClient([validTaskJson()])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })
    const selectedModel = { id: 'gpt-5', name: 'GPT-5', provider: 'provider-1', group: 'gpt' } as Model
    const primaryRole = {
      ...createDefaultRpaAppRole('primary-role', 'Primary Role', 1),
      status: 'enabled' as const,
      appPackages: ['com.example.app'],
      systemCapabilities: ['android.home'],
      assetBindings: [
        {
          ref: { roleId: 'primary-role', assetType: 'prompt' as const, assetId: 'planner-prompt', version: '1' },
          ownership: 'owned' as const,
          requirement: 'required' as const,
          enabled: true,
          priority: 10
        },
        {
          ref: { roleId: 'primary-role', assetType: 'prompt' as const, assetId: 'recovery-prompt', version: '1' },
          ownership: 'owned' as const,
          requirement: 'optional' as const,
          enabled: true,
          priority: 0
        }
      ]
    }
    const effectiveContext = resolveEffectiveRpaRoleContext({
      topicId: 'topic-1',
      primaryRole,
      compatibilityProfile: createDefaultRpaAssistantProfile('assistant-1', 1),
      catalogs: { knowledge: [], skills: [], templates: [] },
      promptCatalog: [
        {
          schemaVersion: 1,
          id: 'planner-prompt',
          roleId: 'primary-role',
          version: '1',
          kind: 'planner',
          content: 'Prefer deterministic navigation before visual navigation.',
          priority: 0,
          status: 'enabled',
          createdAt: 1,
          updatedAt: 1
        },
        {
          schemaVersion: 1,
          id: 'recovery-prompt',
          roleId: 'primary-role',
          version: '1',
          kind: 'recovery',
          content: 'Recovery-only instruction.',
          priority: 0,
          status: 'enabled',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      defaultModel: selectedModel,
      availableModels: [selectedModel]
    })

    const result = await service.plan({ goal: 'open app', deviceIds: [], effectiveContext })

    const prompt = JSON.stringify(vi.mocked(client.complete).mock.calls[0][0].messages)
    expect(prompt).toContain('primary-role')
    expect(prompt).toContain('android.home')
    expect(prompt).toContain('Prefer deterministic navigation before visual navigation.')
    expect(prompt).not.toContain('Recovery-only instruction.')
    expect(result.task?.metadata.rpaRoleContext).toEqual(effectiveContext.roleContext)
    const embeddedContext = result.task?.metadata.rpaModelContext as {
      schemaVersion: number
      rolePrompts: Array<{ id: string; version: string }>
      provenance: { callType: string }
    }
    expect(embeddedContext.schemaVersion).toBe(1)
    expect(embeddedContext.rolePrompts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'planner-prompt', version: '1' }),
        expect.objectContaining({ id: 'recovery-prompt', version: '1' })
      ])
    )
    expect(embeddedContext.provenance.callType).toBe('planner')
  })

  it('normalizes a known legacy module field before validation', async () => {
    const legacyTask = JSON.parse(validTaskJson())
    legacyTask.steps[0].module = legacyTask.steps[0].moduleId
    delete legacyTask.steps[0].moduleId
    const client = modelClient([JSON.stringify(legacyTask)])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: ['device-1'] })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(false)
    expect(result.task?.steps[0].moduleId).toBe('launch_app')
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it('derives foreground verification from a launch_app package when verification is missing', async () => {
    const taskWithoutVerification = JSON.parse(validTaskJson())
    delete taskWithoutVerification.steps[0].verify
    const client = modelClient([JSON.stringify(taskWithoutVerification)])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: ['device-1'] })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(false)
    expect(result.task?.steps[0].verify).toEqual({
      type: 'foreground_app',
      packageName: 'com.example.app'
    })
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it('rejects conflicting canonical and legacy module identifiers', async () => {
    const conflictingTask = JSON.parse(validTaskJson())
    conflictingTask.steps[0].module = 'screenshot'
    const response = JSON.stringify(conflictingTask)
    const client = modelClient([response, response])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: ['device-1'] })

    expect(result.success).toBe(false)
    expect(result.issues).toEqual([
      expect.objectContaining({ path: 'steps.0.moduleId', message: expect.stringContaining('Conflicting') })
    ])
  })

  it('injects reviewed SOP summaries into the Planner prompt', async () => {
    const client = modelClient([validTaskJson()])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({
      goal: 'open app',
      deviceIds: ['device-1'],
      knowledgeContext: {
        summaries: [
          {
            id: 'sop-1',
            category: 'app_sop',
            title: 'Open app SOP',
            summary: 'Dismiss the update prompt before continuing',
            confidence: 0.9,
            knowledgeBaseId: 'kb-1',
            templateIds: [],
            skills: []
          }
        ],
        conflicts: [],
        warnings: []
      }
    })

    const firstCall = vi.mocked(client.complete).mock.calls[0][0]
    expect(JSON.stringify(firstCall.messages)).toContain('Dismiss the update prompt before continuing')
    expect(result.task?.metadata.rpaKnowledgeReferences).toEqual([
      { id: 'sop-1', knowledgeBaseId: 'kb-1', category: 'app_sop' }
    ])
  })

  it('repairs invalid DSL once when validation fails', async () => {
    const selectedModel = {
      id: 'gpt-5.6-sol',
      name: 'gpt-5.6-sol',
      provider: 'timecho',
      group: 'gpt-5'
    } as Model
    const client = modelClient([
      JSON.stringify({
        id: 'task-1',
        name: 'Bad task',
        goal: 'bad',
        deviceIds: ['device-1'],
        metadata: {},
        steps: [{ id: 'step-1', name: 'Bad', moduleId: 'missing_module', params: {}, continueOnFailure: false }]
      }),
      validTaskJson()
    ])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: ['device-1'], model: selectedModel })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(true)
    expect(client.complete).toHaveBeenCalledTimes(2)
    expect(client.complete).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: selectedModel }))
    expect(client.complete).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: selectedModel }))
  })

  it('repairs malformed JSON before validating the DSL', async () => {
    const client = modelClient(['{{invalid json', validTaskJson()])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: ['device-1'] })

    expect(result.success).toBe(true)
    expect(result.repaired).toBe(true)
    expect(client.complete).toHaveBeenCalledTimes(2)
  })

  it('returns a terminal validation issue when repaired JSON is still malformed', async () => {
    const client = modelClient(['not json', 'still not json'])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client
    })

    const result = await service.plan({ goal: 'open app', deviceIds: ['device-1'] })

    expect(result.success).toBe(false)
    expect(result.repaired).toBe(true)
    expect(result.issues[0]).toEqual(expect.objectContaining({ path: '$' }))
    expect(result.issues[0].message).toContain('Invalid JSON')
  })

  it('does not use legacy Template recommendations as Planner assets', async () => {
    const taskWithUnavailableTemplate = JSON.stringify({
      ...JSON.parse(validTaskJson()),
      metadata: { rpaAssets: { templateId: 'blocked-template' } }
    })
    const client = modelClient([taskWithUnavailableTemplate, taskWithUnavailableTemplate])
    const service = new RpaPlannerService({ registry: createDefaultRpaModuleRegistry(), modelClient: client })

    const result = await service.plan({
      goal: 'open app',
      deviceIds: ['device-1'],
      assetContext: {
        assistantId: 'assistant-1',
        profileVersion: 2,
        knowledge: [],
        skills: [],
        templates: [],
        warnings: []
      }
    })

    expect(result.success).toBe(true)
  })

  it('compiles a matched Skill without calling the LLM', async () => {
    const registry = createDefaultRpaModuleRegistry()
    const repository = new RpaSkillRepository(new MemorySkillStorage(), registry)
    await repository.save({ definition: validSkill() })
    const client = modelClient([])
    const service = new RpaPlannerService({
      registry,
      modelClient: client,
      skillRepository: repository,
      skillCompiler: new RpaSkillCompiler(registry)
    })

    const result = await service.plan({
      goal: '请打开详情页面',
      deviceIds: ['device-1'],
      observations: [
        {
          deviceId: 'device-1',
          capturedAt: 1,
          foregroundApp: { packageName: 'com.example.app' },
          recognizedState: {
            stateId: 'HOME',
            label: 'Home',
            confidence: 0.9,
            blocking: false,
            blockingCondition: 'none',
            recoveryScope: 'none',
            suggestedTransitions: ['DETAIL'],
            evidence: [],
            reason: 'test',
            recognizedAt: 1
          },
          warnings: [],
          artifacts: {}
        }
      ],
      assetContext: {
        assistantId: 'assistant-1',
        profileVersion: 1,
        knowledge: [],
        skills: [{ id: 'open-example-detail', name: 'Open detail', version: '1.0.0', priority: 1 }],
        templates: [],
        warnings: []
      }
    })

    expect(result).toMatchObject({
      success: true,
      source: 'skill',
      matchedSkill: { id: 'open-example-detail', version: '1.0.0' }
    })
    expect(result.task?.metadata).toMatchObject({ rpaAssets: { skillIds: ['open-example-detail'] } })
    expect(client.complete).not.toHaveBeenCalled()
  })

  it('loads known failure fingerprints into planning context and task provenance', async () => {
    const client = modelClient([validTaskJson()])
    const findMatches = vi.fn().mockResolvedValue([
      {
        id: 'failure-1',
        key: 'key-1',
        failureClass: 'NO_PROGRESS',
        appPackage: 'com.example.app',
        taskGoalSummary: 'open app',
        stateId: 'HOME',
        failedRecoveryPolicyIds: ['builtin:navigate-back'],
        sourceRunIds: ['run-1'],
        sourceDeviceRunIds: ['device-run-1'],
        evidenceArtifactIds: [],
        occurrenceCount: 2,
        disposition: 'skip_failed_policy',
        status: 'active',
        firstSeenAt: 1,
        lastSeenAt: 2
      }
    ])
    const service = new RpaPlannerService({
      registry: createDefaultRpaModuleRegistry(),
      modelClient: client,
      failureFingerprintRepository: { findMatches } as unknown as RpaFailureFingerprintRepository
    })

    const result = await service.plan({
      goal: 'open app',
      deviceIds: ['device-1'],
      observations: [
        {
          deviceId: 'device-1',
          capturedAt: 1,
          foregroundApp: { packageName: 'com.example.app' },
          recognizedState: {
            stateId: 'HOME',
            label: 'Home',
            confidence: 1,
            blocking: false,
            blockingCondition: 'none',
            recoveryScope: 'none',
            suggestedTransitions: [],
            evidence: [],
            reason: 'home',
            recognizedAt: 1
          },
          warnings: [],
          artifacts: {}
        }
      ]
    })

    expect(findMatches).toHaveBeenCalledWith({
      appPackage: 'com.example.app',
      taskGoal: 'open app',
      stateId: 'HOME'
    })
    expect(result.task?.metadata).toMatchObject({ knownFailureFingerprintIds: ['failure-1'] })
    expect(JSON.stringify(vi.mocked(client.complete).mock.calls[0][0].messages)).toContain('skip_failed_policy')
  })
})
