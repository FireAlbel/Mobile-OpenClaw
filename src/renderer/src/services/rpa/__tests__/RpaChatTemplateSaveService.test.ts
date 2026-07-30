import { describe, expect, it } from 'vitest'

import { RpaChatTemplateSaveService } from '../RpaChatTemplateSaveService'
import { type RpaTemplateRecord, RpaTemplateRepository, type RpaTemplateStorage } from '../RpaTemplateRepository'

class MemoryTemplateStorage implements RpaTemplateStorage {
  templates: RpaTemplateRecord[] = []
  async loadTemplates() {
    return structuredClone(this.templates)
  }
  async saveTemplates(templates: RpaTemplateRecord[]) {
    this.templates = structuredClone(templates)
  }
}

function validTask() {
  return {
    id: 'chat-task',
    name: 'Open app',
    goal: 'Open the target app',
    deviceIds: ['old-device'],
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

const source = { messageId: 'message-1', topicId: 'topic-1', blockId: 'block-1', assistantId: 'assistant-1' }

describe('RpaChatTemplateSaveService', () => {
  it('saves valid chat DSL with source context and unassigned devices', async () => {
    const storage = new MemoryTemplateStorage()
    const repository = new RpaTemplateRepository(storage, () => 1_000)
    const service = new RpaChatTemplateSaveService(repository)

    const result = await service.save({ mode: 'new', name: 'Chat template', tags: ['chat'], dsl: validTask(), source })

    expect(result.status).toBe('saved')
    if (result.status !== 'saved') return
    expect(result.template).toMatchObject({
      status: 'executable',
      source: 'chat',
      sourceRef: 'message-1',
      sourceContext: {
        messageId: 'message-1',
        topicId: 'topic-1',
        blockId: 'block-1',
        assistantId: 'assistant-1',
        appPackage: 'com.example.app',
        moduleIds: ['launch_app'],
        createdFrom: 'chat_rpa_block'
      }
    })
    expect((result.template.dsl as ReturnType<typeof validTask>).deviceIds).toEqual([])
  })

  it('returns a conflict instead of silently replacing a same-name template', async () => {
    const repository = new RpaTemplateRepository(new MemoryTemplateStorage(), () => 2_000)
    const service = new RpaChatTemplateSaveService(repository)
    await service.save({ mode: 'new', name: 'Same name', tags: [], dsl: validTask(), source })

    const result = await service.save({ mode: 'new', name: 'same NAME', tags: [], dsl: validTask(), source })

    expect(result).toMatchObject({
      status: 'name_conflict',
      conflicts: [expect.objectContaining({ name: 'Same name' })]
    })
  })

  it('allows invalid DSL only as a non-executable draft', async () => {
    const repository = new RpaTemplateRepository(new MemoryTemplateStorage(), () => 3_000)
    const service = new RpaChatTemplateSaveService(repository)

    const result = await service.save({ mode: 'new', name: 'Broken draft', tags: [], dsl: { id: 'broken' }, source })

    expect(result.status).toBe('saved')
    if (result.status === 'saved') {
      expect(result.template.status).toBe('draft')
      expect(result.template.validationIssues.length).toBeGreaterThan(0)
    }
  })

  it('distinguishes overwrite from creating a new version', async () => {
    let now = 4_000
    const repository = new RpaTemplateRepository(new MemoryTemplateStorage(), () => now++)
    const service = new RpaChatTemplateSaveService(repository)
    const created = await service.save({ mode: 'new', name: 'Versioned', tags: [], dsl: validTask(), source })
    if (created.status !== 'saved') throw new Error('Expected initial save')

    const overwritten = await service.save({
      mode: 'overwrite',
      targetTemplateId: created.template.id,
      name: 'Versioned',
      goal: 'Overwrite goal',
      tags: [],
      dsl: { ...validTask(), goal: 'Overwrite goal' },
      source
    })
    if (overwritten.status !== 'saved') throw new Error('Expected overwrite')
    expect(overwritten.template.version).toBe(1)
    expect(overwritten.template.revisions).toEqual([])

    const versioned = await service.save({
      mode: 'new_version',
      targetTemplateId: created.template.id,
      name: 'Versioned',
      goal: 'Version two',
      tags: [],
      dsl: { ...validTask(), goal: 'Version two' },
      source
    })
    if (versioned.status !== 'saved') throw new Error('Expected version save')
    expect(versioned.template.version).toBe(2)
    expect(versioned.template.revisions).toHaveLength(1)
  })
})
