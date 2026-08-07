import { describe, expect, it, vi } from 'vitest'

import type { RpaModelClient } from '../RpaModelClient'
import { buildRpaModelContext, createEmbeddedRpaModelContext } from '../RpaModelContextBuilder'
import type { RpaDeviceRuntime, RpaModuleResult } from '../RpaTypes'
import { RpaVerificationEngine } from '../RpaVerificationEngine'

function runtime(overrides: Partial<RpaDeviceRuntime> = {}): RpaDeviceRuntime {
  return {
    screenshot: vi.fn().mockResolvedValue({
      success: true,
      message: 'screenshot ok',
      data: { imageBase64: 'png', mime: 'image/png', width: 1080, height: 2400 }
    }),
    tap: vi.fn(),
    swipe: vi.fn(),
    key: vi.fn(),
    startApp: vi.fn(),
    getForegroundApp: vi.fn().mockResolvedValue({
      success: true,
      message: 'foreground ok',
      data: { packageName: 'com.example.app' }
    }),
    getScreenSize: vi.fn().mockResolvedValue({
      success: true,
      message: 'screen size',
      data: { width: 1080, height: 2400 }
    }),
    handlePermissionDialog: vi.fn(),
    visionInstruction: vi.fn(),
    locateVisualTarget: vi.fn(),
    ...overrides
  } as RpaDeviceRuntime
}

const successResult: RpaModuleResult = {
  success: true,
  status: 'passed',
  message: 'module ok',
  startedAt: 1,
  finishedAt: 2
}

