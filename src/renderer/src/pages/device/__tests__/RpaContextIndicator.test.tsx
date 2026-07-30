import type { RpaDslProvenance } from '@renderer/services/rpa/RpaRunContextSnapshot'
import { fireEvent, render, screen } from '@testing-library/react'
import type * as ReactI18nextModule from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'

import RpaContextIndicator from '../RpaContextIndicator'

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18nextModule>()
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

const provenance: RpaDslProvenance = {
  assistantId: 'assistant-1',
  assistantProfileVersion: 3,
  generatedAt: 1,
  sourceTemplate: { id: 'template-1', version: '2' },
  compiledSkills: [{ id: 'skill-1', version: '1' }],
  retrievedKnowledge: [{ id: 'kb-1', version: '4' }],
  activeAssetCounts: { knowledge: 2, skills: 3, templates: 1 },
  models: {
    planner: { providerId: 'provider-1', modelId: 'model-1' },
    vision: { providerId: 'provider-1', modelId: 'model-1' },
    verification: { providerId: 'provider-1', modelId: 'model-1' },
    recovery: { providerId: 'provider-1', modelId: 'model-1' }
  },
  warnings: []
}

describe('RpaContextIndicator', () => {
  it('shows compact asset counts and opens the adjustment entry', () => {
    const onAdjust = vi.fn()
    render(<RpaContextIndicator provenance={provenance} onAdjust={onAdjust} />)

    expect(screen.getByText('Knowledge 2')).toBeInTheDocument()
    expect(screen.getByText('Skill 3')).toBeInTheDocument()
    expect(screen.getByText('Task Flow 1')).toBeInTheDocument()
    fireEvent.click(screen.getByText('device.rpa.adjust_context'))
    expect(onAdjust).toHaveBeenCalledOnce()
  })
})
