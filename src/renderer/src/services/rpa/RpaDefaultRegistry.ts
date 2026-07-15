import { baseRpaModules } from './RpaBaseModules'
import { RpaModuleRegistry } from './RpaModuleRegistry'

export function createDefaultRpaModuleRegistry(): RpaModuleRegistry {
  const registry = new RpaModuleRegistry()
  for (const module of baseRpaModules) {
    registry.register(module)
  }
  return registry
}

export const defaultRpaModuleRegistry = createDefaultRpaModuleRegistry()
