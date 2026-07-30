import type * as RpaAppRoleModule from '@renderer/services/rpa/RpaAppRole'
import { render, screen } from '@testing-library/react'
import type * as ReactI18next from 'react-i18next'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import RpaRoleLibrary from '../RpaRoleLibrary'

const role = vi.hoisted(() => ({
  schemaVersion: 1,
  id: 'role-1',
  name: 'Test Role',
  description: 'Removed role description',
  appPackages: ['com.example.hidden'],
  supportedAppVersions: [],
  status: 'enabled',
  version: 3,
  supportingRoleIds: [],
  systemCapabilities: [],
  assetBindings: [],
  createdAt: 1,
  updatedAt: 2
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@renderer/store', () => ({ useAppSelector: () => [] }))
vi.mock('@renderer/services/rpa/RpaAppRole', async (importOriginal) => {
  const actual = await importOriginal<typeof RpaAppRoleModule>()
  return {
    ...actual,
    rpaAppRoleRepository: {
      getAll: vi.fn().mockResolvedValue([role]),
      duplicate: vi.fn(),
      remove: vi.fn(),
      save: vi.fn()
    }
  }
})
vi.mock('@renderer/services/rpa/RpaArtifactStore', () => ({
  rpaArtifactStore: { getAll: vi.fn().mockResolvedValue([]) }
}))
vi.mock('@renderer/services/rpa/RpaBatchRunner', () => ({
  rpaBatchRunner: { initialize: vi.fn().mockResolvedValue(undefined), getRuns: () => [] }
}))
vi.mock('@renderer/services/rpa/RpaRolePrompt', () => ({
  rpaRolePromptRepository: { getAll: vi.fn().mockResolvedValue([]) }
}))
vi.mock('@renderer/services/rpa/RpaSkillRepository', () => ({
  rpaSkillRepository: { getAll: vi.fn().mockResolvedValue([]) }
}))

describe('RpaRoleLibrary', () => {
  beforeAll(() => {
    const getComputedStyle = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => getComputedStyle(element))
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

  it('shows only the Role name and version in the Role field', async () => {
    render(<RpaRoleLibrary />)

    expect(await screen.findByText('Test Role')).toBeInTheDocument()
    expect(screen.getByText('v3')).toBeInTheDocument()
    expect(screen.queryByText('Removed role description')).not.toBeInTheDocument()
    expect(screen.queryByText('com.example.hidden')).not.toBeInTheDocument()
    expect(screen.queryByText('rpa_roles.library.heading')).not.toBeInTheDocument()
    expect(screen.queryByText('rpa_roles.library.description')).not.toBeInTheDocument()
  })
})
