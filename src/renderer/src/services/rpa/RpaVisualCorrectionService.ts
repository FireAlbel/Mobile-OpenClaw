import type { Model } from '@renderer/types'
import type { ModelMessage } from 'ai'
import * as z from 'zod'

import { parseJsonFromText } from './RpaJsonUtils'
import type { RpaKnowledgeRetrievalResult } from './RpaKnowledgeRetrievalService'
import { DefaultRpaModelClient, type RpaModelClient } from './RpaModelClient'
import {
  buildRpaModelContext,
  type RpaBoundedModelContext,
  type RpaEmbeddedModelContext,
  type RpaModelContextProvenance
} from './RpaModelContextBuilder'
import {
  type RpaCorrectionDecision,
  RpaCorrectionDecisionSchema,
  type RpaDeviceObservation,
  type RpaFailureContext
} from './RpaTypes'

export const RpaVisualCorrectionResponseSchema = z.object({
  found: z.boolean(),
  action: z.enum(['tap', 'swipe', 'none']).default('none'),
  bbox: z
    .object({
      x: z.number().min(0),
      y: z.number().min(0),
      width: z.number().min(0),
      height: z.number().min(0)
    })
    .optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string().optional()
})

export type RpaVisualCorrectionResponse = z.infer<typeof RpaVisualCorrectionResponseSchema>

export interface RpaVisualCorrectionInput {
  deviceId: string
  target: string
  observation: RpaDeviceObservation
  minConfidence?: number
  model?: Model
  signal?: AbortSignal
}

export interface RpaVisualCorrectionResult {
  status: 'found' | 'not_found' | 'low_confidence' | 'invalid'
  response?: RpaVisualCorrectionResponse
  point?: { x: number; y: number }
  rawResponse: string
  message: string
}

export interface RpaVisualCorrectionServiceOptions {
  modelClient?: RpaModelClient
}

export interface RpaCorrectionDecisionInput {
  failureContext: RpaFailureContext
  observation: RpaDeviceObservation
  correctionRound: number
  previousDecisions?: RpaCorrectionDecision[]
  knowledgeContext?: RpaKnowledgeRetrievalResult
  minConfidence?: number
  modelContext?: RpaEmbeddedModelContext
  signal?: AbortSignal
}

export interface RpaCorrectionDecisionResult {
  status: 'valid' | 'invalid' | 'low_confidence'
  decision?: RpaCorrectionDecision
  rawResponse: string
  originalRawResponse?: string
  repaired?: boolean
  message: string
  issues: string[]
  contextProvenance?: RpaModelContextProvenance
}

const RECOVERY_CONTEXT_BUDGETS = {
  rolePrompts: 1_500,
  localKnowledge: 1_200,
  remoteKnowledge: 600,
  observations: 0,
  executionHistory: 0,
  clarifications: 0
} as const
const MAX_RECOVERY_TEXT_CANDIDATES = 12
const MAX_RECOVERY_PREVIOUS_DECISIONS = 2

export class RpaVisualCorrectionService {
  private readonly modelClient: RpaModelClient

  constructor(options: RpaVisualCorrectionServiceOptions = {}) {
    this.modelClient = options.modelClient ?? new DefaultRpaModelClient()
  }

  async decideRecovery(input: RpaCorrectionDecisionInput): Promise<RpaCorrectionDecisionResult> {
    const modelContext = this.buildRecoveryContext(input)
    const rawResponse = await this.modelClient.complete({
      messages: this.buildRecoveryMessages(input, modelContext),
      model: input.failureContext.task.visionModel,
      signal: input.signal
    })
    const initialResult = this.parseRecoveryDecision(rawResponse)
    if (initialResult.decision) {
      return this.toDecisionResult(initialResult.decision, rawResponse, input.minConfidence, undefined, modelContext)
    }

    let repairResponse: string
    try {
      repairResponse = await this.modelClient.complete({
        messages: this.buildRecoveryRepairMessages(input, modelContext, rawResponse, initialResult.issues),
        model: input.failureContext.task.visionModel,
        signal: input.signal
      })
    } catch (error) {
      return {
        status: 'invalid',
        rawResponse,
        repaired: false,
        message: initialResult.message,
        issues: [
          ...initialResult.issues,
          `Correction protocol repair failed: ${error instanceof Error ? error.message : String(error)}`
        ],
        contextProvenance: modelContext.provenance
      }
    }

    const repairedResult = this.parseRecoveryDecision(repairResponse, rawResponse)
    if (!repairedResult.decision) {
      return {
        status: 'invalid',
        rawResponse: repairResponse,
        originalRawResponse: rawResponse,
        repaired: true,
        message: repairedResult.message,
        issues: repairedResult.issues,
        contextProvenance: modelContext.provenance
      }
    }

    return this.toDecisionResult(
      repairedResult.decision,
      repairResponse,
      input.minConfidence,
      rawResponse,
      modelContext
    )
  }

