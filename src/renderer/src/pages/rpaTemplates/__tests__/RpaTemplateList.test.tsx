import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import RpaTemplateList from '../RpaTemplateList'

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  navigate: vi.fn(),
  getAll: vi.fn(),
  initialize: vi.fn()
}))

const task = {
  id: 'task-1',
  name: 'Open app',
  goal: 'Open the target app',
  deviceIds: [],
  steps: [
    {
      id: 'step-1',
      name: 'Launch',
      moduleId: 'launch_app',
      params: { packageName: 'com.example.app' },
      verify: { type: 'foreground_app', packageName: 'com.example.app' },
      continueOnFailure: false
    }
  ],
  metadata: {}
}

const template = {
  id: 'template-1',
  version: 2,
  name: 'Open app template',
  goal: task.goal,
  dsl: task,
  status: 'executable',
  validationIssues: [],
  tags: ['demo'],
  skillLinks: [],
  source: 'manual',
  revisions: [],
  createdAt: 1,
  updatedAt: 2
}

vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('@renderer/services/rpa/RpaTemplateRepository', () => ({
  rpaTemplateRepository: {
    getAll: mocks.getAll,
    duplicate: vi.fn(),
    remove: vi.fn()
  },
  getTemplateTask: () => task,
  getTemplateAppPackage: () => 'com.example.app',
  inferTemplateRisk: () => 'low'
}))
vi.mock('@renderer/services/rpa/RpaBatchRunner', () => ({
  rpaBatchRunner: { initialize: mocks.initialize, getRuns: () => [], start: mocks.start }
}))
vi.mock('@renderer/services/rpa/RpaSafetyPolicyEngine', () => ({
  rpaSafetyPolicyEngine: {
    analyzeTask: () => ({ highestRisk: 'low', highRiskTargets: [], mediumRiskTargets: [] }),
    createApproval: vi.fn()
  }
}))
vi.mock('@renderer/services/rpa/RpaDefaultRegistry', () => ({
  defaultRpaModuleRegistry: { listMetadata: () => [] }
}))
vi.mock('@renderer/pages/device/RpaExecutionConfirmModal', () => ({
  default: ({ onExecute }: { onExecute: (selection: unknown) => Promise<void> }) => (
    <button
      type="button"
      onClick={() =>
        void onExecute({
          mode: 'manual',
          groupIds: [],
          includedDeviceIds: ['device-1'],
          excludedDeviceIds: [],
          deviceIds: ['device-1'],
          unavailableDeviceIds: [],
          partialGroupIds: [],
          emptyGroupIds: [],
          scannedAt: 1
        })
      }>
      confirm target
    </button>
  )
}))
vi.mock('@renderer/pages/device/RpaExecutionProgressModal', () => ({ default: () => null }))

describe('RPA template list', () => {
  beforeAll(() => {
    const getComputedStyle = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getComputedStyle(element))
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
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

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAll.mockResolvedValue([template])
    mocks.initialize.mockResolvedValue(undefined)
    mocks.start.mockResolvedValue({ id: 'run-1' })
  })

  it('lists saved DSL and submits execution through RpaBatchRunner', async () => {
    render(<RpaTemplateList />)

    expect(await screen.findByText('Open app template')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'RPA 任务流' })).not.toBeInTheDocument()
    expect(screen.queryByText('统一管理、校验和执行可复用的手机自动化流程')).not.toBeInTheDocument()
    expect(screen.getByText('com.example.app')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认并执行' }))
    fireEvent.click(await screen.findByRole('button', { name: 'confirm target' }))

    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({
          task: expect.objectContaining({
            deviceIds: ['device-1'],
            metadata: expect.objectContaining({ templateId: 'template-1' })
          })
        })
      )
    )
  })

  it('opens a template in the DSL editor', async () => {
    render(<RpaTemplateList />)
    await screen.findByText('Open app template')
    fireEvent.click(screen.getByRole('button', { name: '编辑任务流' }))
    expect(mocks.navigate).toHaveBeenCalledWith('/rpa-workflows/edit/template-1')
  })
})
