import { describe, expect, it } from 'vitest'

import { RpaArtifactImportRouter } from '../RpaArtifactImportRouter'
import type { RpaArtifact, RpaArtifactStorage } from '../RpaArtifactStore'
import { RpaArtifactStore } from '../RpaArtifactStore'
import { type RpaKnowledgeEntry, RpaKnowledgeRepository, type RpaKnowledgeStorage } from '../RpaKnowledge'
import { type RpaTemplateRecord, RpaTemplateRepository, type RpaTemplateStorage } from '../RpaTemplateRepository'

class MemoryArtifactStorage implements RpaArtifactStorage {
  artifacts: RpaArtifact[] = []
  async loadArtifacts() {
    return structuredClone(this.artifacts)
  }
  async saveArtifacts(artifacts: RpaArtifact[]) {
    this.artifacts = structuredClone(artifacts)
  }
}

class MemoryKnowledgeStorage implements RpaKnowledgeStorage {
  entries: RpaKnowledgeEntry[] = []
  async loadEntries() {
    return structuredClone(this.entries)
  }
  async saveEntries(entries: RpaKnowledgeEntry[]) {
    this.entries = structuredClone(entries)
  }
}

class MemoryTemplateStorage implements RpaTemplateStorage {
  templates: RpaTemplateRecord[] = []
  async loadTemplates() {
    return structuredClone(this.templates)
  }
  async saveTemplates(templates: RpaTemplateRecord[]) {
    this.templates = structuredClone(templates)
  }
}

async function setup(category: RpaArtifact['category'], extension: string, text: string) {
  const artifactStorage = new MemoryArtifactStorage()
  const artifactStore = new RpaArtifactStore(artifactStorage, undefined, () => 1_000)
  const artifact = (
    await artifactStore.register({
      title: `fixture${extension}`,
      category,
      sizeBytes: text.length,
      source: 'uploaded',
      locator: { externalPath: `D:/fixture${extension}`, extension }
    })
  ).artifact
  const knowledgeStorage = new MemoryKnowledgeStorage()
  const knowledgeRepository = new RpaKnowledgeRepository(knowledgeStorage, () => 2_000)
  const templateStorage = new MemoryTemplateStorage()
  const templateRepository = new RpaTemplateRepository(templateStorage, () => 2_500)
  const router = new RpaArtifactImportRouter({
    artifactStore,
    knowledgeRepository,
    templateRepository,
    readText: async () => text,
    now: () => 3_000
  })
  return { artifact, artifactStore, knowledgeStorage, router, templateStorage }
}

describe('RpaArtifactImportRouter', () => {
  it('routes readable SOPs to redacted Knowledge drafts', async () => {
    const { artifact, knowledgeStorage, router } = await setup('sop_import', '.md', 'Call 13800138000 for help')

    const result = await router.import(artifact, { knowledgeBaseId: 'kb-1' })

    expect(result.target).toBe('knowledge_draft')
    expect(knowledgeStorage.entries[0]).toMatchObject({ knowledgeBaseId: 'kb-1', reviewStatus: 'draft' })
    expect(knowledgeStorage.entries[0].content).toContain('[REDACTED:phone]')
    expect(knowledgeStorage.entries[0].links.artifactIds).toEqual([artifact.id])
  })

  it('validates JSON DSL and creates an RPA template draft', async () => {
    const dsl = JSON.stringify({
      id: 'task-1',
      name: 'Open app',
      goal: 'Open target app',
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
    })
    const { artifact, router, templateStorage } = await setup('exported_dsl', '.json', dsl)

    const result = await router.import(artifact)

    expect(result.target).toBe('rpa_template_draft')
    if (result.target === 'rpa_template_draft') expect(result.task.deviceIds).toEqual([])
    expect(result.artifact.importState).toMatchObject({ status: 'ready', targetId: templateStorage.templates[0].id })
    expect(templateStorage.templates[0]).toMatchObject({ source: 'artifact_import', sourceRef: artifact.id })
  })

  it('marks invalid DSL imports as failed without executing them', async () => {
    const { artifact, router } = await setup('exported_dsl', '.json', '{bad json')

    const result = await router.import(artifact)

    expect(result.target).toBe('unsupported')
    expect(result.artifact.importState).toMatchObject({ target: 'rpa_template_draft', status: 'failed' })
  })

  it('keeps unsupported files available in the artifact library', async () => {
    const { artifact, artifactStore, router } = await setup('other', '.bin', 'binary-reference')

    const result = await router.import(artifact)

    expect(result.target).toBe('unsupported')
    expect(await artifactStore.getById(artifact.id)).toMatchObject({ id: artifact.id, locator: artifact.locator })
  })
})