  private parseRecoveryDecision(
    rawResponse: string,
    fallbackResponse?: string
  ): {
    decision?: RpaCorrectionDecision
    message: string
    issues: string[]
  } {
    let parsedJson: unknown
    try {
      parsedJson = parseJsonFromText<unknown>(rawResponse)
    } catch (error) {
      return {
        message: 'VLM correction response is not valid JSON',
        issues: [error instanceof Error ? error.message : String(error)]
      }
    }

    const normalizedJson = normalizeRecoveryDecision(parsedJson, parseOptionalJson(fallbackResponse))
    const parsed = RpaCorrectionDecisionSchema.safeParse(normalizedJson)
    if (!parsed.success) {
      return {
        message: 'VLM correction response contains no executable decision',
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      }
    }

    return { decision: parsed.data, message: parsed.data.reason, issues: [] }
  }

  private toDecisionResult(
    decision: RpaCorrectionDecision,
    rawResponse: string,
    configuredMinConfidence?: number,
    originalRawResponse?: string,
    modelContext?: RpaBoundedModelContext
  ): RpaCorrectionDecisionResult {
    const minConfidence = configuredMinConfidence ?? 0.65
    if (decision.confidence < minConfidence) {
      return {
        status: 'low_confidence',
        decision,
        rawResponse,
        originalRawResponse,
        repaired: Boolean(originalRawResponse),
        message: `VLM correction confidence ${decision.confidence} is below ${minConfidence}`,
        issues: [],
        contextProvenance: modelContext?.provenance
      }
    }

    return {
      status: 'valid',
      decision,
      rawResponse,
      originalRawResponse,
      repaired: Boolean(originalRawResponse),
      message: decision.reason,
      issues: [],
      contextProvenance: modelContext?.provenance
    }
  }

  async locate(input: RpaVisualCorrectionInput): Promise<RpaVisualCorrectionResult> {
    const rawResponse = await this.modelClient.complete({
      messages: this.buildMessages(input),
      model: input.model,
      signal: input.signal
    })
    const parsed = RpaVisualCorrectionResponseSchema.safeParse(parseJsonFromText<unknown>(rawResponse))

    if (!parsed.success) {
      return {
        status: 'invalid',
        rawResponse,
        message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      }
    }

    const response = parsed.data
    if (!response.found || !response.bbox) {
      return {
        status: 'not_found',
        response,
        rawResponse,
        message: response.reason || 'Target not found'
      }
    }

    const minConfidence = input.minConfidence ?? 0.7
    if (response.confidence < minConfidence) {
      return {
        status: 'low_confidence',
        response,
        rawResponse,
        message: `Visual target confidence ${response.confidence} is below ${minConfidence}`
      }
    }

    return {
      status: 'found',
      response,
      point: {
        x: Math.round(response.bbox.x + response.bbox.width / 2),
        y: Math.round(response.bbox.y + response.bbox.height / 2)
      },
      rawResponse,
      message: response.reason || `Visual target found: ${input.target}`
    }
  }

