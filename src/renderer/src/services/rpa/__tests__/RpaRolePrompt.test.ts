import { describe, expect, it } from 'vitest'

import {
  type RpaRolePrompt,
  RpaRolePromptRepository,
  type RpaRolePromptStorage,
  sanitizeRpaRolePrompt,
  sanitizeRpaRolePrompts
} from '../RpaRolePrompt'

class MemoryPromptStorage implements RpaRolePromptStorage {
  prompts: RpaRolePrompt[] = []

  async loadRolePrompts(): Promise<RpaRolePrompt[]> {
    return structuredClone(this.prompts)
  }

  async saveRolePrompts(prompts: RpaRolePrompt[]): Promise<void> {
    this.prompts = structuredClone(prompts)
  }
}

describe('RpaRolePrompt', () => {
  it('sanitizes a versioned capability prompt', () => {
    const prompt = sanitizeRpaRolePrompt({
      schemaVersion: 1,
      id: ' prompt-1 ',
      roleId: ' role-1 ',
      version: ' 2 ',
      kind: 'capability',
      capability: ' android.home ',
      content: ' Use Home only when recovery requires it. ',
      priority: 200,
      status: 'enabled',
      createdAt: 10,
      updatedAt: 20
    })

    expect(prompt).toMatchObject({
      id: 'prompt-1',
      roleId: 'role-1',
      version: '2',
      capability: 'android.home',
      priority: 100
    })
  })

  it('deduplicates prompts by qualified id and version', () => {
    const prompt = {
      schemaVersion: 1,
      id: 'prompt-1',
      roleId: 'role-1',
      version: '1',
      kind: 'planner',
      content: 'Plan the app workflow.',
      status: 'enabled',
      priority: 0,
      createdAt: 1,
      updatedAt: 1
    }

    expect(sanitizeRpaRolePrompts([prompt, prompt])).toHaveLength(1)
  })

  it('creates immutable numeric prompt versions and removes a selected version', async () => {
    const storage = new MemoryPromptStorage()
    let now = 10
    const repository = new RpaRolePromptRepository(storage, () => now)
    const input: RpaRolePrompt = {
      schemaVersion: 1,
      id: 'planner',
      roleId: 'role-1',
      version: '1',
      kind: 'planner',
      content: 'First version',
      priority: 0,
      status: 'enabled',
      createdAt: now,
      updatedAt: now
    }

    await repository.save(input)
    now = 20
    const second = await repository.save({ ...input, content: 'Second version' })

    expect(second).toMatchObject({ version: '2', createdAt: 10, updatedAt: 20 })
    expect(await repository.getByRoleId('role-1')).toHaveLength(2)
    await expect(repository.remove('role-1', 'planner', '1')).resolves.toBe(true)
    expect((await repository.getByRoleId('role-1')).map((prompt) => prompt.version)).toEqual(['2'])
  })
})
