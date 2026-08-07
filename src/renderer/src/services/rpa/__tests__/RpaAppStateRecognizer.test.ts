import { describe, expect, it, vi } from 'vitest'

import { RpaAppStateRecognizer } from '../RpaAppStateRecognizer'
import type { RpaArtifactStore } from '../RpaArtifactStore'
import type { RpaAppStateProfile, RpaDeviceObservation } from '../RpaTypes'

function observation(overrides: Partial<RpaDeviceObservation> = {}): RpaDeviceObservation {
  return {
    deviceId: 'device-1',
    capturedAt: 1,
    screenshot: { imageBase64: 'png', mime: 'image/png' },
    foregroundApp: { packageName: 'com.example.app', activity: '.MainActivity' },
    uiTree: {
      xml: '<hierarchy />',
      capturedAt: 1,
      texts: ['首页', '推荐'],
      nodes: [
        {
          id: 'node-1',
          text: '首页',
          resourceId: 'home',
          className: 'android.widget.TextView',
          packageName: 'com.example.app',
          contentDescription: '',
          clickable: true,
          enabled: true,
          selected: true,
          scrollable: false,
          bounds: {
            physical: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, centerX: 50, centerY: 50 }
          }
        }
      ]
    },
    warnings: [],
    artifacts: {},
    ...overrides
  }
}

function profile(states: RpaAppStateProfile['states']): RpaAppStateProfile {
  return { appPackage: 'com.example.app', states }
}

