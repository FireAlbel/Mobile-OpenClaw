import { describe, expect, it, vi } from 'vitest'

import {
  handlePopupModule,
  listScanTargetModule,
  swipeUntilVlmTargetModule,
  tapByVlmTargetModule
} from '../RpaP1Modules'
import type { RpaDeviceRuntime, RpaTask } from '../RpaTypes'

const visionModel = {
  id: 'qwen-vl-max',
  provider: 'qwen',
  name: 'Qwen VL Max',
  group: 'qwen'
}

function runtime(overrides: Partial<RpaDeviceRuntime> = {}): RpaDeviceRuntime {
  return {
    screenshot: vi.fn(),
    tap: vi.fn(),
    swipe: vi.fn(),
    key: vi.fn(),
    startApp: vi.fn(),
    getForegroundApp: vi.fn(),
    getScreenSize: vi.fn().mockResolvedValue({
      success: true,
      message: 'screen size',
      data: { width: 1080, height: 2400 }
    }),
    handlePermissionDialog: vi.fn().mockResolvedValue({
      success: true,
      message: 'handled',
      data: true
    }),
    visionInstruction: vi.fn().mockResolvedValue({
      success: true,
      message: 'vision ok',
      data: { action: 'tap' }
    }),
    locateVisualTarget: vi.fn().mockResolvedValue({
      success: true,
      message: 'target found',
      data: { found: true, confidence: 0.95, reason: 'visible' }
    }),
    ...overrides
  } as RpaDeviceRuntime
}

function context(testRuntime: RpaDeviceRuntime) {
  return {
    deviceId: 'device-1',
    task: {
      id: 'task',
      name: 'task',
      goal: 'goal',
      deviceIds: ['device-1'],
      steps: [],
      visionModel,
      metadata: {}
    } as RpaTask,
    step: {
      id: 'step',
      name: 'step',
      moduleId: 'module',
      params: {},
      continueOnFailure: false
    },
    attempt: 1,
    runtime: testRuntime
  }
}

