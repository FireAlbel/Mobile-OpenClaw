import type { RpaTemplateRecord } from './RpaTemplateRepository'
import { rpaTemplateRepository } from './RpaTemplateRepository'

export type RpaChatTemplateSaveMode = 'new' | 'overwrite' | 'new_version'

export interface RpaChatTemplateSource {
  messageId: string
  topicId: string
  blockId: string
  assistantId?: string
}

export interface SaveChatRpaTemplateInput {
  mode: RpaChatTemplateSaveMode
  name: string
  goal?: string
  tags: string[]
  dsl: unknown
  targetTemplateId?: string
  source: RpaChatTemplateSource
}

export type SaveChatRpaTemplateResult =
  | { status: 'saved'; template: RpaTemplateRecord }
  | { status: 'name_conflict'; conflicts: RpaTemplateRecord[] }

export class RpaChatTemplateSaveService {
  constructor(private readonly repository: typeof rpaTemplateRepository = rpaTemplateRepository) {}

  async save(input: SaveChatRpaTemplateInput): Promise<SaveChatRpaTemplateResult> {
    const name = input.name.trim()
    if (!name) throw new Error('Template name is required')
    const conflicts = await this.repository.findByName(name)
    if (input.mode === 'new' && conflicts.length > 0) return { status: 'name_conflict', conflicts }

    const target = input.mode === 'new' ? undefined : await this.requireTarget(input.targetTemplateId)
    const task = isRecord(input.dsl) ? input.dsl : {}
    const steps = Array.isArray(task.steps) ? task.steps.filter(isRecord) : []
    const launch = steps.find((step) => step.moduleId === 'launch_app')
    const appPackage =
      isRecord(launch?.params) && typeof launch.params.packageName === 'string' ? launch.params.packageName : undefined
    const template = await this.repository.save({
      id: target?.id,
      name,
      goal: input.goal,
      dsl: input.dsl,
      tags: input.tags,
      skillLinks: target?.skillLinks,
      source: 'chat',
      sourceRef: input.source.messageId,
      sourceContext: {
        ...input.source,
        appPackage,
        moduleIds: steps.map((step) => step.moduleId).filter((value): value is string => typeof value === 'string'),
        createdFrom: 'chat_rpa_block'
      },
      saveMode: input.mode
    })
    return { status: 'saved', template }
  }

  private async requireTarget(id?: string): Promise<RpaTemplateRecord> {
    if (!id) throw new Error('Target template is required')
    const template = await this.repository.getById(id)
    if (!template) throw new Error(`RPA template not found: ${id}`)
    return template
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const rpaChatTemplateSaveService = new RpaChatTemplateSaveService()