describe('RpaVerificationEngine', () => {
  it('passes module result verification when the module succeeds', async () => {
    const engine = new RpaVerificationEngine({ runtime: runtime() })

    const result = await engine.verify({ type: 'module_result_success' }, successResult, 'device-1')

    expect(result.status).toBe('passed')
  })

  it('verifies foreground app with observation data', async () => {
    const engine = new RpaVerificationEngine({ runtime: runtime() })

    const result = await engine.verify(
      { type: 'foreground_app', packageName: 'com.example.app', settleMs: 0 },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('passed')
    expect(result.confidence).toBe(1)
  })

  it('verifies a semantic app state without invoking VLM', async () => {
    const testRuntime = runtime({
      getUiTree: vi.fn().mockResolvedValue({
        success: true,
        message: 'ui tree ok',
        data: '<hierarchy><node text="Home" content-desc="" resource-id="home" class="android.widget.TextView" package="com.example.app" clickable="false" enabled="true" bounds="[0,0][500,100]" /></hierarchy>'
      })
    })
    const engine = new RpaVerificationEngine({ runtime: testRuntime })

    const result = await engine.verify(
      {
        type: 'app_state',
        packageName: 'com.example.app',
        stateId: 'HOME',
        activityIncludes: [],
        requiredTexts: ['Home'],
        anyTexts: [],
        minConfidence: 0.7
      },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('passed')
    expect(result.evidence).toMatchObject({ recognized: { stateId: 'HOME' } })
  })

  it('includes foreground observation warning when foreground app is unavailable', async () => {
    const engine = new RpaVerificationEngine({
      runtime: runtime({
        getForegroundApp: vi.fn().mockResolvedValue({
          success: false,
          message: 'Unable to parse foreground app'
        })
      })
    })

    const result = await engine.verify(
      {
        type: 'foreground_app',
        packageName: 'com.example.app',
        settleMs: 0,
        timeoutMs: 100,
        pollIntervalMs: 50
      },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('uncertain')
    expect(result.message).toContain('Unable to parse foreground app')
  })

  it('waits through an OEM launcher redirect before passing foreground verification', async () => {
    const getForegroundApp = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        message: 'foreground ok',
        data: { packageName: 'com.oplus.multiapp', activity: '.ui.settings.ActivitySettingsActivity' }
      })
      .mockResolvedValueOnce({
        success: true,
        message: 'foreground ok',
        data: { packageName: 'com.oplus.multiapp', activity: '.ui.entry.ActivityMainActivity' }
      })
      .mockResolvedValue({
        success: true,
        message: 'foreground ok',
        data: { packageName: 'com.android.settings', activity: '.Settings' }
      })
    const engine = new RpaVerificationEngine({ runtime: runtime({ getForegroundApp }) })

    const result = await engine.verify(
      {
        type: 'foreground_app',
        packageName: 'com.android.settings',
        settleMs: 0,
        timeoutMs: 500,
        pollIntervalMs: 50
      },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('passed')
    expect(getForegroundApp).toHaveBeenCalledTimes(3)
    expect(result.evidence).toMatchObject({
      observations: [
        { packageName: 'com.oplus.multiapp' },
        { packageName: 'com.oplus.multiapp' },
        { packageName: 'com.android.settings' }
      ]
    })
  })

  it('marks missing observation screenshot as uncertain', async () => {
    const engine = new RpaVerificationEngine({
      runtime: runtime({
        screenshot: vi.fn().mockResolvedValue({ success: false, message: 'missing screenshot' })
      })
    })

    const result = await engine.verify({ type: 'observation_has_screenshot' }, successResult, 'device-1')

    expect(result.status).toBe('uncertain')
  })

  it('fails a VLM business assertion when the expected screen state is absent', async () => {
    const complete = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ passed: false, confidence: 0.96, reason: 'The task list is not visible' }))
    const engine = new RpaVerificationEngine({
      runtime: runtime(),
      modelClient: { complete } as RpaModelClient
    })

    const result = await engine.verify(
      { type: 'vlm_assert', expectation: 'The coin task list is visible', minConfidence: 0.7, settleMs: 0 },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('failed')
    expect(result.confidence).toBe(0.96)
    expect(complete).toHaveBeenCalledOnce()
  })

  it('marks a low-confidence VLM assertion as uncertain', async () => {
    const engine = new RpaVerificationEngine({
      runtime: runtime(),
      modelClient: {
        complete: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify({ passed: true, confidence: 0.4, reason: 'The screen is partially obscured' })
          )
      } as RpaModelClient
    })

    const result = await engine.verify(
      { type: 'vlm_assert', expectation: 'The reward was credited', minConfidence: 0.7, settleMs: 0 },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('uncertain')
  })

  it('repairs a prose-only assertion once and applies only verification Role prompts', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce('The screen looks correct.')
      .mockResolvedValueOnce(JSON.stringify({ passed: true, confidence: 0.91, reason: 'Task result is visible' }))
    const modelContext = createEmbeddedRpaModelContext(
      buildRpaModelContext({
        callType: 'planner',
        rolePrompts: [
          {
            schemaVersion: 1,
            id: 'verify-prompt',
            roleId: 'role-1',
            version: '1',
            kind: 'verification',
            content: 'Check the final business state, not the previous action.',
            priority: 1,
            status: 'enabled',
            createdAt: 1,
            updatedAt: 1
          },
          {
            schemaVersion: 1,
            id: 'recovery-prompt',
            roleId: 'role-1',
            version: '1',
            kind: 'recovery',
            content: 'Recovery-only guidance.',
            priority: 0,
            status: 'enabled',
            createdAt: 1,
            updatedAt: 1
          },
          {
            schemaVersion: 1,
            id: 'home-capability',
            roleId: 'role-1',
            version: '1',
            kind: 'capability',
            capability: 'android.home',
            content: 'Recognize the launcher as a valid Home state.',
            priority: 0,
            status: 'enabled',
            createdAt: 1,
            updatedAt: 1
          }
        ],
        systemCapabilities: ['android.home']
      })
    )
    const engine = new RpaVerificationEngine({ runtime: runtime(), modelClient: { complete } as RpaModelClient })

    const result = await engine.verify(
      { type: 'vlm_assert', expectation: 'The task is complete', minConfidence: 0.7, settleMs: 0 },
      successResult,
      'device-1',
      undefined,
      undefined,
      modelContext
    )

    expect(result.status).toBe('passed')
    expect(complete).toHaveBeenCalledTimes(2)
    const messages = JSON.stringify(complete.mock.calls)
    expect(messages).toContain('Check the final business state, not the previous action.')
    expect(messages).toContain('Recognize the launcher as a valid Home state.')
    expect(messages).not.toContain('Recovery-only guidance.')
  })

  it('includes bounded Role knowledge in VLM verification context', async () => {
    const complete = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ passed: true, confidence: 0.92, reason: 'Expected page is visible' }))
    const engine = new RpaVerificationEngine({ runtime: runtime(), modelClient: { complete } as RpaModelClient })

    const result = await engine.verify(
      { type: 'vlm_assert', expectation: 'The expected page is visible', minConfidence: 0.7, settleMs: 0 },
      successResult,
      'device-1',
      undefined,
      undefined,
      undefined,
      {
        summaries: [
          {
            id: 'knowledge-1',
            category: 'page_state_explanation',
            title: 'Expected page signals',
            summary: 'The page is valid only when the device name and Android version are visible.',
            confidence: 0.95,
            knowledgeBaseId: 'kb-1',
            templateIds: [],
            skills: []
          }
        ],
        conflicts: [],
        warnings: []
      }
    )

    expect(result.status).toBe('passed')
    expect(JSON.stringify(complete.mock.calls[0][0].messages)).toContain(
      'The page is valid only when the device name and Android version are visible.'
    )
  })

  it('verifies text through the UI tree without invoking VLM', async () => {
    const testRuntime = runtime({
      getUiTree: vi.fn().mockResolvedValue({
        success: true,
        message: 'ui tree ok',
        data: '<hierarchy><node text="任务列表" content-desc="" resource-id="task-list" class="android.widget.TextView" package="app" clickable="false" enabled="true" bounds="[0,0][500,100]" /></hierarchy>'
      })
    })
    const engine = new RpaVerificationEngine({ runtime: testRuntime })

    const result = await engine.verify(
      { type: 'text_present', text: '任务列表', source: 'ui_tree', exact: true, minConfidence: 0.5 },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('passed')
    expect(testRuntime.getUiTree).toHaveBeenCalledOnce()
  })

  it('converts a VLM request error into an uncertain verification result', async () => {
    const engine = new RpaVerificationEngine({
      runtime: runtime(),
      modelClient: {
        complete: vi.fn().mockRejectedValue(new Error('model unavailable'))
      } as RpaModelClient
    })

    const result = await engine.verify(
      { type: 'vlm_assert', expectation: 'The reward was credited', minConfidence: 0.7, settleMs: 0 },
      successResult,
      'device-1'
    )

    expect(result.status).toBe('uncertain')
    expect(result.message).toContain('model unavailable')
  })

  it('forces a visual assertion after a correction action group', async () => {
    const complete = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ passed: true, confidence: 0.97, reason: 'The popup is gone' }))
    const engine = new RpaVerificationEngine({
      runtime: runtime(),
      modelClient: { complete } as RpaModelClient
    })

    const result = await engine.verifyCorrection({
      deviceId: 'device-1',
      expectation: 'The popup is gone',
      actionResults: [successResult],
      settleMs: 0
    })

    expect(result.status).toBe('passed')
    expect(complete).toHaveBeenCalledOnce()
    expect(result.evidence).toMatchObject({ actionResults: [successResult] })
  })
})
