import { describe, expect, it } from 'vitest'

import { normalizeRpaPrimarySidebarIcons } from '../sidebar'

describe('normalizeRpaPrimarySidebarIcons', () => {
  it('removes legacy entries and restores every required RPA menu', () => {
    expect(normalizeRpaPrimarySidebarIcons(['assistants', 'rpa_templates', 'knowledge', 'store'])).toEqual([
      'assistants',
      'rpa_templates',
      'rpa_roles'
    ])
  })

  it('deduplicates entries while preserving the configured primary order', () => {
    expect(normalizeRpaPrimarySidebarIcons(['rpa_roles', 'assistants', 'rpa_roles'])).toEqual([
      'rpa_roles',
      'assistants',
      'rpa_templates'
    ])
  })
})
