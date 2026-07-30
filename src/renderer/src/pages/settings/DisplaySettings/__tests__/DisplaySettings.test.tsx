import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import DisplaySettings from '../DisplaySettings'

vi.mock('@renderer/components/CodeEditor', () => ({
  default: () => <div data-testid="code-editor" />
}))

vi.mock('@renderer/context/ThemeProvider', () => ({
  useTheme: () => ({ theme: 'light', settedTheme: 'light' })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({
    windowStyle: 'opaque',
    setWindowStyle: vi.fn(),
    topicPosition: 'left',
    setTopicPosition: vi.fn(),
    clickAssistantToShowTopic: false,
    showTopicTime: 0,
    pinTopicsToTop: false,
    customCss: '',
    sidebarIcons: { visible: [], disabled: [] },
    setTheme: vi.fn(),
    assistantIconType: 'model',
    userTheme: { colorPrimary: '#1677ff', userFontFamily: '', userCodeFontFamily: '' },
    useSystemTitleBar: false,
    setUseSystemTitleBar: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useTimer', () => ({
  useTimer: () => ({ setTimeoutTimer: vi.fn() })
}))

vi.mock('@renderer/hooks/useUserTheme', () => ({
  default: () => ({ setUserTheme: vi.fn() })
}))

vi.mock('@renderer/store', () => ({
  useAppDispatch: () => vi.fn()
}))

vi.mock('../SidebarIconsManager', () => ({
  default: () => <div>settings.display.sidebar.title</div>
}))

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  },
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

describe('DisplaySettings', () => {
  beforeAll(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getSystemFonts: vi.fn().mockResolvedValue([]),
        handleZoomFactor: vi.fn().mockResolvedValue(1),
        openWebsite: vi.fn(),
        relaunchApp: vi.fn()
      }
    })
  })

  it('omits navbar position settings and keeps sidebar icon settings visible', () => {
    render(<DisplaySettings />)

    expect(screen.queryByText('settings.display.navbar.title')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.display.navbar.position.label')).not.toBeInTheDocument()
    expect(screen.getAllByText('settings.display.sidebar.title')).not.toHaveLength(0)
  })
})
