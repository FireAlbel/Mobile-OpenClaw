import type * as RpaAppRoleModule from '@renderer/services/rpa/RpaAppRole'
import type * as RpaRolePromptModule from '@renderer/services/rpa/RpaRolePrompt'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as ReactI18next from 'react-i18next'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import RpaRoleDetailPage from '../RpaRoleDetailPage'

const role = vi.hoisted(() => ({
  schemaVersion: 1,
  id: 'role-1',
  name: 'Test Role',
  appPackages: [],
  supportedAppVersions: [],
  status: 'enabled',
  version: 3,
  supportingRoleIds: [],
  systemCapabilities: [],
  assetBindings: [],
  createdAt: 1,
  updatedAt: 2
}))
const pageState = vi.hoisted(() => ({
  navigate: vi.fn(),
  selectFiles: vi.fn(),
  addFiles: vi.fn(),
  readText: vi.fn(),
  saveSkill: vi.fn(),
  registerArtifact: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }
}))
vi.mock('@renderer/components/app/Navbar', () => ({
  Navbar: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  NavbarCenter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('react-router-dom', () => ({ useNavigate: () => pageState.navigate, useParams: () => ({ id: 'role-1' }) }))
vi.mock('@renderer/services/FileManager', () => ({
  default: { selectFiles: pageState.selectFiles, addFiles: pageState.addFiles }
}))
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key })
}))
vi.mock('@renderer/store', () => ({ useAppSelector: () => [] }))
vi.mock('@renderer/services/rpa/RpaAppRole', async (importOriginal) => {
  const actual = await importOriginal<typeof RpaAppRoleModule>()
  return {
    ...actual,
    rpaAppRoleRepository: { getAll: vi.fn().mockResolvedValue([role]), save: vi.fn() }
  }
})
vi.mock('@renderer/services/rpa/RpaArtifactStore', () => ({
  artifactInputFromFile: (file: unknown, input: unknown) => ({ file, input }),
  rpaArtifactStore: { getAll: vi.fn().mockResolvedValue([]), register: pageState.registerArtifact }
}))
vi.mock('@renderer/services/rpa/RpaBatchRunner', () => ({
  rpaBatchRunner: { initialize: vi.fn().mockResolvedValue(undefined), getRuns: () => [] }
}))
vi.mock('@renderer/services/rpa/RpaMcpSupplementProviderBridge', () => ({
  rpaMcpSupplementProviderBridge: { synchronize: vi.fn(), listCatalog: vi.fn(() => []) }
}))
vi.mock('@renderer/services/rpa/RpaRolePrompt', async (importOriginal) => {
  const actual = await importOriginal<typeof RpaRolePromptModule>()
  return {
    ...actual,
    rpaRolePromptRepository: { getAll: vi.fn().mockResolvedValue([]), remove: vi.fn(), save: vi.fn() }
  }
})
vi.mock('@renderer/services/rpa/RpaSkillRepository', () => ({
  rpaSkillRepository: { getAll: vi.fn().mockResolvedValue([]), save: pageState.saveSkill }
}))

describe('RpaRoleDetailPage', () => {
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
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { fs: { readText: pageState.readText } }
    })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    const skillFile = {
      id: 'skill-file',
      name: 'skill.json',
      origin_name: 'skill.json',
      path: 'D:\\fixtures\\skill.json',
      size: 100,
      ext: '.json',
      type: 'application/json',
      created_at: new Date(0).toISOString(),
      count: 1
    }
    const evidenceFile = { ...skillFile, id: 'evidence-file', name: 'evidence.txt', path: 'D:\\fixtures\\evidence.txt' }
    pageState.selectFiles.mockResolvedValueOnce([skillFile]).mockResolvedValueOnce([evidenceFile])
    pageState.addFiles.mockResolvedValue([evidenceFile])
    pageState.readText.mockResolvedValue('{"id":"skill-1"}')
    pageState.saveSkill.mockResolvedValue({ id: 'skill-1', name: 'Imported skill', version: '1.0.0' })
    pageState.registerArtifact.mockResolvedValue({
      artifact: { id: 'artifact-1', title: 'Evidence', version: 1 },
      deduplicated: false,
      policyWarnings: []
    })
  })

  it('places back and save inside the editor without a session action', async () => {
    render(<RpaRoleDetailPage />)

    expect(await screen.findByDisplayValue('Test Role')).toBeInTheDocument()
    expect(document.querySelector('#content-container')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'rpa_roles.actions.back' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'rpa_roles.actions.save' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'rpa_roles.actions.start_session' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'rpa_roles.assets.provider' })).not.toBeInTheDocument()
  })

  it('provides working creation and import entry points for role assets', async () => {
    render(<RpaRoleDetailPage />)
    expect(await screen.findByDisplayValue('Test Role')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'rpa_roles.assets.knowledge' }))
    fireEvent.click(screen.getByRole('button', { name: 'rpa_roles.binding.bind_asset' }))
    fireEvent.click(await screen.findByRole('button', { name: 'rpa_roles.binding.manage_knowledge' }))
    expect(pageState.navigate).toHaveBeenCalledWith('/knowledge')

    fireEvent.click(screen.getByRole('tab', { name: 'rpa_roles.assets.skill' }))
    fireEvent.click(screen.getByRole('button', { name: 'rpa_roles.binding.bind_asset' }))
    fireEvent.click(await screen.findByRole('button', { name: 'rpa_roles.binding.import_skill' }))
    await waitFor(() => expect(pageState.readText).toHaveBeenCalledWith('D:\\fixtures\\skill.json'))
    expect(pageState.saveSkill).toHaveBeenCalledWith({ definition: { id: 'skill-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    fireEvent.click(screen.getByRole('tab', { name: 'rpa_roles.assets.artifact' }))
    fireEvent.click(screen.getByRole('button', { name: 'rpa_roles.binding.bind_asset' }))
    fireEvent.click(await screen.findByRole('button', { name: 'rpa_roles.binding.import_files' }))
    await waitFor(() => expect(pageState.registerArtifact).toHaveBeenCalledTimes(1))
    expect(pageState.addFiles).toHaveBeenCalled()
  })
})
