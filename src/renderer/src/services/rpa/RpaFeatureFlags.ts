import { loggerService } from '@logger'

const logger = loggerService.withContext('RpaFeatureFlags')

export const RPA_CONSOLIDATED_ASSISTANT_SETTINGS_FLAG = 'rpa_consolidated_assistant_settings'
export const RPA_SESSION_ORCHESTRATOR_PREVIEW_FLAG = 'rpa_session_orchestrator_preview'
export const RPA_SESSION_SUPPLEMENTS_FLAG = 'rpa_session_supplements'

export interface RpaFeatureFlagStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function isConsolidatedAssistantSettingsEnabled(
  storage: RpaFeatureFlagStorage | undefined = getFeatureFlagStorage()
): boolean {
  if (!storage) return true

  try {
    const value = storage.getItem(RPA_CONSOLIDATED_ASSISTANT_SETTINGS_FLAG)
    return value === null ? true : value !== 'false'
  } catch (error) {
    logger.warn('Failed to read RPA consolidated assistant settings feature flag', { error })
    return true
  }
}

export function setConsolidatedAssistantSettingsEnabled(
  enabled: boolean | undefined,
  storage: RpaFeatureFlagStorage | undefined = getFeatureFlagStorage()
): void {
  if (!storage) return

  try {
    if (enabled === undefined) {
      storage.removeItem(RPA_CONSOLIDATED_ASSISTANT_SETTINGS_FLAG)
    } else {
      storage.setItem(RPA_CONSOLIDATED_ASSISTANT_SETTINGS_FLAG, String(enabled))
    }
  } catch (error) {
    logger.warn('Failed to update RPA consolidated assistant settings feature flag', { error })
  }
}

export function isRpaSessionOrchestratorPreviewEnabled(
  storage: RpaFeatureFlagStorage | undefined = getFeatureFlagStorage(),
  developmentDefault = import.meta.env.DEV
): boolean {
  if (!storage) return developmentDefault
  try {
    const value = storage.getItem(RPA_SESSION_ORCHESTRATOR_PREVIEW_FLAG)
    return value === null ? developmentDefault : value === 'true'
  } catch (error) {
    logger.warn('Failed to read RPA Session Orchestrator preview flag', { error })
    return developmentDefault
  }
}

export function isRpaSessionSupplementsEnabled(
  storage: RpaFeatureFlagStorage | undefined = getFeatureFlagStorage(),
  defaultValue = true
): boolean {
  if (!storage) return defaultValue
  try {
    const value = storage.getItem(RPA_SESSION_SUPPLEMENTS_FLAG)
    return value === null ? defaultValue : value === 'true'
  } catch (error) {
    logger.warn('Failed to read RPA Session Supplements feature flag', { error })
    return defaultValue
  }
}

export function setRpaSessionSupplementsEnabled(
  enabled: boolean | undefined,
  storage: RpaFeatureFlagStorage | undefined = getFeatureFlagStorage()
): void {
  if (!storage) return
  try {
    if (enabled === undefined) storage.removeItem(RPA_SESSION_SUPPLEMENTS_FLAG)
    else storage.setItem(RPA_SESSION_SUPPLEMENTS_FLAG, String(enabled))
  } catch (error) {
    logger.warn('Failed to update RPA Session Supplements feature flag', { error })
  }
}

function getFeatureFlagStorage(): RpaFeatureFlagStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}