  private buildMessages(input: RpaVisualCorrectionInput): ModelMessage[] {
    const screenshot = input.observation.screenshot
    const screenshotContent =
      typeof screenshot === 'object' && screenshot && 'imageBase64' in screenshot && 'mime' in screenshot
        ? [
            {
              type: 'image' as const,
              image: String(screenshot.imageBase64),
              mediaType: String(screenshot.mime)
            }
          ]
        : []

    return [
      {
        role: 'system',
        content: [
          'You locate visual targets on Android screenshots for an RPA system.',
          'Return only JSON. Do not execute actions.',
          'Schema: {"found":boolean,"action":"tap|swipe|none","bbox":{"x":number,"y":number,"width":number,"height":number},"confidence":number,"reason":"short reason"}.',
          'Coordinates must be screenshot pixel coordinates.'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                deviceId: input.deviceId,
                target: input.target,
                observation: {
                  capturedAt: input.observation.capturedAt,
                  screenSize: input.observation.screenSize,
                  foregroundApp: input.observation.foregroundApp,
                  recognizedState: input.observation.recognizedState,
                  warnings: input.observation.warnings
                }
              },
              null,
              2
            )
          },
          ...screenshotContent
        ]
      }
    ]
  }

  private buildRecoveryMessages(
    input: RpaCorrectionDecisionInput,
    modelContext: RpaBoundedModelContext
  ): ModelMessage[] {
    const screenshot = input.observation.screenshot
    const screenshotContent =
      typeof screenshot === 'object' && screenshot && 'imageBase64' in screenshot && 'mime' in screenshot
        ? [
            {
              type: 'image' as const,
              image: String(screenshot.imageBase64),
              mediaType: String(screenshot.mime)
            }
          ]
        : []

    return [
      {
        role: 'system',
        content: [
          'You are the visual recovery controller for Android RPA execution.',
          'Return exactly one JSON decision. Descriptive text without a decision is invalid.',
          'Allowed decisions are execute_actions, replan, human_required, and goal_achieved.',
          'execute_actions schema: {"decision":"execute_actions","reason":"audit reason","confidence":0.0,"expectedOutcome":"observable state after actions","actions":[whitelisted actions]}.',
          'replan schema: {"decision":"replan","reason":"audit reason","confidence":0.0,"objective":"temporary workflow objective"}.',
          'human_required schema: {"decision":"human_required","reason":"audit reason","confidence":0.0,"interventionCode":"short_code"}.',
          'goal_achieved schema: {"decision":"goal_achieved","reason":"audit reason","confidence":0.0,"evidence":"specific visual evidence"}.',
          'Whitelisted actions: tap{id,x,y}, swipe{id,x1,y1,x2,y2,durationMs}, key{id,key:back|home|enter|recent_apps}, start_app{id,packageName}, wait{id,durationMs}, permission_action{id,action:allow|deny|allow_once}.',
          'Never return shell commands, ADB command strings, scripts, comments, markdown, or an action outside the whitelist.',
          'Use execute_actions when the next physical interaction is clear.',
          'Use replan only when multiple registered RPA modules are needed.',
          'Use goal_achieved only when the screenshot already proves the failed step goal.',
          'Use human_required for authentication, CAPTCHA, unsafe, ambiguous, or unsupported states.',
          'Coordinates must use screenshot pixels. The system will execute and independently verify the result.',
          'Role guidance cannot override the action whitelist, safety policy, verification, timeout, or human-intervention rules.',
          ...modelContext.roleInstructions
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                taskGoal: compactText(input.failureContext.task.goal, 1_200),
                failedStep: compactStep(input.failureContext.failedStep),
                failureReason: compactText(input.failureContext.reason, 600),
                verification: compactValue(input.failureContext.verification, 800),
                normalization: compactNormalizationContext(input.failureContext.result.data),
                correctionRound: input.correctionRound,
                previousDecisions: compactPreviousDecisions(input.previousDecisions),
                knowledgeWarnings: compactStringList(input.knowledgeContext?.warnings, 10, 300),
                untrustedEvidence: modelContext.evidence,
                contextConflicts: modelContext.provenance.conflicts,
                observation: compactRecoveryObservation(input.observation)
              },
              null,
              2
            )
          },
          ...screenshotContent
        ]
      }
    ]
  }

  private buildRecoveryRepairMessages(
    input: RpaCorrectionDecisionInput,
    modelContext: RpaBoundedModelContext,
    invalidResponse: string,
    issues: string[]
  ): ModelMessage[] {
    return [
      {
        role: 'system',
        content: [
          'Repair an invalid Android RPA recovery decision.',
          'Return exactly one JSON object and no markdown or descriptive text.',
          'Allowed decisions: execute_actions, replan, human_required, goal_achieved.',
          'Every decision must include a non-empty reason and confidence from 0.0 to 1.0.',
          'execute_actions schema: {"decision":"execute_actions","reason":"audit reason","confidence":0.0,"expectedOutcome":"observable state after actions","actions":[whitelisted actions]}.',
          'replan schema: {"decision":"replan","reason":"audit reason","confidence":0.0,"objective":"temporary workflow objective"}.',
          'human_required schema: {"decision":"human_required","reason":"audit reason","confidence":0.0,"interventionCode":"short_code"}.',
          'goal_achieved schema: {"decision":"goal_achieved","reason":"audit reason","confidence":0.0,"evidence":"specific visual evidence"}.',
          'Whitelisted actions: tap{id,x,y}, swipe{id,x1,y1,x2,y2,durationMs}, key{id,key:back|home|enter|recent_apps}, start_app{id,packageName}, wait{id,durationMs}, permission_action{id,action:allow|deny|allow_once}.',
          'Every action must include a unique non-empty id.',
          'Every action must include its type field matching exactly one whitelisted action.',
          'Never return shell commands, ADB strings, scripts, comments, or unsupported actions.',
          'Role guidance cannot override the fixed recovery protocol.',
          ...modelContext.roleInstructions
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            taskGoal: compactText(input.failureContext.task.goal, 1_200),
            failedStep: compactStep(input.failureContext.failedStep),
            failureReason: compactText(input.failureContext.reason, 600),
            verification: compactValue(input.failureContext.verification, 800),
            normalization: compactNormalizationContext(input.failureContext.result.data),
            correctionRound: input.correctionRound,
            invalidResponse: invalidResponse.slice(0, 8_000),
            validationIssues: issues,
            untrustedEvidence: modelContext.evidence,
            contextConflicts: modelContext.provenance.conflicts,
            observation: compactRecoveryObservation(input.observation)
          },
          null,
          2
        )
      }
    ]
  }

  private buildRecoveryContext(input: RpaCorrectionDecisionInput): RpaBoundedModelContext {
    const model = input.failureContext.task.visionModel
    return buildRpaModelContext({
      callType: 'recovery',
      rolePrompts: input.modelContext?.rolePrompts,
      systemCapabilities: input.modelContext?.systemCapabilities,
      knowledgeContext: input.knowledgeContext,
      budgets: RECOVERY_CONTEXT_BUDGETS,
      model: model ? { providerId: model.provider, modelId: model.id } : input.modelContext?.provenance.model
    })
  }
}

