import FileManager from '@renderer/services/FileManager'

import { type RpaArtifact, rpaArtifactStore } from './RpaArtifactStore'
import { createDefaultRpaModuleRegistry } from './RpaDefaultRegistry'
import { createDefaultRpaKnowledgeEntry, redactRpaKnowledgeText, rpaKnowledgeRepository } from './RpaKnowledge'
import type { RpaModuleRegistry } from './RpaModuleRegistry'
import { RpaTaskValidator } from './RpaTaskValidator'
import { rpaTemplateRepository } from './RpaTemplateRepository'
import type { RpaTask } from './RpaTypes'

export interface RpaArtifactImportOptions {
  knowledgeBaseId?: string
}

export type RpaArtifactImportResult =
  | { target: 'knowledge_draft'; artifact: RpaArtifact; knowledgeEntryId: string }
  | { target: 'rpa_template_draft'; artifact: RpaArtifact; task: RpaTask }
  | { target: 'unsupported'; artifact: RpaArtifact; reason: string }

export interface RpaArtifactImportRouterOptions {
  registry?: RpaModuleRegistry
  artifactStore?: typeof rpaArtifactStore
  knowledgeRepository?: typeof rpaKnowledgeRepository
  templateRepository?: typeof rpaTemplateRepository
  readText?: (artifact: RpaArtifact) => Promise<string>
  now?: () => number
}

export class RpaArtifactImportRouter {
  private readonly validator: RpaTaskValidator
  private readonly artifactStore: typeof rpaArtifactStore
  private readonly knowledgeRepository: typeof rpaKnowledgeRepository
  private readonly templateRepository: typeof rpaTemplateRepository
  private readonly readText: (artifact: RpaArtifact) => Promise<string>
  private readonly now: () => number

  constructor(options: RpaArtifactImportRouterOptions = {}) {
    this.validator = new RpaTaskValidator(options.registry ?? createDefaultRpaModuleRegistry(), {
      requireDeviceIds: false
    })
    this.artifactStore = options.artifactStore ?? rpaArtifactStore
    this.knowledgeRepository = options.knowledgeRepository ?? rpaKnowledgeRepository
    this.templateRepository = options.templateRepository ?? rpaTemplateRepository
    this.readText = options.readText ?? readArtifactText
    this.now = options.now ?? Date.now
  }

  async import(artifact: RpaArtifact, options: RpaArtifactImportOptions = {}): Promise<RpaArtifactImportResult> {
    const extension = artifact.locator.extension?.toLowerCase() ?? ''
    if (artifact.category === 'sop_import') {
      if (!options.knowledgeBaseId) throw new Error('Knowledge base selection is required for SOP import')
      const rawText = isReadableTextExtension(extension) ? await this.readText(artifact) : ''
      const content = redactRpaKnowledgeText(
        rawText || `Imported SOP document reference: ${artifact.locator.originalName ?? artifact.title}`,
        12_000
      )
      const entry = await this.knowledgeRepository.save({
        ...createDefaultRpaKnowledgeEntry(options.knowledgeBaseId, 'app_sop', this.now()),
        title: artifact.title,
        summary: `Imported SOP draft from ${artifact.locator.originalName ?? artifact.title}`,
        content: content.text,
        reviewStatus: 'draft',
        confidence: 0.5,
        source: { type: 'imported_manual' },
        links: {
          templateIds: [],
          skills: [],
          stateIds: [],
          failureFingerprintIds: [],
          artifactIds: [artifact.id]
        },
        redactions: content.redactions
      })
      const updated = await this.artifactStore.update({
        ...artifact,
        links: [...artifact.links, { targetType: 'knowledge', targetId: entry.id, relation: 'imported_source' }],
        importState: {
          target: 'knowledge_draft',
          status: 'imported',
          targetId: entry.id,
          issues: [],
          importedAt: this.now()
        }
      })
      return { target: 'knowledge_draft', artifact: updated, knowledgeEntryId: entry.id }
    }

    if (artifact.category === 'exported_dsl' && extension === '.json') {
      const rawText = await this.readText(artifact)
      let parsed: unknown
      try {
        parsed = JSON.parse(rawText)
      } catch (error) {
        return this.markFailedTemplateImport(artifact, [error instanceof Error ? error.message : String(error)])
      }
      const validation = this.validator.validate(parsed)
      if (!validation.success || !validation.task) {
        return this.markFailedTemplateImport(
          artifact,
          validation.issues.map((issue) => `${issue.path}: ${issue.message}`)
        )
      }
      const task = { ...validation.task, deviceIds: [] }
      const template = await this.templateRepository.save({
        name: task.name,
        goal: task.goal,
        dsl: task,
        source: 'artifact_import',
        sourceRef: artifact.id,
        sourceContext: {
          appPackage: readAppPackage(task),
          moduleIds: task.steps.map((step) => step.moduleId),
          createdFrom: 'artifact_import'
        }
      })
      const updated = await this.artifactStore.update({
        ...artifact,
        links: [...artifact.links, { targetType: 'rpa_template', targetId: template.id, relation: 'imported_draft' }],
        importState: {
          target: 'rpa_template_draft',
          status: 'ready',
          targetId: template.id,
          issues: []
        }
      })
      return { target: 'rpa_template_draft', artifact: updated, task }
    }

    const reason = `Unsupported artifact type: ${extension || artifact.category}`
    const updated = await this.artifactStore.update({
      ...artifact,
      importState: { target: 'unsupported', status: 'ready', issues: [reason] }
    })
    return { target: 'unsupported', artifact: updated, reason }
  }

  private async markFailedTemplateImport(artifact: RpaArtifact, issues: string[]): Promise<RpaArtifactImportResult> {
    const updated = await this.artifactStore.update({
      ...artifact,
      importState: { target: 'rpa_template_draft', status: 'failed', issues }
    })
    return { target: 'unsupported', artifact: updated, reason: issues.join('; ') }
  }
}

async function readArtifactText(artifact: RpaArtifact): Promise<string> {
  if (artifact.locator.externalPath) return window.api.fs.readText(artifact.locator.externalPath)
  if (artifact.locator.fileId) {
    const file = await FileManager.getFile(artifact.locator.fileId)
    if (file) return window.api.fs.readText(FileManager.getFilePath(file))
  }
  throw new Error('Artifact file is unavailable')
}

function isReadableTextExtension(extension: string): boolean {
  return ['.txt', '.md', '.html'].includes(extension)
}

function readAppPackage(task: RpaTask): string | undefined {
  const launch = task.steps.find((step) => step.moduleId === 'launch_app')
  return typeof launch?.params.packageName === 'string' ? launch.params.packageName : undefined
}

export const rpaArtifactImportRouter = new RpaArtifactImportRouter()
