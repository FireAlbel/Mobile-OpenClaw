import { describe, expect, it, vi } from 'vitest'

import { RpaAppStateNormalizationService } from '../RpaAppStateNormalizationService'
import type { RpaDeviceObservation, RpaDeviceRuntime, RpaUiNode } from '../RpaTypes'

const bounds = {
  physical: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, centerX: 50, centerY: 50 }
}

function observation(packageName: string, activity: string, text: string): RpaDeviceObservation {
  const node: RpaUiNode = {
    id: text,
    text,
    resourceId: '',
    className: 'android.widget.TextView',
    packageName,
    contentDescription: '',
    clickable: false,
    enabled: true,
    selected: false,
    scrollable: false,
    bounds
  }
  return {
    deviceId: 'device-1',
    capturedAt: Date.now(),
    screenshot: { imageBase64: text, width: 100, height: 100 },
    foregroundApp: { packageName, activity },
    screenSize: { width: 100, height: 100 },
    uiTree: { xml: `<node text="${text}" />`, nodes: [node], texts: [text], capturedAt: Date.now() },
    warnings: [],
    artifacts: {}
  }
}

function runtime(overrides: Partial<RpaDeviceRuntime> = {}): RpaDeviceRuntime {
  const success = (message: string) => ({ success: true, message, startedAt: 1, finishedAt: 2 })
  return {
    screenshot: vi.fn(),
    tap: vi.fn(),
    swipe: vi.fn(),
    key: vi.fn().mockResolvedValue(success('key ok')),
    startApp: vi.fn().mockResolvedValue(success('start ok')),
    stopApp: vi.fn().mockResolvedValue(success('stop ok')),
    softRelaunchApp: vi.fn().mockResolvedValue(success('soft relaunch ok')),
    hardRestartApp: vi.fn().mockResolvedValue(success('hard restart ok')),
    getForegroundApp: vi.fn(),
    getScreenSize: vi.fn(),
    handlePermissionDialog: vi.fn().mockResolvedValue(success('permission ok')),
    visionInstruction: vi.fn(),
    locateVisualTarget: vi.fn(),
    executeCorrectionAction: vi.fn(),
    ...overrides
  } as RpaDeviceRuntime
}

const profile = {
  appPackage: 'com.example.app',
  states: [
    {
      stateId: 'HOME',
      packageNames: ['com.example.app'],
      activityIncludes: ['MainActivity'],
      requiredTexts: ['首页'],
      recoveryScope: 'none' as const
    },
    {
      stateId: 'DETAIL',
      packageNames: ['com.example.app'],
      activityIncludes: ['DetailActivity'],
      requiredTexts: ['详情'],
      recoveryScope: 'navigate' as const
    },
    {
      stateId: 'LOGIN_REQUIRED',
      packageNames: ['com.example.app'],
      requiredTexts: ['AUTH_LOCK'],
      blockingCondition: 'authentication' as const,
      recoveryScope: 'human' as const
    }
  ]
}

function serviceWithObservations(testRuntime: RpaDeviceRuntime, observations: RpaDeviceObservation[]) {
  let last = observations.at(-1)!
  const capture = vi.fn(async () => {
    last = observations.shift() ?? last
    return last
  })
  return {
    capture,
    service: new RpaAppStateNormalizationService(testRuntime, {
      observationService: { capture } as never,
      delay: async () => undefined,
      playbooks: { resolve: async () => undefined, toProfile: vi.fn(), findPath: vi.fn() } as never
    })
  }
}

describe('RpaAppStateNormalizationService', () => {
  it('returns idempotent success without touching the device when already home', async () => {
    const testRuntime = runtime()
    const { service } = serviceWithObservations(testRuntime, [observation('com.example.app', 'MainActivity', '首页')])

    const result = await service.normalize({
      deviceId: 'device-1',
      packageName: 'com.example.app',
      targetState: 'home',
      profile,
      policy: { stabilityWindowMs: 0 }
    })

    expect(result.outcome).toBe('goal_achieved')
    expect(result.actionGroups).toEqual([])
    expect(testRuntime.key).not.toHaveBeenCalled()
    expect(testRuntime.softRelaunchApp).not.toHaveBeenCalled()
  })

  it('accepts a foreground root activity as a generic home state without a Playbook', async () => {
    const testRuntime = runtime()
    const { service } = serviceWithObservations(testRuntime, [
      observation('com.android.settings', 'com.android.settings/.Settings', 'Settings')
    ])

    const result = await service.normalize({
      deviceId: 'device-1',
      packageName: 'com.android.settings',
      targetState: 'home',
      policy: { stabilityWindowMs: 0 }
    })

    expect(result.outcome).toBe('goal_achieved')
    expect(result.actionGroups).toEqual([])
    expect(testRuntime.key).not.toHaveBeenCalled()
    expect(testRuntime.hardRestartApp).not.toHaveBeenCalled()
  })

  it('verifies after each bounded Back and stops as soon as home is reached', async () => {
    const testRuntime = runtime()
    const { service, capture } = serviceWithObservations(testRuntime, [
      observation('com.example.app', 'DetailActivity', '详情'),
      observation('com.example.app', 'MainActivity', '首页')
    ])

    const result = await service.normalize({
      deviceId: 'device-1',
      packageName: 'com.example.app',
      targetState: 'home',
      profile,
      policy: { stages: ['bounded_back'], maxBackCount: 3, stabilityWindowMs: 0 }
    })

    expect(result.outcome).toBe('goal_achieved')
    expect(testRuntime.key).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(result.actionGroups[0].verification?.status).toBe('passed')
  })

  it('pauses immediately on protected authentication state', async () => {
    const testRuntime = runtime()
    const { service } = serviceWithObservations(testRuntime, [
      observation('com.example.app', 'LoginActivity', 'AUTH_LOCK')
    ])

    const result = await service.normalize({
      deviceId: 'device-1',
      packageName: 'com.example.app',
      targetState: 'home',
      profile,
      policy: { stabilityWindowMs: 0 }
    })

    expect(result.outcome).toBe('human_required')
    expect(result.status).toBe('needs_human')
    expect(testRuntime.key).not.toHaveBeenCalled()
    expect(testRuntime.hardRestartApp).not.toHaveBeenCalled()
  })

  it('brings a background app forward and verifies its foreground package', async () => {
    const testRuntime = runtime()
    const { service } = serviceWithObservations(testRuntime, [
      observation('com.android.launcher', 'Launcher', 'Launcher'),
      observation('com.example.app', 'MainActivity', '首页')
    ])

    const result = await service.normalize({
      deviceId: 'device-1',
      packageName: 'com.example.app',
      targetState: 'foreground',
      profile,
      policy: { stages: ['soft_relaunch'], stabilityWindowMs: 0 }
    })

    expect(result.outcome).toBe('goal_achieved')
    expect(testRuntime.softRelaunchApp).toHaveBeenCalledWith('device-1', 'com.example.app')
  })
})
