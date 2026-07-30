import { describe, expect, it } from 'vitest'

import {
  DEFAULT_RPA_ARTIFACT_POLICY,
  type RpaArtifact,
  type RpaArtifactStorage,
  RpaArtifactStore
} from '../RpaArtifactStore'
import { createDefaultRpaModuleRegistry } from '../RpaDefaultRegistry'
import {
  type RpaImprovementProposal,
  RpaImprovementProposalRepository,
  RpaImprovementProposalService,
  type RpaImprovementProposalStorage,
  type RpaSkillImprovementAdapter,
  RpaSkillRepositoryImprovementAdapter
} from '../RpaImprovementProposal'
import { type RpaKnowledgeEntry, RpaKnowledgeRepository, type RpaKnowledgeStorage } from '../RpaKnowledge'
import type { RpaBatchRunRecord } from '../RpaRunStorage'
import { type RpaSkillRecord, RpaSkillRepository, type RpaSkillStorage } from '../RpaSkillRepository'
import { type RpaTemplateRecord, RpaTemplateRepository, type RpaTemplateStorage } from '../RpaTemplateRepository'
import type { RpaTask } from '../RpaTypes'
import { validSkill } from './RpaSkillTestFixtures'

class MemoryProposalStorage implements RpaImprovementProposalStorage {
  proposals: RpaImprovementProposal[] = []
  async loadProposals() {
    return structuredClone(this.proposals)
  }
  async saveProposals(proposals: RpaImprovementProposal[]) {
    this.proposals = structuredClone(proposals)
  }
}

