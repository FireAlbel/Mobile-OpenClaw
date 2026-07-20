import type * as z from 'zod'

import type { RpaActionModule, RpaModuleMetadata } from './RpaTypes'

export class RpaModuleRegistry {
  private modules = new Map<string, RpaActionModule>()

  register(module: RpaActionModule): void {
    const moduleId = module.metadata.id
    if (!['low', 'medium', 'high'].includes(module.metadata.riskLevel)) {
      throw new Error(`RPA module ${moduleId} must declare a valid risk level`)
    }
    if (this.modules.has(moduleId)) {
      throw new Error(`Duplicate RPA module id: ${moduleId}`)
    }
    this.modules.set(moduleId, module)
  }

  get(moduleId: string): RpaActionModule | undefined {
    return this.modules.get(moduleId)
  }

  require(moduleId: string): RpaActionModule {
    const module = this.get(moduleId)
    if (!module) {
      throw new Error(`Unknown RPA module: ${moduleId}`)
    }
    return module
  }

  has(moduleId: string): boolean {
    return this.modules.has(moduleId)
  }

  list(): RpaActionModule[] {
    return [...this.modules.values()]
  }

  listMetadata(): RpaModuleMetadata[] {
    return this.list().map((module) => module.metadata)
  }

  listForPlanner(): Array<RpaModuleMetadata & { paramsSchemaDescription: string }> {
    return this.list().map((module) => ({
      ...module.metadata,
      paramsSchemaDescription: describeZodSchema(module.paramsSchema)
    }))
  }

  validateParams(moduleId: string, params: unknown): { success: boolean; data?: unknown; issues: string[] } {
    const module = this.get(moduleId)
    if (!module) {
      return { success: false, issues: [`Unknown RPA module: ${moduleId}`] }
    }

    const result = module.paramsSchema.safeParse(params)
    if (result.success) {
      return { success: true, data: result.data, issues: [] }
    }

    return {
      success: false,
      issues: result.error.issues.map((issue) => `${issue.path.join('.') || 'params'}: ${issue.message}`)
    }
  }
}

function describeZodSchema(schema: z.ZodType): string {
  const definition = (schema as z.ZodType & { def?: { type?: string } }).def
  return definition?.type ? `zod:${definition.type}` : 'zod:schema'
}

export const rpaModuleRegistry = new RpaModuleRegistry()
