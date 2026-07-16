import type { RpaBatchRunRecord } from '@renderer/services/rpa/RpaRunStorage'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import RpaExecutionProgressModal from '../RpaExecutionProgressModal'

const runnerState = vi.hoisted<{
  runs: RpaBatchRunRecord[]
  listener?: () => void
}>(() => ({ runs: [] }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; attempt?: number }) =>
      options?.defaultValue || (key === 'device.rpa.attempt' ? `Attempt ${options?.attempt}` : key)
  })
}))

vi.mock('@renderer/services/rpa/RpaBatchRunner', () => ({
  rpaBatchRunner: {
    initialize: vi.fn(async () => undefined),
    getRuns: vi.fn(() => runnerState.runs),
    subscribe: vi.fn((listener: () => void) => {
      runnerState.listener = listener
      return () => {
        runnerState.listener = undefined
      }
    })
  }
}))

function createRun(): RpaBatchRunRecord {
  return {
    id: 'run-1',
    task: {
      id: 'task-1',
      name: 'Test task',
      goal: 'Test live progress',
      deviceIds: ['device-1'],
      metadata: {},
      steps: [
        {
          id: 'step-1',
          name: 'Open app',
          moduleId: 'launch_app',
          params: { packageName: 'com.example' },
          continueOnFailure: false
        },
        {
          id: 'step-2',
          name: 'Find target',
          moduleId: 'screenshot',
          params: {},
          continueOnFailure: false
        }
      ]
    },
    deviceIds: ['device-1'],
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    deviceRuns: [
      {
        id: 'device-run-1',
        batchRunId: 'run-1',
        taskId: 'task-1',
        deviceId: 'device-1',
        status: 'running',
        events: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
}

describe('RpaExecutionProgressModal', () => {
  beforeEach(() => {
    runnerState.runs = [createRun()]
    runnerState.listener = undefined
  })

  it('updates step and recovery status when the runner publishes an event', async () => {
    render(<RpaExecutionProgressModal runId="run-1" open onClose={vi.fn()} />)

    expect(await screen.findAllByText('device.rpa.waiting_to_execute')).toHaveLength(2)

    runnerState.runs = [
      {
        ...runnerState.runs[0],
        deviceRuns: [
          {
            ...runnerState.runs[0].deviceRuns[0],
            currentStepId: 'step-1',
            events: [
              {
                taskId: 'task-1',
                deviceId: 'device-1',
                stepId: 'step-1',
                stepName: 'Open app',
                status: 'running',
                attempt: 1,
                message: 'Analyzing failure with VLM',
                timestamp: 2,
                data: { phase: 'recovery_analysis' }
              }
            ]
          }
        ]
      }
    ]

    await act(async () => runnerState.listener?.())

    await waitFor(() => expect(screen.getAllByText('Analyzing failure with VLM').length).toBeGreaterThan(0))
    expect(screen.getByText('recovery_analysis')).toBeInTheDocument()
    expect(screen.getByText(/Open app · Attempt 1/)).toBeInTheDocument()
  })
})
