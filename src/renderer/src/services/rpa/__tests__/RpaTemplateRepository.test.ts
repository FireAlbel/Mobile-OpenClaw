import { describe, expect, it } from 'vitest'

import {
  getTemplateAppPackage,
  getTemplateTask,
  type RpaTemplateRecord,
  RpaTemplateRepository,
  type RpaTemplateStorage
} from '../RpaTemplateRepository'

class MemoryTemplateStorage implements RpaTemplateStorage {
  templates: RpaTemplateRecord[] = []
  async loadTemplates() {
    return structuredClone(this.templates)
  }
  async saveTemplates(templates: RpaTemplateRecord[]) {
    this.templates = structuredClone(templates)
  }
}

function validTask(id = 'task-1') {
  return {
    id,
    name: 'Open app',
    goal: 'Open the target app',
    deviceIds: [],
    steps: [
      {
        id: 'step-1',
        name: 'Launch',
        moduleId: 'launch_app',
        params: { packageName: 'com.example.app' },
        verify: { type: 'foreground_app', packageName: 'com.example.app' }
      }
    ]
  }
}

describe('RpaTemplateRepository', () => {
  it('lists saved executable DSL with device assignment removed', async () => {
    const repository = new RpaTemplateRepository(new MemoryTemplateStorage(), () => 1_000)
    const saved = await repository.save({ dsl: { ...validTask(), deviceIds: ['device-1'] }, tags: ['demo'] })

    expect(saved.status).toBe('executable')
    expect(getTemplateTask(saved)?.deviceIds).toEqual([])
    expect(getTemplateAppPackage(saved)).toBe('com.example.app')
    await expect(repository.getAll()).resolves.toEqual([saved])
  })

  it('keeps invalid DSL as a non-executable draft', async () => {
    const repository = new RpaTemplateRepository(new MemoryTemplateStorage(), () => 2_000)
    const saved = await repository.save({ name: 'Broken draft', dsl: { id: 'broken' } })

    expect(saved.status).toBe('draft')
    expect(saved.validationIssues.length).toBeGreaterThan(0)
    expect(getTemplateTask(saved)).toBeUndefined()
  })

  it('increments versions, keeps revisions, and duplicates with a new task identity', async () => {
    let now = 3_000
    const repository = new RpaTemplateRepository(new MemoryTemplateStorage(), () => now++)
    const first = await repository.save({ dsl: validTask() })
    const second = await repository.save({ id: first.id, dsl: { ...validTask(), goal: 'Updated goal' } })
    const duplicate = await repository.duplicate(second.id)

    expect(second.version).toBe(2)
    expect(second.revisions).toHaveLength(1)
    expect(duplicate.id).not.toBe(second.id)
    expect(getTemplateTask(duplicate)?.id).not.toBe(getTemplateTask(second)?.id)
  })

  it('overwrites without incrementing the template version', async () => {
    let now = 3_500
    const repository = new RpaTemplateRepository(new MemoryTemplateStorage(), () => now++)
    const first = await repository.save({ dsl: validTask() })
    const overwritten = await repository.save({
      id: first.id,
      dsl: { ...validTask(), goal: 'Overwritten' },
      saveMode: 'overwrite'
    })

    expect(overwritten.version).toBe(1)
    expect(overwritten.revisions).toEqual([])
  })

  it('does not expose legacy Taskflow records as RPA templates', async () => {
    const storage = new MemoryTemplateStorage()
    storage.templates = [
      {
        id: 'legacy-1',
        version: 1,
        name: 'Legacy flow',
        goal: 'Legacy flow',
        dsl: { legacyTask: true },
        status: 'unsupported_legacy',
        validationIssues: [],
        tags: [],
        skillLinks: [],
        source: 'legacy_taskflow',
        revisions: [],
        createdAt: 1,
        updatedAt: 1
      } as unknown as RpaTemplateRecord
    ]
    const repository = new RpaTemplateRepository(storage, () => 4_000)

    await expect(repository.getAll()).resolves.toEqual([])
  })
})
