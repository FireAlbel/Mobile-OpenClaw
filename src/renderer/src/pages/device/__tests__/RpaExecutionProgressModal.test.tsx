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
    t: (key: string, options?: { defaultValue?: string; attempt?: number; round?: number }) => {
      if (key === 'device.rpa.attempt') return `Attempt ${options?.attempt}`
      if (key === 'device.rpa.correction_round') return `Correction round ${options?.round}`
      if (key === 'device.rpa.temporary_action') return 'Temporary action'
      if (key === 'device.rpa.executable_action') return 'Executable action'
      if (key === 'device.rpa.verification_result') return 'Verification result'
      if (key === 'device.rpa.safety_decision') return 'Safety decision'
      return options?.defaultValue || key
    }
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
    }),
    emergencyStop: vi.fn(async () => 1)
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
                message: 'Safety policy allowed module:launch_app',
                timestamp: 1,
                phase: 'safety_policy',
                safety: {
                  decision: 'allow',
                  riskLevel: 'low',
                  target: 'module:launch_app',
                  reason: 'Allowed',
                  evaluatedAt: 1
                }
              },
              {
                taskId: 'task-1',
                deviceId: 'device-1',
                stepId: 'step-1',
                stepName: 'Open app',
                status: 'running',
                attempt: 1,
                message: 'Analyzing failure with VLM',
                timestamp: 2,
                phase: 'correction_observation',
                recoveryRound: 1,
                parentStepId: 'step-1'
              },
              {
                taskId: 'task-1',
                deviceId: 'device-1',
                stepId: 'correction-1-action-1',
                stepName: 'Correction tap',
                status: 'passed',
                attempt: 1,
                message: 'Correction action completed',
                timestamp: 3,
                phase: 'temporary_action',
                recoveryRound: 1,
                parentStepId: 'step-1',
                temporary: true,
                action: { id: 'tap-close', type: 'tap', x: 10, y: 20 },
                verification: { status: 'passed', confidence: 1, message: 'Action command completed' }
              }
            ]
          }
        ]
      }
    ]

    await act(async () => runnerState.listener?.())

    await waitFor(() => expect(screen.getAllByText('Analyzing failure with VLM').length).toBeGreaterThan(0))
    expect(screen.getByText('correction_observation')).toBeInTheDocument()
    expect(screen.getAllByText('Correction round 1')).toHaveLength(2)
    expect(screen.getByText('Temporary action')).toBeInTheDocument()
    expect(screen.getByText('Executable action')).toBeInTheDocument()
    expect(screen.getByText('Verification result')).toBeInTheDocument()
    expect(screen.getByText('Safety decision')).toBeInTheDocument()
    expect(screen.getByText('module:launch_app')).toBeInTheDocument()
    expect(screen.getAllByText(/Open app · Attempt 1/)).toHaveLength(2)
  })

  it('loads a historical run in read-only replay mode', async () => {
    const historicalRun = createRun()
    historicalRun.status = 'failed'
    historicalRun.deviceRuns[0].status = 'failed'

    render(<RpaExecutionProgressModal runId="run-1" historicalRun={historicalRun} open onClose={vi.fn()} />)

    expect(await screen.findByText('RPA run replay')).toBeInTheDocument()
    expect(screen.getByText('Screenshot evidence is unavailable.')).toBeInTheDocument()
    expect(screen.queryByText('device.rpa.emergency_stop')).not.toBeInTheDocument()
  })
})
