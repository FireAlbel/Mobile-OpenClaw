import type { RpaBatchRunRecord } from '@renderer/services/rpa/RpaRunStorage'
import { act, render, screen, waitFor } from '@testing-library/react'
import { Modal } from 'antd'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import RpaExecutionProgressModal from '../RpaExecutionProgressModal'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
})

const runnerState = vi.hoisted<{
  runs: RpaBatchRunRecord[]
  devices: Array<{ id: string; name: string; status: 'online' | 'offline' | 'unauthorized' }>
  listener?: () => void
  cancelBatchRun: ReturnType<typeof vi.fn>
  pauseDeviceRun: ReturnType<typeof vi.fn>
  resumeDeviceRun: ReturnType<typeof vi.fn>
}>(() => ({
  runs: [],
  devices: [],
  cancelBatchRun: vi.fn(async () => true),
  pauseDeviceRun: vi.fn(async () => true),
  resumeDeviceRun: vi.fn(async () => true)
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: {
        defaultValue?: string
        attempt?: number
        round?: number
        completed?: number
        total?: number
        device?: string
      }
    ) => {
      if (key === 'device.rpa.attempt') return `Attempt ${options?.attempt}`
      if (key === 'device.rpa.correction_round') return `Correction round ${options?.round}`
      if (key === 'device.rpa.temporary_action') return 'Temporary action'
      if (key === 'device.rpa.executable_action') return 'Executable action'
      if (key === 'device.rpa.verification_result') return 'Verification result'
      if (key === 'device.rpa.safety_decision') return 'Safety decision'
      if (key === 'device.rpa.execution_devices') return 'RPA execution devices'
      if (key === 'device.rpa.device_execution_progress') return 'Device execution progress'
      if (key === 'device.rpa.view_details') return 'View details'
      if (key === 'device.rpa.stop_device') return 'Stop'
      if (key === 'device.rpa.continue_device') return 'Continue'
      if (key === 'device.rpa.device_offline_reason') return `Device ${options?.device} went offline`
      if (key === 'device.rpa.device_completed_steps') {
        return `${options?.completed} of ${options?.total} steps completed`
      }
      return options?.defaultValue || key
    }
  })
}))

