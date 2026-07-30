import { describe, expect, it } from 'vitest'

import {
  isConsolidatedAssistantSettingsEnabled,
  isRpaSessionOrchestratorPreviewEnabled,
  RPA_CONSOLIDATED_ASSISTANT_SETTINGS_FLAG,
  RPA_SESSION_ORCHESTRATOR_PREVIEW_FLAG,
  type RpaFeatureFlagStorage,
  setConsolidatedAssistantSettingsEnabled
} from '../RpaFeatureFlags'

class MemoryFlagStorage implements RpaFeatureFlagStorage {
  values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

describe('RpaFeatureFlags', () => {
  it('enables consolidated assistant settings by default and supports rollback', () => {
    const storage = new MemoryFlagStorage()

    expect(isConsolidatedAssistantSettingsEnabled(storage)).toBe(true)
    setConsolidatedAssistantSettingsEnabled(false, storage)
    expect(storage.values.get(RPA_CONSOLIDATED_ASSISTANT_SETTINGS_FLAG)).toBe('false')
    expect(isConsolidatedAssistantSettingsEnabled(storage)).toBe(false)

    setConsolidatedAssistantSettingsEnabled(true, storage)
    expect(isConsolidatedAssistantSettingsEnabled(storage)).toBe(true)

    setConsolidatedAssistantSettingsEnabled(undefined, storage)
    expect(isConsolidatedAssistantSettingsEnabled(storage)).toBe(true)
  })

  it('keeps Session Orchestrator preview explicit outside development', () => {
    const storage = new MemoryFlagStorage()
    expect(isRpaSessionOrchestratorPreviewEnabled(storage, false)).toBe(false)
    storage.setItem(RPA_SESSION_ORCHESTRATOR_PREVIEW_FLAG, 'true')
    expect(isRpaSessionOrchestratorPreviewEnabled(storage, false)).toBe(true)
    storage.setItem(RPA_SESSION_ORCHESTRATOR_PREVIEW_FLAG, 'false')
    expect(isRpaSessionOrchestratorPreviewEnabled(storage, true)).toBe(false)
  })
})