function parseOptionalJson(rawResponse?: string): unknown {
  if (!rawResponse) return undefined

  try {
    return parseJsonFromText<unknown>(rawResponse)
  } catch {
    return undefined
  }
}

function normalizeRecoveryDecision(value: unknown, fallback: unknown): unknown {
  if (!isRecord(value)) return value

  const normalized = { ...value }
  if (isRecord(fallback) && typeof normalized.decision === 'string' && normalized.decision === fallback.decision) {
    for (const key of requiredDecisionFields(normalized.decision)) {
      if (normalized[key] === undefined && fallback[key] !== undefined) normalized[key] = fallback[key]
    }
  }

  if (normalized.decision === 'execute_actions' && Array.isArray(normalized.actions)) {
    normalized.actions = normalized.actions.map(normalizeRecoveryAction)
  }

  return normalized
}

function requiredDecisionFields(decision: string): string[] {
  const fields = ['reason', 'confidence']
  if (decision === 'execute_actions') return [...fields, 'expectedOutcome']
  if (decision === 'replan') return [...fields, 'objective']
  if (decision === 'human_required') return [...fields, 'interventionCode']
  if (decision === 'goal_achieved') return [...fields, 'evidence']
  return fields
}

function normalizeRecoveryAction(value: unknown): unknown {
  if (!isRecord(value) || value.type !== undefined) return value

  const candidates = [
    hasNumberFields(value, ['x1', 'y1', 'x2', 'y2']) ? 'swipe' : undefined,
    hasNumberFields(value, ['x', 'y']) ? 'tap' : undefined,
    typeof value.key === 'string' ? 'key' : undefined,
    typeof value.packageName === 'string' ? 'start_app' : undefined,
    typeof value.durationMs === 'number' && !hasAnyField(value, ['x1', 'y1', 'x2', 'y2']) ? 'wait' : undefined,
    typeof value.action === 'string' ? 'permission_action' : undefined
  ].filter((candidate): candidate is string => Boolean(candidate))

  return candidates.length === 1 ? { ...value, type: candidates[0] } : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasNumberFields(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => typeof value[field] === 'number')
}