vi.mock('@renderer/services/rpa/RpaBatchRunner', () => ({
  rpaBatchRunner: {
    initialize: vi.fn(async () => undefined),
    getRuns: vi.fn(() => runnerState.runs),
    getDetectedDevices: vi.fn(() => runnerState.devices),
    hasDeviceStatusSnapshot: vi.fn(() => true),
    refreshDeviceStatuses: vi.fn(async () => runnerState.devices),
    subscribe: vi.fn((listener: () => void) => {
      runnerState.listener = listener
      return () => {
        runnerState.listener = undefined
      }
    }),
    cancelBatchRun: runnerState.cancelBatchRun,
    pauseDeviceRun: runnerState.pauseDeviceRun,
    resumeDeviceRun: runnerState.resumeDeviceRun
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
    runnerState.devices = [{ id: 'device-1', name: 'Pixel', status: 'online' }]
    runnerState.listener = undefined
    runnerState.cancelBatchRun.mockClear()
    runnerState.pauseDeviceRun.mockClear()
    runnerState.resumeDeviceRun.mockClear()
  })

  it('updates step and recovery status when the runner publishes an event', async () => {
    render(<RpaExecutionProgressModal runId="run-1" open onClose={vi.fn()} />)

    await screen.findByText('Pixel')
    screen.getByRole('button', { name: 'View details' }).click()
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

    expect(await screen.findByText('RPA execution devices')).toBeInTheDocument()
    expect(screen.queryByText('device.rpa.emergency_stop')).not.toBeInTheDocument()
    screen.getByRole('button', { name: 'View details' }).click()
    expect(await screen.findByText('RPA execution details')).toBeInTheDocument()
    expect(screen.getByText('Screenshot evidence is unavailable.')).toBeInTheDocument()
  })

  it('shows device-level progress and switches the detailed device view', async () => {
    const secondDeviceRun = {
      ...runnerState.runs[0].deviceRuns[0],
      id: 'device-run-2',
      deviceId: 'device-2',
      status: 'failed' as const,
      error: 'Device 2 disconnected',
      events: [
        {
          taskId: 'task-1',
          deviceId: 'device-2',
          stepId: 'step-2',
          stepName: 'Find target',
          status: 'failed' as const,
          attempt: 1,
          message: 'Device 2 step failure',
          timestamp: 2
        }
      ]
    }
    runnerState.runs[0] = {
      ...runnerState.runs[0],
      deviceIds: ['device-1', 'device-2'],
      deviceRuns: [runnerState.runs[0].deviceRuns[0], secondDeviceRun]
    }
    runnerState.devices = [
      { id: 'device-1', name: 'Pixel', status: 'online' },
      { id: 'device-2', name: 'Galaxy', status: 'online' }
    ]

    render(<RpaExecutionProgressModal runId="run-1" open onClose={vi.fn()} />)

    expect(await screen.findByText('RPA execution devices')).toBeInTheDocument()
    expect(screen.getByText('Pixel')).toBeInTheDocument()
    expect(screen.getByText('Galaxy')).toBeInTheDocument()
    expect(screen.getByText('device-1')).toBeInTheDocument()
    expect(screen.getByText('device-2')).toBeInTheDocument()
    expect(screen.getAllByText('0 of 2 steps completed')).toHaveLength(2)
    expect(screen.getByText('device.rpa.status.failed').parentElement).toHaveAttribute('title', 'Device 2 disconnected')
    screen.getAllByRole('button', { name: 'View details' })[1].click()

    await waitFor(() => expect(screen.getAllByText('Device 2 step failure')).toHaveLength(2))
    expect(screen.queryByText('Test task')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('stops and continues one device from the operations column', async () => {
    render(<RpaExecutionProgressModal runId="run-1" open onClose={vi.fn()} />)

    screen.getByRole('button', { name: 'Stop' }).click()
    expect(runnerState.pauseDeviceRun).toHaveBeenCalledWith('device-run-1')

    runnerState.runs = [
      {
        ...runnerState.runs[0],
        deviceRuns: [{ ...runnerState.runs[0].deviceRuns[0], status: 'paused' }]
      }
    ]
    await act(async () => runnerState.listener?.())
    screen.getByRole('button', { name: 'Continue' }).click()
    expect(runnerState.resumeDeviceRun).toHaveBeenCalledWith('device-run-1')
  })

  it('offers contextual Replan for failed and manual-intervention runs', async () => {
    const onReplan = vi.fn()
    runnerState.runs[0].status = 'failed'
    runnerState.runs[0].deviceRuns[0].status = 'needs_human'

    render(<RpaExecutionProgressModal runId="run-1" open onClose={vi.fn()} onReplan={onReplan} />)

    const button = await screen.findByRole('button', { name: 'Replan' })
    button.click()
    expect(onReplan).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1', status: 'failed' }))
  })

  it('stops only the run displayed by the progress modal', async () => {
    let confirmation: Parameters<typeof Modal.confirm>[0] | undefined
    const confirmSpy = vi.spyOn(Modal, 'confirm').mockImplementation((config) => {
      confirmation = config
      return { destroy: vi.fn(), update: vi.fn() }
    })
    render(<RpaExecutionProgressModal runId="run-1" open onClose={vi.fn()} />)

    const stopButton = await screen.findByRole('button', { name: 'device.rpa.emergency_stop' })
    stopButton.click()
    expect(confirmation).toEqual(
      expect.objectContaining({
        title: 'device.rpa.emergency_stop_confirm',
        content: 'device.rpa.emergency_stop_detail'
      })
    )
    await act(async () => {
      await confirmation?.onOk?.()
    })

    await waitFor(() => expect(runnerState.cancelBatchRun).toHaveBeenCalledWith('run-1'))
    confirmSpy.mockRestore()
  })
})