describe('RpaAppStateRecognizer', () => {
  it('recognizes a configured state from package, activity, and UI text evidence', async () => {
    const recognizer = new RpaAppStateRecognizer({ now: () => 10 })

    const result = await recognizer.recognize({
      observation: observation(),
      expectedStateId: 'HOME',
      profile: profile([
        {
          stateId: 'HOME',
          packageNames: ['com.example.app'],
          activityIncludes: ['MainActivity'],
          anyTexts: ['首页'],
          suggestedTransitions: ['SEARCH']
        }
      ])
    })

    expect(result).toMatchObject({
      stateId: 'HOME',
      blocking: false,
      recoveryScope: 'none',
      suggestedTransitions: ['SEARCH'],
      recognizedAt: 10
    })
    expect(result.confidence).toBeGreaterThan(0.8)
  })

  it('falls back to foreground package and activity when screenshot is missing', async () => {
    const recognizer = new RpaAppStateRecognizer()

    const result = await recognizer.recognize({
      observation: observation({ screenshot: undefined, uiTree: undefined }),
      profile: profile([{ stateId: 'DETAIL', packageNames: ['com.example.app'], activityIncludes: ['MainActivity'] }])
    })

    expect(result.stateId).toBe('DETAIL')
    expect(result.confidence).toBe(0.55)
  })

  it('classifies permission and popup blockers before ordinary app states', async () => {
    const recognizer = new RpaAppStateRecognizer()
    const permission = observation({
      foregroundApp: { packageName: 'com.android.permissioncontroller', activity: '.GrantPermissionsActivity' },
      uiTree: {
        ...observation().uiTree!,
        texts: ['仅在使用时允许'],
        nodes: [{ ...observation().uiTree!.nodes[0], text: '仅在使用时允许' }]
      }
    })

    const permissionResult = await recognizer.recognize({ observation: permission })
    const popupResult = await recognizer.recognize({
      observation: observation({
        uiTree: {
          ...observation().uiTree!,
          texts: ['稍后再说'],
          nodes: [{ ...observation().uiTree!.nodes[0], text: '稍后再说' }]
        }
      })
    })

    expect(permissionResult).toMatchObject({
      stateId: 'PERMISSION_DIALOG',
      blocking: true,
      blockingCondition: 'permission_dialog',
      recoveryScope: 'dismiss_overlay'
    })
    expect(popupResult).toMatchObject({ stateId: 'BLOCKED_BY_POPUP', blockingCondition: 'popup' })
  })

  it('routes payment and account security states to human recovery', async () => {
    const recognizer = new RpaAppStateRecognizer()
    const payment = await recognizer.recognize({
      observation: observation({
        uiTree: {
          ...observation().uiTree!,
          texts: ['Confirm payment'],
          nodes: [{ ...observation().uiTree!.nodes[0], text: 'Confirm payment' }]
        }
      })
    })
    const security = await recognizer.recognize({
      observation: observation({
        uiTree: {
          ...observation().uiTree!,
          texts: ['Verify your identity'],
          nodes: [{ ...observation().uiTree!.nodes[0], text: 'Verify your identity' }]
        }
      })
    })

    expect(payment).toMatchObject({ stateId: 'PAYMENT', blockingCondition: 'payment', recoveryScope: 'human' })
    expect(security).toMatchObject({
      stateId: 'ACCOUNT_SECURITY',
      blockingCondition: 'account_security',
      recoveryScope: 'human'
    })
  })

  it('does not treat a settings label containing login as an authentication screen', async () => {
    const recognizer = new RpaAppStateRecognizer()
    const result = await recognizer.recognize({
      observation: observation({
        foregroundApp: { packageName: 'com.android.settings', activity: '.Settings' },
        uiTree: {
          ...observation().uiTree!,
          texts: ['密码与安全', '登录信息自动填充服务'],
          nodes: [
            { ...observation().uiTree!.nodes[0], text: '密码与安全' },
            { ...observation().uiTree!.nodes[0], id: 'autofill', text: '登录信息自动填充服务' }
          ]
        }
      })
    })

    expect(result.stateId).not.toBe('LOGIN')
    expect(result.blockingCondition).not.toBe('authentication')
  })

  it('still recognizes an explicit standalone login action', async () => {
    const recognizer = new RpaAppStateRecognizer()
    const result = await recognizer.recognize({
      observation: observation({
        uiTree: {
          ...observation().uiTree!,
          texts: ['登录'],
          nodes: [{ ...observation().uiTree!.nodes[0], text: '登录' }]
        }
      })
    })

    expect(result).toMatchObject({ stateId: 'LOGIN', blockingCondition: 'authentication', recoveryScope: 'human' })
  })

  it('does not treat a generic settings close label as a popup blocker', async () => {
    const recognizer = new RpaAppStateRecognizer()
    const result = await recognizer.recognize({
      observation: observation({
        foregroundApp: { packageName: 'com.android.settings', activity: '.Settings' },
        uiTree: {
          ...observation().uiTree!,
          texts: ['关闭'],
          nodes: [{ ...observation().uiTree!.nodes[0], text: '关闭' }]
        }
      })
    })

    expect(result.stateId).not.toBe('BLOCKED_BY_POPUP')
    expect(result.blockingCondition).not.toBe('popup')
  })

  it.each(['取消', 'cancel', 'close'])('does not treat a standalone %s action as a popup blocker', async (label) => {
    const recognizer = new RpaAppStateRecognizer()
    const result = await recognizer.recognize({
      observation: observation({
        uiTree: {
          ...observation().uiTree!,
          texts: [label],
          nodes: [{ ...observation().uiTree!.nodes[0], text: label }]
        }
      })
    })

    expect(result.stateId).not.toBe('BLOCKED_BY_POPUP')
  })

  it('returns UNKNOWN for low confidence and conflicting evidence', async () => {
    const recognizer = new RpaAppStateRecognizer()
    const lowConfidence = await recognizer.recognize({
      observation: observation({ uiTree: undefined }),
      profile: profile([{ stateId: 'HOME', packageNames: ['com.example.app'] }])
    })
    const conflicting = await recognizer.recognize({
      observation: observation(),
      profile: profile([
        { stateId: 'HOME', packageNames: ['com.example.app'], anyTexts: ['首页'] },
        { stateId: 'PROFILE', packageNames: ['com.example.app'], anyTexts: ['首页'] }
      ])
    })

    expect(lowConfidence).toMatchObject({ stateId: 'UNKNOWN', candidateStateId: 'HOME', blocking: true })
    expect(conflicting.stateId).toBe('UNKNOWN')
    expect(conflicting.reason).toContain('Conflicting state evidence')
  })

  it('persists recognized state evidence through the shared artifact store', async () => {
    const register = vi.fn().mockResolvedValue({ artifact: { id: 'artifact-state-1' } })
    const recognizer = new RpaAppStateRecognizer({
      artifactStore: { register } as unknown as RpaArtifactStore,
      persistTextFile: vi.fn().mockResolvedValue('state.json')
    })

    const result = await recognizer.recognize({
      observation: observation(),
      profile: profile([{ stateId: 'HOME', packageNames: ['com.example.app'], anyTexts: ['首页'] }]),
      persistEvidence: true,
      artifactContext: { targetType: 'device_run', targetId: 'run-1:device-1' }
    })

    expect(result.artifactId).toBe('artifact-state-1')
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'run_log',
        links: [{ targetType: 'device_run', targetId: 'run-1:device-1', relation: 'recognized_app_state' }]
      })
    )
  })
})
