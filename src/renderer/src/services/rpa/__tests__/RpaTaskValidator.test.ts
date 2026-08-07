import { describe, expect, it } from 'vitest'

import { createDefaultRpaModuleRegistry } from '../RpaDefaultRegistry'
import { RpaTaskValidator } from '../RpaTaskValidator'

function validTask() {
  return {
    id: 'task-1',
    name: 'Open app',
    goal: 'Open target app',
    deviceIds: ['device-1'],
    steps: [
      {
        id: 'step-1',
        name: 'Launch',
        moduleId: 'launch_app',
        params: { packageName: 'com.example.app' },
        verify: { type: 'foreground_app', packageName: 'com.example.app' }
      }
    ]
  }
}

describe('RpaTaskValidator', () => {
  it('validates a task with registered modules', () => {
    const validator = new RpaTaskValidator(createDefaultRpaModuleRegistry())

    const result = validator.validate(validTask())

    expect(result.success).toBe(true)
    expect(result.task?.steps[0].params).toEqual({ packageName: 'com.example.app' })
  })

  it('requires a device for executable tasks', () => {
    const validator = new RpaTaskValidator(createDefaultRpaModuleRegistry())
    const result = validator.validate({ ...validTask(), deviceIds: [] })

    expect(result.success).toBe(false)
    expect(result.issues).toContainEqual({ path: 'deviceIds', message: 'At least one device is required' })
  })

  it('allows a workflow draft without an assigned device', () => {
    const validator = new RpaTaskValidator(createDefaultRpaModuleRegistry(), { requireDeviceIds: false })
    const result = validator.validate({ ...validTask(), deviceIds: [] })

    expect(result.success).toBe(true)
    expect(result.task?.deviceIds).toEqual([])
  })

  it('rejects unknown modules', () => {
    const task = validTask()
    task.steps[0].moduleId = 'missing_module'
    const validator = new RpaTaskValidator(createDefaultRpaModuleRegistry())

    const result = validator.validate(task)

    expect(result.success).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes('Unknown module'))).toBe(true)
  })

  it('rejects invalid module params', () => {
    const task = validTask()
    task.steps[0].params = { packageName: 'bad;package' }
    const validator = new RpaTaskValidator(createDefaultRpaModuleRegistry())

    const result = validator.validate(task)

    expect(result.success).toBe(false)
    expect(result.issues.some((issue) => issue.path === 'steps.0.params')).toBe(true)
  })

  it('rejects runtime-only app normalization nodes in the primary DSL', () => {
    const validator = new RpaTaskValidator(createDefaultRpaModuleRegistry())
    const task = {
      ...validTask(),
      steps: [
        {
          id: 'ensure-home',
          name: 'Ensure home',
          moduleId: 'app.ensure_home',
          params: {
            packageName: 'com.example.app',
            recoveryPolicy: { stages: ['bounded_back', 'hard_restart'], maxBackCount: 3, deadlineMs: 30_000 }
          },
          continueOnFailure: true
        }
      ]
    }

    const result = validator.validate(task)

    expect(result.success).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes('runtime-only recovery behavior'))).toBe(true)
  })

  it('rejects unknown and unbounded app normalization settings', () => {
    const validator = new RpaTaskValidator(createDefaultRpaModuleRegistry())
    const task = {
      ...validTask(),
      steps: [
        {
          id: 'ensure-home',
          name: 'Ensure home',
          moduleId: 'app.ensure_home',
          params: {
            packageName: 'com.example.app',
            recoveryPolicy: { stages: ['pm_clear'], maxBackCount: 999 }
          }
        }
      ]
    }

    const result = validator.validate(task)

    expect(result.success).toBe(false)
    expect(result.issues.some((issue) => issue.path === 'steps.0.params')).toBe(true)
  })

  it('rejects duplicate step ids', () => {
    const task = validTask()
    task.steps.push({ ...task.steps[0] })
    const validator = new RpaTaskValidator(createDefaultRpaModuleRegistry())

    const result = validator.validate(task)

    expect(result.success).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes('Duplicate step id'))).toBe(true)
  })

  it('rejects visual actions without semantic verification', () => {
    const task = {
      ...validTask(),
      steps: [
        {
          id: 'step-1',
          name: 'Tap target',
          moduleId: 'tap_by_vlm_target',
          params: { target: 'coin button' }
        }
      ]
    }
    const validator = new RpaTaskValidator(createDefaultRpaModuleRegistry())

    const result = validator.validate(task)

    expect(result.success).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes('requires vlm_assert'))).toBe(true)
  })

  it('requires final business outcome verification for visual workflows', () => {
    const validator = new RpaTaskValidator(createDefaultRpaModuleRegistry())
    const result = validator.validate({
      id: 'task-visual',
      name: 'Visual task',
      goal: 'Complete a visual task',
      deviceIds: ['device-1'],
      steps: [
        {
          id: 'step-1',
          name: 'Tap target',
          moduleId: 'tap_by_vlm_target',
          params: { target: 'coin button' },
          verify: { type: 'vlm_assert', expectation: 'The task page opened' }
        },
        { id: 'step-2', name: 'Capture result', moduleId: 'screenshot', params: {} }
      ]
    })

    expect(result.success).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes('final vlm_assert'))).toBe(true)
  })

  it('rejects historical claims in final screenshot verification', () => {
    const validator = new RpaTaskValidator(createDefaultRpaModuleRegistry())
    const result = validator.validate({
      id: 'task-history',
      name: 'Historical assertion',
      goal: 'Open and leave a settings page',
      deviceIds: ['device-1'],
      steps: [
        {
          id: 'step-1',
          name: 'Tap target',
          moduleId: 'tap_by_vlm_target',
          params: { target: 'About phone' },
          verify: { type: 'vlm_assert', expectation: 'The About phone page is visible' }
        },
        {
          id: 'step-2',
          name: 'Capture result',
          moduleId: 'screenshot',
          params: {},
          verify: { type: 'vlm_assert', expectation: '曾进入关于手机后返回，并且未修改系统设置' }
        }
      ]
    })

    expect(result.success).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes('historical actions'))).toBe(true)
  })
})
