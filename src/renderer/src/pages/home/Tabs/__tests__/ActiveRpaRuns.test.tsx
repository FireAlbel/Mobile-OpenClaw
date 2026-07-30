import type { RpaBatchRunRecord } from '@renderer/services/rpa/RpaRunStorage'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import ActiveRpaRuns from '../ActiveRpaRuns'

const runnerState = vi.hoisted<{
  runs: RpaBatchRunRecord[]
  listener?: () => void
}>(() => ({ runs: [] }))

const pauseDeviceRunMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, number>) => {
      if (key === 'device.rpa.no_active_runs') return 'No active tasks'
      if (key === 'device.rpa.run_devices_summary') return `${options?.completed}/${options?.total} devices completed`
      return key
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
    pauseDeviceRun: pauseDeviceRunMock
  }
}))

vi.mock('../../../device/RpaExecutionProgressModal', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="progress-modal" /> : null)
}))

function createRun(status: RpaBatchRunRecord['status'] = 'running'): RpaBatchRunRecord {
  return {
    id: 'run-1',
    task: {
      id: 'task-1',
      name: 'Meituan coin task',
      goal: 'Collect coins',
      deviceIds: ['device-1'],
      metadata: {},
      steps: [
        {
          id: 'step-1',
          name: 'Open app',
          moduleId: 'launch_app',
          params: { packageName: 'com.sankuai.meituan' },
          continueOnFailure: false
        }
      ]
    },
    deviceIds: ['device-1'],
    status,
    createdAt: 1,
    updatedAt: 1,
    deviceRuns: [
      {
        id: 'device-run-1',
        batchRunId: 'run-1',
        taskId: 'task-1',
        deviceId: 'device-1',
        status: status === 'paused' ? 'needs_human' : 'running',
        events: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  }
}

describe('ActiveRpaRuns', () => {
  beforeEach(() => {
    runnerState.runs = []
    runnerState.listener = undefined
    pauseDeviceRunMock.mockClear()
  })

  it('shows a compact empty state when no task is active', async () => {
    render(<ActiveRpaRuns />)

    expect(await screen.findByText('No active tasks')).toBeInTheDocument()
  })

  it('shows active task progress and opens execution details', async () => {
    runnerState.runs = [createRun()]
    render(<ActiveRpaRuns />)

    expect(await screen.findByText('Meituan coin task')).toBeInTheDocument()
    expect(screen.getByText('0/1 devices completed')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Meituan coin task'))
    expect(screen.getByTestId('progress-modal')).toBeInTheDocument()
  })

  it('pauses every pending or running device task', async () => {
    runnerState.runs = [createRun()]
    render(<ActiveRpaRuns />)

    fireEvent.click(await screen.findByLabelText('device.rpa.pause'))

    await waitFor(() => expect(pauseDeviceRunMock).toHaveBeenCalledWith('device-run-1'))
  })

  it('surfaces human intervention ahead of the batch paused state', async () => {
    runnerState.runs = [createRun('paused')]
    render(<ActiveRpaRuns />)

    expect(await screen.findByText('device.rpa.status.needs_human')).toBeInTheDocument()
  })
})
