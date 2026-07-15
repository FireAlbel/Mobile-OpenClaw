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
        params: { packageName: 'com.example.app' }
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

  it('rejects duplicate step ids', () => {
    const task = validTask()
    task.steps.push({ ...task.steps[0] })
    const validator = new RpaTaskValidator(createDefaultRpaModuleRegistry())

    const result = validator.validate(task)

    expect(result.success).toBe(false)
    expect(result.issues.some((issue) => issue.message.includes('Duplicate step id'))).toBe(true)
  })
})
