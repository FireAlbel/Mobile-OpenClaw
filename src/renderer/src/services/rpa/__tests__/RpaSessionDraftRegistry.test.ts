import { describe, expect, it, vi } from 'vitest'

import { RpaSessionDraftRegistry } from '../RpaSessionDraftRegistry'

describe('RpaSessionDraftRegistry', () => {
  it('tracks, saves, and discards dirty editors per task session', async () => {
    const registry = new RpaSessionDraftRegistry()
    let dirty = true
    const save = vi.fn(async () => {
      dirty = false
      return true
    })
    const discard = vi.fn(() => {
      dirty = false
    })
    const unregister = registry.register('session-1', 'editor-1', { isDirty: () => dirty, save, discard })

    expect(registry.hasUnsavedChanges('session-1')).toBe(true)
    await expect(registry.save('session-1')).resolves.toBe(true)
    expect(save).toHaveBeenCalledOnce()
    expect(registry.hasUnsavedChanges('session-1')).toBe(false)

    dirty = true
    registry.discard('session-1')
    expect(discard).toHaveBeenCalledOnce()
    expect(registry.hasUnsavedChanges('session-1')).toBe(false)

    unregister()
    expect(registry.hasUnsavedChanges('session-1')).toBe(false)
  })

  it('stops saving when an editor cannot persist its draft', async () => {
    const registry = new RpaSessionDraftRegistry()
    const failedSave = vi.fn(async () => false)
    const skippedSave = vi.fn(async () => true)
    registry.register('session-1', 'editor-1', { isDirty: () => true, save: failedSave, discard: vi.fn() })
    registry.register('session-1', 'editor-2', { isDirty: () => true, save: skippedSave, discard: vi.fn() })

    await expect(registry.save('session-1')).resolves.toBe(false)
    expect(failedSave).toHaveBeenCalledOnce()
    expect(skippedSave).not.toHaveBeenCalled()
  })
})
