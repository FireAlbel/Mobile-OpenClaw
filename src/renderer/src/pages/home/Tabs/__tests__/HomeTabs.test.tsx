import type { Assistant, Topic } from '@renderer/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import HomeTabs from '..'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@renderer/hooks/useSettings', () => ({
  useNavbarPosition: () => ({ isLeftNavbar: true })
}))

vi.mock('../ActiveRpaRuns', () => ({
  default: () => <div>active runs</div>
}))

vi.mock('../TopicsTab', () => ({
  default: () => <div>topics</div>
}))

describe('HomeTabs', () => {
  const assistant = { id: 'assistant-1', name: 'RPA Assistant', prompt: '', type: 'assistant', topics: [] } as Assistant
  const topic = { id: 'topic-1' } as Topic

  it('requests device management from the RPA workspace phone button', () => {
    const onOpenDeviceManagement = vi.fn()
    render(
      <HomeTabs
        activeAssistant={assistant}
        activeTopic={topic}
        setActiveTopic={vi.fn()}
        onOpenDeviceManagement={onOpenDeviceManagement}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'device.management_title' }))

    expect(onOpenDeviceManagement).toHaveBeenCalledOnce()
  })
})
