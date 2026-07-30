import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import RpaTemplateEditor from '../RpaTemplateEditor'

const task = vi.hoisted(() => ({
  id: 'task-1',
  name: 'Open app',
  goal: 'Open the target app',
  deviceIds: [],
  steps: [],
  metadata: {}
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }
}))
vi.mock('@renderer/components/app/Navbar', () => ({
  Navbar: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  NavbarCenter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useParams: () => ({ id: 'flow-1' }) }))
vi.mock('@renderer/pages/device/JsonEditor', () => ({ default: () => <div>JSON editor</div> }))
vi.mock('@renderer/pages/device/RpaTimelineEditor', () => ({ default: () => <div>Timeline editor</div> }))
vi.mock('@renderer/services/rpa/RpaAppRole', () => ({
  rpaAppRoleRepository: {
    getAll: vi.fn().mockResolvedValue([{ id: 'role-1', name: 'Role 1', status: 'draft', version: 1 }])
  }
}))
vi.mock('@renderer/services/rpa/RpaTemplateRepository', () => ({
  getTemplateTask: () => task,
  rpaTemplateRepository: {
    getById: vi.fn().mockResolvedValue({
      id: 'flow-1',
      version: 1,
      name: task.name,
      goal: task.goal,
      tags: [],
      dsl: task,
      validationIssues: [],
      skillLinks: [],
      role: undefined
    })
  }
}))

describe('RpaTemplateEditor', () => {
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

  it('keeps editing actions inside the page, defaults the role, and only exposes save', async () => {
    render(<RpaTemplateEditor />)

    expect(await screen.findByText('编辑 RPA 任务流')).toBeInTheDocument()
    expect(await screen.findByText('Role 1 · v1')).toBeInTheDocument()
    expect(screen.getByDisplayValue(task.goal).tagName).toBe('TEXTAREA')
    expect(document.querySelector('#content-container')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '确认并执行' })).not.toBeInTheDocument()
  })
})
