import type { RpaBatchRunRecord } from '@renderer/services/rpa/RpaRunStorage'
import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import RpaRunHistory from '../RpaRunHistory'

const run = vi.hoisted<RpaBatchRunRecord>(() => ({
  id: 'run-1',
  task: {
    id: 'task-1',
    name: 'Open detail',
    goal: 'Open detail page',
    deviceIds: ['device-1'],
    metadata: {},
    steps: []
  },
  deviceIds: ['device-1'],
  status: 'completed',
  createdAt: 1,
  updatedAt: 2,
  deviceRuns: [
    {
      id: 'device-run-1',
      batchRunId: 'run-1',
      taskId: 'task-1',
      deviceId: 'device-1',
      status: 'completed',
      events: [],
      createdAt: 1,
      updatedAt: 2,
      traceAnalysis: {
        runId: 'run-1',
        deviceRunId: 'device-run-1',
        summary: 'Completed with a deterministic correction',
        confidence: 0.9,
        stateIds: [],
        transitions: [],
        locatorHints: [],
        assertionHints: [],
        evidenceArtifactIds: [],
        taskFlowLearning: {
          status: 'versioned',
          templateId: 'template-1',
          sourceVersion: 2,
          appliedVersion: 3,
          usedCorrection: true
        },
        improvementProposalIds: [],
        redactions: [],
        analyzedAt: 2
      }
    }
  ]
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@renderer/services/rpa/RpaBatchRunner', () => ({
  rpaBatchRunner: {
    initialize: vi.fn(async () => undefined),
    getRuns: vi.fn(() => [run]),
    subscribe: vi.fn(() => vi.fn())
  }
}))
vi.mock('@renderer/services/rpa/RpaDebugBundleService', () => ({
  rpaDebugBundleService: { build: vi.fn() }
}))
vi.mock('@renderer/services/rpa/RpaArtifactStore', () => ({ rpaArtifactStore: { register: vi.fn() } }))
vi.mock('../RpaExecutionProgressModal', () => ({ default: () => null }))

describe('RpaRunHistory', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    })
  })

  it('shows automatic task-flow learning without proposal or free-form experience actions', async () => {
    render(<RpaRunHistory />)

    expect(await screen.findByText('device.rpa.task_flow_learning.versioned')).toBeInTheDocument()
    expect(screen.getByText('template-1')).toBeInTheDocument()
    expect(screen.queryByText('device.rpa.create_template')).not.toBeInTheDocument()
    expect(screen.queryByText('device.rpa.save_experience')).not.toBeInTheDocument()
    expect(screen.queryByText('打开改进提案')).not.toBeInTheDocument()
    expect(screen.queryByText('创建改进提案')).not.toBeInTheDocument()
  })
})
