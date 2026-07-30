import type { KnowledgeBase } from '@renderer/types'
import { describe, expect, it } from 'vitest'

import {
  createKnowledgeAssetCatalog,
  createRpaTemplateAssetCatalog,
  loadCompatibilitySkillCatalog
} from '../RpaAssistantAssetCatalog'

describe('RpaAssistantAssetCatalog', () => {
  it('describes knowledge status and version for profile selection', () => {
    const bases = [
      { id: 'ready', name: 'Ready KB', version: 3, items: [{ processingStatus: 'completed' }] },
      { id: 'empty', name: 'Empty KB', version: 1, items: [] },
      { id: 'error', name: 'Error KB', version: 2, items: [{ processingStatus: 'failed' }] }
    ] as KnowledgeBase[]

    expect(createKnowledgeAssetCatalog(bases)).toMatchObject([
      { id: 'empty', status: 'empty', version: '1' },
      { id: 'error', status: 'error', version: '2' },
      { id: 'ready', status: 'ready', version: '3' }
    ])
  })

  it('builds the catalog from current RPA templates and their dependencies', () => {
    const templates = [
      {
        id: 'template-1',
        version: 3,
        name: 'Template',
        goal: 'Goal',
        status: 'executable',
        dsl: {
          metadata: {
            rpaDependencies: {
              requiredSkills: [{ skillId: 'skill-1', versionRange: '^2' }],
              optionalKnowledge: ['kb-1']
            }
          }
        },
        validationIssues: [],
        tags: [],
        skillLinks: [],
        source: 'manual',
        revisions: [],
        createdAt: 1,
        updatedAt: 1
      }
    ] as Parameters<typeof createRpaTemplateAssetCatalog>[0]

    expect(createRpaTemplateAssetCatalog(templates)[0]).toMatchObject({
      id: 'template-1',
      version: '3',
      status: 'ready',
      requiredSkills: [{ skillId: 'skill-1', versionRange: '^2' }],
      optionalKnowledge: [{ knowledgeId: 'kb-1' }]
    })
  })

  it('reads compatibility Skills without owning their content', () => {
    const skillStorage = {
      getItem: (key: string) =>
        key === 'rpa_skills' ? JSON.stringify([{ id: 'skill-1', name: 'Skill', version: '2.0.0' }]) : null
    }

    expect(loadCompatibilitySkillCatalog(skillStorage)).toMatchObject([
      { id: 'skill-1', version: '2.0.0', status: 'ready' }
    ])
  })
})
