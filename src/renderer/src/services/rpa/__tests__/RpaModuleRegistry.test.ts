import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { RpaModuleRegistry } from '../RpaModuleRegistry'
import type { RpaActionModule } from '../RpaTypes'

function testModule(id = 'test_module'): RpaActionModule {
  return {
    metadata: {
      id,
      name: 'Test module',
      description: 'Module used by tests',
      riskLevel: 'low',
      defaultTimeoutMs: 1000,
      defaultRetry: { maxAttempts: 1, backoffMs: 0, retryOn: ['failed'] }
    },
    paramsSchema: z.object({ value: z.string().min(1) }),
    async execute() {
      return {
        success: true,
        status: 'passed',
        message: 'ok',
        startedAt: Date.now(),
        finishedAt: Date.now()
      }
    }
  }
}

describe('RpaModuleRegistry', () => {
  it('registers and resolves modules', () => {
    const registry = new RpaModuleRegistry()
    const module = testModule()

    registry.register(module)

    expect(registry.get('test_module')).toBe(module)
    expect(registry.listMetadata()[0].id).toBe('test_module')
  })

  it('rejects duplicate module ids', () => {
    const registry = new RpaModuleRegistry()
    registry.register(testModule())

    expect(() => registry.register(testModule())).toThrow('Duplicate RPA module id')
  })

  it('validates module params', () => {
    const registry = new RpaModuleRegistry()
    registry.register(testModule())

    expect(registry.validateParams('test_module', { value: 'ok' }).success).toBe(true)
    expect(registry.validateParams('test_module', { value: '' }).success).toBe(false)
  })
})
