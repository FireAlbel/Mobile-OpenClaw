import type { Assistant } from '@renderer/types'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import RpaAutomationSettings from '../RpaAutomationSettings'

const getRoleMock = vi.hoisted(() => vi.fn())

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@renderer/pages/settings/SettingGroup', () => ({
  CollapsibleSettingGroup: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  )
}))
vi.mock('@renderer/hooks/useKnowledge', () => ({
  useKnowledgeBases: () => ({ bases: [{ id: 'kb-1', name: 'Operations KB', version: 2, items: [] }] })
}))
vi.mock('@renderer/hooks/useProvider', () => ({
  useProviders: () => ({
    providers: [{ id: 'provider-1', name: 'Provider One', models: [{ id: 'model-1', name: 'Model One' }] }]
  })
}))
vi.mock('@renderer/hooks/useRuntime', () => ({
  useRuntime: () => ({ chat: { activeTopic: { id: 'topic-1', rpaRoleId: 'role-1' } } })
}))
vi.mock('@renderer/services/rpa/RpaAppRole', () => ({
  rpaAppRoleRepository: { getById: getRoleMock, save: vi.fn() }
}))
vi.mock('@renderer/services/rpa/RpaSkillRepository', () => ({
  rpaSkillRepository: { getAll: vi.fn().mockResolvedValue([{ id: 'skill-1', name: 'Open app', version: '1.0.0' }]) }
}))
vi.mock('@renderer/services/rpa/RpaRolePrompt', () => ({
  rpaRolePromptRepository: {
    getAll: vi.fn().mockResolvedValue([{ roleId: 'role-1', id: 'planner', version: '1', status: 'enabled' }])
  }
}))

describe('RpaAutomationSettings', () => {
  beforeEach(() => {
    getRoleMock.mockResolvedValue({
      schemaVersion: 1,
      id: 'role-1',
      name: 'Meituan Operator',
      status: 'enabled',
      version: 3,
      appPackages: ['com.sankuai.meituan'],
      supportedAppVersions: [],
      supportingRoleIds: [],
      systemCapabilities: [],
      assetBindings: [],
      modelDefaults: { planner: { providerId: 'provider-1', modelId: 'model-1' } },
      createdAt: 1,
      updatedAt: 2
    })
  })

  it('loads the Role bound to the current RPA conversation and omits Template settings', async () => {
    const assistant = {
      id: 'assistant-1',
      name: 'RPA Assistant',
      prompt: '',
      type: 'assistant',
      model: { id: 'model-1', provider: 'provider-1', name: 'Model One', group: 'default' },
      topics: []
    } as Assistant

    render(<RpaAutomationSettings assistant={assistant} />)

    expect(await screen.findByText('Meituan Operator')).toBeInTheDocument()
    expect(getRoleMock).toHaveBeenCalledWith('role-1')
    expect(screen.getByText(/v3/)).toBeInTheDocument()
    expect(screen.queryByText(/Template/i)).not.toBeInTheDocument()
    expect(screen.queryByText('rpa_roles.assets.provider')).not.toBeInTheDocument()
    expect(screen.getByText('rpa_roles.settings.model_defaults')).toBeInTheDocument()
    expect(screen.getByText('Model One | Provider One')).toBeInTheDocument()
    expect(screen.getAllByText('rpa_roles.settings.use_chat_model')).toHaveLength(3)
  })
})
