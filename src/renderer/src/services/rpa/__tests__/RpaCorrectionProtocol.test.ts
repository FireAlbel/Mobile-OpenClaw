import { describe, expect, it } from 'vitest'

import { RpaCorrectionDecisionSchema } from '../RpaTypes'

describe('RpaCorrectionDecisionSchema', () => {
  it.each(['execute_actions', 'replan', 'human_required', 'goal_achieved'])('supports the %s decision', (decision) => {
    const value =
      decision === 'execute_actions'
        ? {
            decision,
            reason: 'act',
            confidence: 0.9,
            expectedOutcome: 'changed screen',
            actions: [{ id: 'tap', type: 'tap', x: 1, y: 2 }]
          }
        : decision === 'replan'
          ? { decision, reason: 'plan', confidence: 0.9, objective: 'close popup' }
          : decision === 'human_required'
            ? { decision, reason: 'captcha', confidence: 0.9, interventionCode: 'captcha' }
            : { decision, reason: 'done', confidence: 0.9, evidence: 'success is visible' }

    expect(RpaCorrectionDecisionSchema.safeParse(value).success).toBe(true)
  })

  it('rejects a descriptive response without a decision', () => {
    expect(RpaCorrectionDecisionSchema.safeParse({ reason: 'Tap the close button', confidence: 0.9 }).success).toBe(
      false
    )
  })

  it('rejects arbitrary shell actions', () => {
    const result = RpaCorrectionDecisionSchema.safeParse({
      decision: 'execute_actions',
      reason: 'run shell',
      confidence: 0.9,
      expectedOutcome: 'changed',
      actions: [{ id: 'shell', type: 'adb_shell', command: 'rm -rf /' }]
    })

    expect(result.success).toBe(false)
  })
})