describe('RpaP1Modules', () => {
  it('handles permission popups through runtime', async () => {
    const testRuntime = runtime()

    const result = await handlePopupModule.execute(context(testRuntime), { action: 'allow', required: false })

    expect(result.success).toBe(true)
    expect(testRuntime.handlePermissionDialog).toHaveBeenCalledWith('device-1', 'allow')
  })

  it('requests human intervention when a required popup is missing', async () => {
    const testRuntime = runtime({
      handlePermissionDialog: vi.fn().mockResolvedValue({ success: true, message: 'not found', data: false })
    })

    const result = await handlePopupModule.execute(context(testRuntime), { action: 'allow', required: true })

    expect(result.status).toBe('needs_human')
  })

  it('delegates tap target selection to VLM with tap-only action', async () => {
    const testRuntime = runtime()

    const result = await tapByVlmTargetModule.execute(context(testRuntime), { target: 'coin icon' })

    expect(result.success).toBe(true)
    expect(testRuntime.visionInstruction).toHaveBeenCalledWith(
      'device-1',
      'Find and tap this visual target: coin icon',
      ['tap'],
      visionModel,
      undefined
    )
  })

  it('taps an exact UI tree alias before invoking the VLM', async () => {
    const testRuntime = runtime({
      getUiTree: vi.fn().mockResolvedValue({
        success: true,
        message: 'ui tree ok',
        data: '<hierarchy><node text="关于本机" clickable="true" enabled="true" bounds="[100,1800][900,1940]" /></hierarchy>'
      }),
      tap: vi.fn().mockResolvedValue({ success: true, message: 'tapped' })
    })

    const result = await tapByVlmTargetModule.execute(context(testRuntime), {
      target: '“关于本机”“关于手机”“关于设备”“About phone”“About device”或“设备信息”等设备信息入口'
    })

    expect(result).toMatchObject({ success: true, message: 'Deterministic text target tapped: 关于本机' })
    expect(testRuntime.tap).toHaveBeenCalledWith('device-1', 500, 1870, {
      randomRadiusPx: 7,
      safeInsetPx: 2
    })
    expect(testRuntime.screenshot).not.toHaveBeenCalled()
    expect(testRuntime.visionInstruction).not.toHaveBeenCalled()
  })

  it('falls back to the VLM when no UI tree alias is visible', async () => {
    const testRuntime = runtime({
      getUiTree: vi.fn().mockResolvedValue({
        success: true,
        message: 'ui tree ok',
        data: '<hierarchy><node text="系统与更新" clickable="true" enabled="true" bounds="[100,1800][900,1940]" /></hierarchy>'
      })
    })

    const result = await tapByVlmTargetModule.execute(context(testRuntime), {
      target: '“关于本机”“About phone”或“设备信息”'
    })

    expect(result.success).toBe(true)
    expect(testRuntime.tap).not.toHaveBeenCalled()
    expect(testRuntime.visionInstruction).toHaveBeenCalledOnce()
  })

  it('fails deterministically without invoking the VLM when fallback is disabled', async () => {
    const testRuntime = runtime({
      getUiTree: vi.fn().mockResolvedValue({
        success: true,
        message: 'ui tree ok',
        data: '<hierarchy><node text="System update" bounds="[0,0][100,100]" /></hierarchy>'
      })
    })

    const result = await tapByVlmTargetModule.execute(context(testRuntime), {
      target: 'About phone',
      fallbackToVlm: false
    })

    expect(result).toMatchObject({ success: false, message: 'Deterministic text target not found: About phone' })
    expect(testRuntime.visionInstruction).not.toHaveBeenCalled()
  })

  it('finds a swipe target through the UI tree without invoking the VLM', async () => {
    const testRuntime = runtime({
      getUiTree: vi.fn().mockResolvedValue({
        success: true,
        message: 'ui tree ok',
        data: '<hierarchy><node text="About phone" bounds="[100,1800][900,1940]" /></hierarchy>'
      })
    })

    const result = await swipeUntilVlmTargetModule.execute(context(testRuntime), {
      target: 'About phone',
      fallbackToVlm: false
    })

    expect(result).toMatchObject({ success: true, message: 'Deterministic text target found: About phone' })
    expect(testRuntime.locateVisualTarget).not.toHaveBeenCalled()
    expect(testRuntime.swipe).not.toHaveBeenCalled()
  })

  it('runs bounded VLM swipe attempts', async () => {
    const locateVisualTarget = vi
      .fn()
      .mockResolvedValueOnce({
        success: true,
        message: 'not found',
        data: { found: false, confidence: 0.9, reason: 'not visible' }
      })
      .mockResolvedValueOnce({
        success: true,
        message: 'found',
        data: { found: true, confidence: 0.95, reason: 'visible' }
      })
    const testRuntime = runtime({
      locateVisualTarget,
      swipe: vi.fn().mockResolvedValue({ success: true, message: 'swiped' })
    })

    const result = await swipeUntilVlmTargetModule.execute(context(testRuntime), {
      target: 'task card',
      direction: 'up',
      maxAttempts: 2
    })

    expect(result.success).toBe(true)
    expect(locateVisualTarget).toHaveBeenCalledTimes(2)
    expect(testRuntime.swipe).toHaveBeenCalledTimes(1)
  })

  it('fails when the target is still missing after bounded search', async () => {
    const testRuntime = runtime({
      locateVisualTarget: vi.fn().mockResolvedValue({
        success: true,
        message: 'not found',
        data: { found: false, confidence: 0.9, reason: 'not visible' }
      }),
      swipe: vi.fn().mockResolvedValue({ success: true, message: 'swiped' })
    })

    const result = await swipeUntilVlmTargetModule.execute(context(testRuntime), {
      target: 'task card',
      direction: 'up',
      maxAttempts: 2
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('not found after 2 attempts')
  })

  it('preserves vision requests that need human intervention', async () => {
    const testRuntime = runtime({
      visionInstruction: vi.fn().mockResolvedValue({
        success: false,
        message: 'VLM output could not be corrected',
        data: { needsHuman: true, rawResponse: 'invalid' }
      })
    })

    const result = await tapByVlmTargetModule.execute(context(testRuntime), { target: 'coin icon' })

    expect(result.status).toBe('needs_human')
  })

  it('resets to a boundary and scans deterministically before invoking the VLM', async () => {
    const tree = (text: string) =>
      `<hierarchy><node text="${text}" scrollable="true" bounds="[0,200][1080,2200]" /></hierarchy>`
    const getUiTree = vi
      .fn()
      .mockResolvedValueOnce({ success: true, message: 'mid', data: tree('应用管理') })
      .mockResolvedValueOnce({ success: true, message: 'top', data: tree('设置') })
      .mockResolvedValueOnce({ success: true, message: 'top', data: tree('设置') })
      .mockResolvedValueOnce({ success: true, message: 'top', data: tree('设置') })
      .mockResolvedValueOnce({ success: true, message: 'lower', data: tree('系统与更新') })
      .mockResolvedValueOnce({ success: true, message: 'target', data: tree('关于本机') })
    const testRuntime = runtime({
      getUiTree,
      swipe: vi.fn().mockResolvedValue({ success: true, message: 'swiped' })
    })

    const result = await listScanTargetModule.execute(context(testRuntime), {
      target: '关于本机',
      targetAliases: ['关于手机'],
      resetToBoundary: true,
      resetDirection: 'down',
      scanDirection: 'up',
      maxResetSwipes: 3,
      maxScanSwipes: 3,
      noProgressLimit: 2,
      fallbackToVlm: true
    })

    expect(result).toMatchObject({
      success: true,
      data: { resetBoundaryReached: true, matchedText: '关于本机', vlmInvoked: false }
    })
    expect(testRuntime.swipe).toHaveBeenCalledTimes(5)
    expect(testRuntime.locateVisualTarget).not.toHaveBeenCalled()
  })

  it('uses one compact VLM fallback only after deterministic scan is exhausted', async () => {
    const tree = '<hierarchy><node text="设置" scrollable="true" bounds="[0,200][1080,2200]" /></hierarchy>'
    const testRuntime = runtime({
      getUiTree: vi.fn().mockResolvedValue({ success: true, message: 'same', data: tree }),
      swipe: vi.fn().mockResolvedValue({ success: true, message: 'swiped' }),
      locateVisualTarget: vi.fn().mockResolvedValue({
        success: true,
        message: 'not visible',
        data: { found: false, confidence: 0.95, reason: 'not visible' }
      })
    })

    const result = await listScanTargetModule.execute(context(testRuntime), {
      target: '关于本机',
      maxResetSwipes: 1,
      maxScanSwipes: 1,
      noProgressLimit: 1,
      fallbackToVlm: true
    })

    expect(result).toMatchObject({ success: false, data: { vlmInvoked: true } })
    expect(testRuntime.locateVisualTarget).toHaveBeenCalledTimes(1)
    expect(testRuntime.locateVisualTarget).toHaveBeenCalledWith(
      'device-1',
      expect.stringContaining('Deterministic coverage:'),
      visionModel,
      undefined
    )
  })
})
