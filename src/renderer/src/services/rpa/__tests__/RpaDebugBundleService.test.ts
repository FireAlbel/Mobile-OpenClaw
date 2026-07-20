import { describe, expect, it } from 'vitest'

import { RpaDebugBundleService } from '../RpaDebugBundleService'
import type { RpaBatchRunRecord } from '../RpaRunStorage'

function createRun(status: RpaBatchRunRecord['status'] = 'completed'): RpaBatchRunRecord {
  return {
    id: 'run-sensitive',
    task: {
      id: 'task-1',
      name: 'Reusable task',
      goal: 'Test bundle',
      deviceIds: ['serial-1'],
      steps: [
        {
          id: 'step-1',
          name: 'Screenshot',
          moduleId: 'screenshot',
          params: { apiKey: 'sk-secret-value-12345', targetDevice: 'serial-1' },
          continueOnFailure: false
        }
      ],
      metadata: { authorization: 'Bearer hidden-token-value' }
    },
    deviceIds: ['serial-1'],
    status,
    createdAt: 1,
    updatedAt: 2,
    deviceRuns: [
      {
        id: 'device-run-1',
        batchRunId: 'run-sensitive',
        taskId: 'task-1',
        deviceId: 'serial-1',
        status: status === 'completed' ? 'completed' : 'failed',
        createdAt: 1,
        updatedAt: 2,
        events: [
          {
            taskId: 'task-1',
            deviceId: 'serial-1',
            stepId: 'step-1',
            stepName: 'Screenshot',
            status: status === 'completed' ? 'passed' : 'failed',
            attempt: 1,
            message: 'Bearer another-hidden-token',
            timestamp: 2,
            data: { result: { data: { imageBase64: 'YWJj', mime: 'image/png' } } }
          }
        ]
      }
    ]
  }
}

describe('RpaDebugBundleService', () => {
  it('builds a sanitized bundle with extracted screenshots', () => {
    const bundle = new RpaDebugBundleService().build(createRun(), 10)
    const runEntry = bundle.payload.entries.find((entry) => entry.path === 'run.sanitized.json')
    const screenshot = bundle.payload.entries.find((entry) => entry.path.startsWith('screenshots/'))

    expect(bundle.payload.fileName).toBe('rpa-debug-run-sensitive.zip')
    expect(bundle.payload.entries.map((entry) => entry.path)).toContain('manifest.json')
    expect(runEntry?.content).not.toContain('sk-secret')
    expect(runEntry?.content).not.toContain('another-hidden-token')
    expect(runEntry?.content).toContain('[REDACTED]')
    expect(screenshot).toMatchObject({ content: 'YWJj', encoding: 'base64' })
  })

  it('creates a device-neutral template from a successful run', () => {
    const template = new RpaDebugBundleService().createTemplate(createRun(), 10)

    expect(template.id).toBe('rpa-template-10')
    expect(template.deviceIds).toEqual([])
    expect(template.steps[0].params).toMatchObject({ targetDevice: '{{deviceId}}', apiKey: '[REDACTED]' })
    expect(template.metadata).toEqual({ template: true })
  })

  it('rejects template creation for unsuccessful runs', () => {
    expect(() => new RpaDebugBundleService().createTemplate(createRun('failed'))).toThrow('Only fully completed runs')
  })
})