class MemoryTemplateStorage implements RpaTemplateStorage {
  templates: RpaTemplateRecord[] = []
  failWrites = false
  async loadTemplates() {
    return structuredClone(this.templates)
  }
  async saveTemplates(templates: RpaTemplateRecord[]) {
    if (this.failWrites) throw new Error('template write failed')
    this.templates = structuredClone(templates)
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

class MemoryArtifactStorage implements RpaArtifactStorage {
  artifacts: RpaArtifact[] = []
  async loadArtifacts() {
    return structuredClone(this.artifacts)
  }
  async saveArtifacts(artifacts: RpaArtifact[]) {
    this.artifacts = structuredClone(artifacts)
  }
}

class MemorySkillStorage implements RpaSkillStorage {
  skills: RpaSkillRecord[] = []
  async loadSkills() {
    return structuredClone(this.skills)
  }
  async saveSkills(skills: RpaSkillRecord[]) {
    this.skills = structuredClone(skills)
  }
}

const validTask = (goal = 'Open the target app'): RpaTask => ({
  id: 'task-1',
  name: 'Open app',
  goal,
  deviceIds: [],
  steps: [
    {
      id: 'step-1',
      name: 'Launch',
      moduleId: 'launch_app',
      params: { packageName: 'com.example.app' },
      verify: { type: 'foreground_app', packageName: 'com.example.app' },
      continueOnFailure: false
    }
  ],
  metadata: {}
})

function failedRun(): RpaBatchRunRecord {
  return {
    id: 'run-1',
    task: { ...validTask(), deviceIds: ['device-1'] },
    deviceIds: ['device-1'],
    status: 'failed',
    createdAt: 1,
    updatedAt: 2,
    contextSnapshot: {
      sourceTemplate: { id: 'template-1', version: '1' },
      skills: []
    } as unknown as NonNullable<RpaBatchRunRecord['contextSnapshot']>,
    deviceRuns: [
      {
        id: 'device-run-1',
        batchRunId: 'run-1',
        taskId: 'task-1',
        deviceId: 'device-1',
        status: 'failed',
        error: 'Target button was not found',
        events: [],
        createdAt: 1,
        updatedAt: 2
      }
    ]
  }
}

async function createHarness(skillAdapter?: RpaSkillImprovementAdapter) {
  let now = 100
  const proposalStorage = new MemoryProposalStorage()
  const templateStorage = new MemoryTemplateStorage()
  const knowledgeStorage = new MemoryKnowledgeStorage()
  const artifactStorage = new MemoryArtifactStorage()
  const proposals = new RpaImprovementProposalRepository(proposalStorage, () => now++)
  const templates = new RpaTemplateRepository(templateStorage, () => now++)
  const knowledge = new RpaKnowledgeRepository(knowledgeStorage, () => now++)
  const artifacts = new RpaArtifactStore(artifactStorage, DEFAULT_RPA_ARTIFACT_POLICY, () => now++)
  const skills: RpaSkillImprovementAdapter = skillAdapter ?? {
    isAvailable: () => false,
    validate: async () => [],
    apply: async () => {
      throw new Error('unavailable')
    }
  }
  const service = new RpaImprovementProposalService(proposals, templates, knowledge, artifacts, skills, () => now++)
  return {
    proposals,
    templates,
    knowledge,
    artifacts,
    service,
    proposalStorage,
    templateStorage,
    knowledgeStorage,
    artifactStorage
  }
}

describe('RpaImprovementProposal', () => {
  it('creates a reviewable run proposal with trace facts, source lineage, and linked evidence', async () => {
    const harness = await createHarness()
    await harness.templates.save({ id: 'template-1', dsl: validTask() })
    const artifact = await harness.artifacts.register({
      title: 'Failure screenshot',
      category: 'screenshot',
      sizeBytes: 100,
      source: 'observation',
      locator: { externalPath: 'screen.png' },
      links: [{ targetType: 'run', targetId: 'run-1', relation: 'failure_evidence' }]
    })

    const proposal = await harness.service.createManualDraftFromRun(failedRun())

    expect(proposal).toMatchObject({
      status: 'awaiting_review',
      sourceRunIds: ['run-1'],
      sourceTemplate: { id: 'template-1', version: '1' },
      target: { type: 'template', id: 'template-1', baseVersion: '1' },
      failureClass: 'execution_failed',
      analysisSource: 'manual_draft'
    })
    expect(proposal.traceSummary).toContain('Target button was not found')
    expect(proposal.evidenceArtifactIds).toEqual([artifact.artifact.id])
    await expect(harness.artifacts.findByLink('improvement_proposal', proposal.id)).resolves.toHaveLength(1)
  })

  it('blocks application until explicit human approval', async () => {
    const harness = await createHarness()
    await harness.templates.save({ id: 'template-1', dsl: validTask() })
    const proposal = await harness.service.createManualDraftFromRun(failedRun())

    await expect(harness.service.apply(proposal.id)).rejects.toThrow('explicit approval')
    expect((await harness.templates.getById('template-1'))?.version).toBe(1)
  })

  it('applies an approved template proposal as a new version and links evidence to the target', async () => {
    const harness = await createHarness()
    await harness.templates.save({ id: 'template-1', dsl: validTask() })
    const artifact = await harness.artifacts.register({
      title: 'Trace',
      category: 'run_log',
      sizeBytes: 20,
      source: 'generated',
      locator: { externalPath: 'trace.log' },
      links: [{ targetType: 'run', targetId: 'run-1', relation: 'trace' }]
    })
    let proposal = await harness.service.createManualDraftFromRun(failedRun())
    proposal = await harness.service.saveDraft(proposal.id, {
      target: proposal.target,
      traceSummary: proposal.traceSummary,
      failureClass: proposal.failureClass,
      confidence: 0.9,
      evidenceArtifactIds: [artifact.artifact.id],
      proposedChanges: { name: 'Improved app flow', goal: 'Recover and open', dsl: validTask('Recover and open') }
    })
    await harness.proposals.approve(proposal.id, 'reviewer-1', 'Validated against the trace')

    const applied = await harness.service.apply(proposal.id)

    expect(applied).toMatchObject({
      status: 'applied',
      reviewer: 'reviewer-1',
      application: { status: 'applied', targetId: 'template-1', targetVersion: '2' },
      validation: { status: 'passed' }
    })
    expect((await harness.templates.getById('template-1'))?.revisions).toHaveLength(1)
    await expect(harness.artifacts.findByLink('rpa_template', 'template-1')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: artifact.artifact.id })])
    )
  })

  it('leaves the template unchanged when validation or source-version checks fail', async () => {
    const harness = await createHarness()
    await harness.templates.save({ id: 'template-1', dsl: validTask() })
    let proposal = await harness.service.createManualDraftFromRun(failedRun())
    proposal = await harness.service.saveDraft(proposal.id, {
      target: { ...proposal.target, baseVersion: '99' },
      traceSummary: proposal.traceSummary,
      failureClass: proposal.failureClass,
      confidence: proposal.confidence,
      evidenceArtifactIds: [],
      proposedChanges: { dsl: { id: 'invalid' } }
    })
    await harness.proposals.approve(proposal.id, 'reviewer-1')

    const failed = await harness.service.apply(proposal.id)

    expect(failed.status).toBe('application_failed')
    expect(failed.validation.issues.join(' ')).toContain('version conflict')
    expect((await harness.templates.getById('template-1'))?.version).toBe(1)
  })

  it('keeps an approved proposal reviewable when target persistence fails', async () => {
    const harness = await createHarness()
    await harness.templates.save({ id: 'template-1', dsl: validTask() })
    const proposal = await harness.service.createManualDraftFromRun(failedRun())
    await harness.proposals.approve(proposal.id, 'reviewer-1')
    harness.templateStorage.failWrites = true

    const failed = await harness.service.apply(proposal.id)

    expect(failed).toMatchObject({ status: 'application_failed', application: { status: 'failed' } })
    expect((await harness.templates.getById('template-1'))?.version).toBe(1)
  })

  it('retires legacy free-form Knowledge proposals without polluting retrieval', async () => {
    const harness = await createHarness()
    let proposal = await harness.proposals.create({
      sourceRunIds: ['run-1'],
      target: { type: 'knowledge' },
      traceSummary: 'A reviewed recovery rule',
      failureClass: 'execution_failed',
      confidence: 0.88,
      proposedChanges: {
        knowledgeBaseId: 'kb-1',
        title: 'Recovery guidance',
        summary: 'Use a stable locator',
        content: 'Verify the page before tapping.',
        category: 'recovery_guidance'
      },
      status: 'awaiting_review'
    })
    proposal = await harness.proposals.approve(proposal.id, 'reviewer-1')

    const applied = await harness.service.apply(proposal.id)
    const entries = await harness.knowledge.getAll()

    expect(applied).toMatchObject({
      status: 'application_failed',
      validation: {
        status: 'failed',
        issues: [expect.stringContaining('structured failure fingerprints')]
      }
    })
    expect(entries).toEqual([])
  })

  it('rejects proposals without mutation and parks approved Skill changes when the adapter is unavailable', async () => {
    const harness = await createHarness()
    const rejected = await harness.proposals.create({
      sourceRunIds: ['run-1'],
      target: { type: 'knowledge' },
      traceSummary: 'Rejected change',
      failureClass: 'unknown',
      confidence: 0.5,
      proposedChanges: {},
      status: 'awaiting_review'
    })
    await expect(harness.proposals.reject(rejected.id, 'reviewer-1', 'Not actionable')).resolves.toMatchObject({
      status: 'rejected',
      reviewer: 'reviewer-1'
    })

    const skill = await harness.proposals.create({
      sourceRunIds: ['run-2'],
      target: { type: 'skill', id: 'skill-1', baseVersion: '2' },
      traceSummary: 'Add a fallback locator',
      failureClass: 'locator_failed',
      confidence: 0.9,
      proposedChanges: { fallback: 'text=Retry' },
      status: 'awaiting_review'
    })
    await harness.proposals.approve(skill.id, 'reviewer-1')

    await expect(harness.service.apply(skill.id)).resolves.toMatchObject({
      status: 'approved_pending_dependency',
      application: { status: 'pending_dependency', targetId: 'skill-1' }
    })
  })

  it('applies an approved Skill proposal as a validated new Skill version', async () => {
    const repository = new RpaSkillRepository(new MemorySkillStorage(), createDefaultRpaModuleRegistry(), () => 500)
    await repository.save({ definition: validSkill() })
    const harness = await createHarness(new RpaSkillRepositoryImprovementAdapter(repository))
    let proposal = await harness.proposals.create({
      sourceRunIds: ['run-skill'],
      target: { type: 'skill', id: 'open-example-detail', baseVersion: '1.0.0' },
      traceSummary: 'Use a longer stable wait',
      failureClass: 'timing_failed',
      confidence: 0.91,
      proposedChanges: {
        definition: { ...validSkill(), description: 'Improved from reviewed trace' },
        nextVersion: '1.1.0'
      },
      status: 'awaiting_review'
    })
    proposal = await harness.proposals.approve(proposal.id, 'reviewer-1')

    const applied = await harness.service.apply(proposal.id)

    expect(applied).toMatchObject({
      status: 'applied',
      application: { status: 'applied', targetId: 'open-example-detail', targetVersion: '1.1.0' }
    })
    expect(await repository.getById('open-example-detail')).toMatchObject({
      version: '1.1.0',
      description: 'Improved from reviewed trace',
      revisions: [{ version: '1.0.0' }]
    })
  })
})
