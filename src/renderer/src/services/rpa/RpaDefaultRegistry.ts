import { baseRpaModules } from './RpaBaseModules'
import { RpaModuleRegistry } from './RpaModuleRegistry'
import { p1RpaModules } from './RpaP1Modules'

export function createDefaultRpaModuleRegistry(): RpaModuleRegistry {
  const registry = new RpaModuleRegistry()
  for (const module of [...baseRpaModules, ...p1RpaModules]) {
    registry.register(module)
  }
  return registry
}

export const defaultRpaModuleRegistry = createDefaultRpaModuleRegistry()
