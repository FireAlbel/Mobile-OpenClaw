import { describe, expect, it } from 'vitest'

import { androidSettingsAboutDeviceSkill } from '../RpaBuiltInSkills'
import { createDefaultRpaModuleRegistry } from '../RpaDefaultRegistry'
import {
  RpaSkillDefinitionSchema,
  type RpaSkillRecord,
  RpaSkillRepository,
  type RpaSkillStorage,
  validateSkillDefinition
} from '../RpaSkillRepository'
import { validSkill } from './RpaSkillTestFixtures'

class MemorySkillStorage implements RpaSkillStorage {
  skills: RpaSkillRecord[] = []
  async loadSkills() {
    return structuredClone(this.skills)
  }
  async saveSkills(skills: RpaSkillRecord[]) {
    this.skills = structuredClone(skills)
  }
}

describe('RpaSkillRepository', () => {
  it('saves a ready Skill, creates versions, and rolls back through a new version', async () => {
    let now = 100
    const repository = new RpaSkillRepository(new MemorySkillStorage(), createDefaultRpaModuleRegistry(), () => now++)
    const first = await repository.save({ definition: validSkill() })
    const second = await repository.save({ definition: { ...validSkill(), description: 'Improved' } })
    const rolledBack = await repository.rollback(second.id, '1.0.0')

    expect(first.version).toBe('1.0.0')
    expect(second.version).toBe('1.0.1')
    expect(second.revisions).toHaveLength(1)
    expect(rolledBack.version).toBe('1.0.2')
    expect(rolledBack.description).toBe(first.description)
  })

  it('rejects invalid ready Skills but keeps invalid drafts reviewable', async () => {
    const repository = new RpaSkillRepository(new MemorySkillStorage(), createDefaultRpaModuleRegistry())
    const invalid = validSkill({
      transitions: [
        {
          id: 'invalid',
          fromStateIds: ['MISSING'],
          toStateId: 'DETAIL',
          priority: 0,
          steps: [{ id: 'bad', name: 'Bad', moduleId: 'missing_module', params: {}, continueOnFailure: false }]
        }
      ]
    })

    await expect(repository.save({ definition: invalid })).rejects.toThrow('Unknown')
    const draft = await repository.save({ definition: { ...invalid, status: 'draft' } })
    expect(draft.validationIssues.length).toBeGreaterThan(0)
    expect((await repository.toCatalog())[0].status).toBe('error')
  })

  it('matches ready Skills by app, goal, state alias, and allowed version', async () => {
    const repository = new RpaSkillRepository(new MemorySkillStorage(), createDefaultRpaModuleRegistry())
    await repository.save({ definition: validSkill() })

    const matches = await repository.match({
      goal: '请打开详情页面',
      appPackage: 'com.example.app',
      currentStateId: 'MAIN',
      allowedSkillIds: ['open-example-detail'],
      versionRanges: { 'open-example-detail': '^1' }
    })

    expect(matches[0]).toMatchObject({
      skill: { id: 'open-example-detail' },
      confidence: 1,
      reasons: ['app_package', 'goal', 'current_state']
    })
    await repository.setEnabled('open-example-detail', false)
    await expect(repository.match({ goal: '打开详情页面', appPackage: 'com.example.app' })).resolves.toEqual([])
  })

  it('publishes the built-in Settings Skill as a valid selectable asset', async () => {
    const registry = createDefaultRpaModuleRegistry()
    const parsed = RpaSkillDefinitionSchema.safeParse(androidSettingsAboutDeviceSkill)
    expect(parsed.success).toBe(true)
    expect(parsed.success ? validateSkillDefinition(parsed.data, registry) : parsed.error.issues).toEqual([])

    const repository = new RpaSkillRepository(new MemorySkillStorage(), registry, () => 1, [
      androidSettingsAboutDeviceSkill
    ])
    await expect(repository.toCatalog()).resolves.toMatchObject([
      { id: 'android-settings-about-device', version: '1.0.0', status: 'ready' }
    ])
    await expect(
      repository.match({
        goal: '请打开关于本机',
        appPackage: 'com.android.settings',
        allowedSkillIds: ['android-settings-about-device']
      })
    ).resolves.toMatchObject([{ skill: { id: 'android-settings-about-device' }, confidence: 0.85 }])
    const semanticMatches = await repository.match({
      goal: '\u8fdb\u5165\u5173\u4e8e\u672c\u673a',
      appPackage: 'com.android.settings',
      allowedSkillIds: ['android-settings-about-device']
    })
    expect(semanticMatches[0]?.confidence).toBeGreaterThanOrEqual(0.5)
  })
})