function hasAnyField(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.some((field) => value[field] !== undefined)
}

function compactRecoveryObservation(observation: RpaDeviceObservation): Record<string, unknown> {
  return {
    capturedAt: observation.capturedAt,
    foregroundApp: compactValue(observation.foregroundApp, 1_000),
    screenSize: observation.screenSize,
    recognizedState: compactValue(observation.recognizedState, 1_200),
    textCandidates: (observation.textCandidates ?? []).slice(0, MAX_RECOVERY_TEXT_CANDIDATES).map((candidate) => ({
      source: candidate.source,
      text: compactText(candidate.text, 160),
      confidence: candidate.confidence,
      bounds: candidate.bounds,
      approximate: candidate.approximate
    })),
    warnings: observation.warnings.slice(0, 10).map((warning) => ({
      source: warning.source,
      message: compactText(warning.message, 300)
    }))
  }
}

function compactStep(step: RpaFailureContext['failedStep']): Record<string, unknown> {
  return {
    id: step.id,
    name: compactText(step.name, 500),
    moduleId: step.moduleId,
    params: compactValue(step.params, 1_200),
    timeoutMs: step.timeoutMs,
    retry: compactValue(step.retry, 500),
    verify: compactValue(step.verify, 800),
    continueOnFailure: step.continueOnFailure
  }
}

function compactNormalizationContext(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  if (typeof source.outcome !== 'string' || !Array.isArray(source.actionGroups)) return undefined
  return {
    outcome: source.outcome,
    packageName: source.packageName,
    targetState: source.targetState,
    playbookId: source.playbookId,
    playbookVersion: source.playbookVersion,
    initialState: compactValue(source.initialState, 1_200),
    finalState: compactValue(source.finalState, 1_200),
    attemptedStages: source.actionGroups.slice(0, 12).map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
      const group = candidate as Record<string, unknown>
      return {
        stage: group.stage,
        attempt: group.attempt,
        actions: compactValue(group.actions, 800),
        success: group.success,
        message: compactText(String(group.message ?? ''), 300),
        verification: compactValue(group.verification, 600)
      }
    })
  }
}

function compactPreviousDecisions(decisions?: RpaCorrectionDecision[]): unknown[] {
  return (decisions ?? []).slice(-MAX_RECOVERY_PREVIOUS_DECISIONS).map((decision) => compactValue(decision, 1_000))
}

function compactStringList(values: unknown[] | undefined, limit: number, maxLength: number): string[] {
  return (values ?? [])
    .slice(0, limit)
    .map((value) => compactText(value, maxLength))
    .filter(Boolean)
}

function compactValue(value: unknown, maxChars: number): unknown {
  if (value === undefined) return undefined
  try {
    const serialized = JSON.stringify(value, (key, candidate) =>
      key === 'imageBase64' && typeof candidate === 'string' ? `[BINARY_IMAGE_OMITTED:${candidate.length}]` : candidate
    )
    if (serialized.length <= maxChars) return JSON.parse(serialized)
    return { truncated: true, preview: serialized.slice(0, maxChars) }
  } catch {
    return compactText(value, maxChars)
  }
}

function compactText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : String(value ?? '').slice(0, maxLength)
}
