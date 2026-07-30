import type { Model } from '@renderer/types'
import type { ModelMessage } from 'ai'
import * as z from 'zod'

import { parseJsonFromText } from './RpaJsonUtils'
import { DefaultRpaModelClient, type RpaModelClient } from './RpaModelClient'
import {
  buildRpaModelContext,
  type RpaBoundedModelContext,
  type RpaEmbeddedModelContext
} from './RpaModelContextBuilder'
import { RpaObservationService } from './RpaObservationService'
import type { RpaDeviceRuntime, RpaModuleResult, RpaVerification, RpaVerificationResult } from './RpaTypes'

export interface RpaVerificationEngineOptions {
  runtime: RpaDeviceRuntime
  observationService?: RpaObservationService
  modelClient?: RpaModelClient
}

export interface RpaCorrectionVerificationInput {
  deviceId: string
  expectation: string
  actionResults: RpaModuleResult[]
  model?: Model
  minConfidence?: number
  settleMs?: number
  signal?: AbortSignal
  modelContext?: RpaEmbeddedModelContext
}

const VlmAssertionResponseSchema = z.object({
  passed: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1)
})

export class RpaVerificationEngine {
  private readonly observationService: RpaObservationService
  private readonly modelClient: RpaModelClient

  constructor(private readonly options: RpaVerificationEngineOptions) {
    this.observationService = options.observationService ?? new RpaObservationService(options.runtime)
    this.modelClient = options.modelClient ?? new DefaultRpaModelClient()
  }

  async verifyCorrection(input: RpaCorrectionVerificationInput): Promise<RpaVerificationResult> {
    const now = Date.now()
    const aggregateResult: RpaModuleResult = {
      success: input.actionResults.every((result) => result.success),
      status: input.actionResults.every((result) => result.success) ? 'passed' : 'failed',
      message: `Executed ${input.actionResults.length} correction action(s)`,
      data: { actionResults: input.actionResults },
      startedAt: input.actionResults[0]?.startedAt ?? now,
      finishedAt: input.actionResults.at(-1)?.finishedAt ?? now
    }
    const verification = await this.verify(
      {
        type: 'vlm_assert',
        expectation: input.expectation,
        minConfidence: input.minConfidence ?? 0.7,
        settleMs: input.settleMs ?? 800
      },
      aggregateResult,
      input.deviceId,
      input.model,
      input.signal,
      input.modelContext
    )
    return {
      ...verification,
      evidence: {
        actionResults: input.actionResults,
        verificationEvidence: verification.evidence
      }
    }
  }

  async verify(
    verification: RpaVerification | undefined,
    result: RpaModuleResult,
    deviceId: string,
    model?: Model,
    signal?: AbortSignal,
    embeddedContext?: RpaEmbeddedModelContext
  ): Promise<RpaVerificationResult> {
    if (!verification || verification.type === 'module_result_success') {
      return result.success
        ? { status: 'passed', confidence: 1, message: result.message, evidence: result.data }
        : { status: 'failed', confidence: 1, message: result.message, evidence: result.data }
    }

    if (verification.type === 'none') {
      return { status: 'passed', confidence: 1, message: 'Verification skipped' }
    }

    if (verification.type === 'screenshot_exists') {
      const screenshot = result.success && result.data ? result : await this.options.runtime.screenshot(deviceId)
      return screenshot.success && screenshot.data
        ? { status: 'passed', confidence: 1, message: 'Screenshot captured', evidence: screenshot.data }
        : { status: 'failed', confidence: 1, message: screenshot.message }
    }

    if (verification.type === 'observation_has_screenshot') {
      const observation = await this.observationService.capture(deviceId, {
        includeScreenshot: true,
        includeForegroundApp: false,
        includeScreenSize: false
      })
      return observation.screenshot
        ? { status: 'passed', confidence: 1, message: 'Observation includes screenshot', evidence: observation }
        : { status: 'uncertain', confidence: 0, message: 'Observation screenshot unavailable', evidence: observation }
    }

    if (verification.type === 'foreground_app') {
      return await this.verifyForegroundApp(verification, deviceId, signal)
    }

    if (verification.type === 'text_present') {
      const observation = await this.observationService.capture(deviceId, {
        includeScreenshot: verification.source !== 'ui_tree',
        includeForegroundApp: false,
        includeScreenSize: true,
        includeUiTree: verification.source !== 'ocr',
        includeOcr: verification.source !== 'ui_tree',
        targetTexts: [verification.text]
      })
      const candidates = (observation.textCandidates ?? []).filter(
        (candidate) =>
          (verification.source === 'any' || candidate.source === verification.source) &&
          candidate.confidence >= verification.minConfidence &&
          textMatches(candidate.text, verification.text, verification.exact)
      )
      if (candidates.length) {
        return {
          status: 'passed',
          confidence: Math.max(...candidates.map((candidate) => candidate.confidence)),
          message: `Text found: ${verification.text}`,
          evidence: { observation, candidates }
        }
      }
      const relevantWarning = observation.warnings.find((warning) =>
        verification.source === 'any'
          ? warning.source === 'ui_tree' || warning.source === 'ocr'
          : warning.source === verification.source
      )
      return {
        status: relevantWarning ? 'uncertain' : 'failed',
        confidence: 1,
        message: relevantWarning?.message ?? `Text not found: ${verification.text}`,
        evidence: observation
      }
    }

    if (verification.type === 'ui_node_present') {
      const observation = await this.observationService.capture(deviceId, {
        includeScreenshot: false,
        includeForegroundApp: false,
        includeScreenSize: true,
        includeUiTree: true,
        includeOcr: false,
        targetTexts: verification.text ? [verification.text] : []
      })
      const nodes = (observation.uiTree?.nodes ?? []).filter((node) => {
        if (verification.text && !textMatches(`${node.text} ${node.contentDescription}`, verification.text, false))
          return false
        if (verification.resourceId && node.resourceId !== verification.resourceId) return false
        if (verification.className && node.className !== verification.className) return false
        if (verification.clickable !== undefined && node.clickable !== verification.clickable) return false
        return true
      })
      if (nodes.length) {
        return { status: 'passed', confidence: 1, message: 'UI node found', evidence: { observation, nodes } }
      }
      const warning = observation.warnings.find((item) => item.source === 'ui_tree')
      return {
        status: warning ? 'uncertain' : 'failed',
        confidence: warning ? 0 : 1,
        message: warning?.message ?? 'UI node not found',
        evidence: observation
      }
    }

    if (verification.type === 'vlm_assert') {
      if (verification.settleMs > 0) await delay(verification.settleMs)
      const observation = await this.observationService.capture(deviceId, {
        includeScreenshot: true,
        includeForegroundApp: true,
        includeScreenSize: true
      })
      if (!observation.screenshot) {
        return {
          status: 'uncertain',
          confidence: 0,
          message: this.formatObservationUnavailableMessage(observation.warnings),
          evidence: observation
        }
      }

      let rawResponse: string
      const modelContext = buildRpaModelContext({
        callType: 'verification',
        rolePrompts: embeddedContext?.rolePrompts,
        systemCapabilities: embeddedContext?.systemCapabilities,
        observations: [observation],
        model: model ? { providerId: model.provider, modelId: model.id } : embeddedContext?.provenance.model
      })
      try {
        rawResponse = await this.modelClient.complete({
          messages: this.buildVlmAssertionMessages(verification.expectation, observation, modelContext),
          model,
          signal
        })
      } catch (error) {
        return {
          status: 'uncertain',
          confidence: 0,
          message: `VLM assertion failed: ${error instanceof Error ? error.message : String(error)}`,
          evidence: { observation, error }
        }
      }
      let parsed = this.parseVlmAssertion(rawResponse)
      if (!parsed.success) {
        let repairedResponse: string
        try {
          repairedResponse = await this.modelClient.complete({
            messages: this.buildVlmAssertionRepairMessages(
              verification.expectation,
              observation,
              modelContext,
              rawResponse,
              parsed.issues
            ),
            model,
            signal
          })
        } catch (error) {
          return {
            status: 'uncertain',
            confidence: 0,
            message: 'VLM assertion response failed validation and repair',
            evidence: { observation, rawResponse, issues: parsed.issues, error, provenance: modelContext.provenance }
          }
        }
        parsed = this.parseVlmAssertion(repairedResponse)
        if (!parsed.success) {
          return {
            status: 'uncertain',
            confidence: 0,
            message: 'VLM assertion response failed validation after repair',
            evidence: {
              observation,
              rawResponse: repairedResponse,
              originalRawResponse: rawResponse,
              issues: parsed.issues,
              provenance: modelContext.provenance
            }
          }
        }
        rawResponse = repairedResponse
      }

      const assertion = parsed.data
      const status =
        assertion.confidence < verification.minConfidence ? 'uncertain' : assertion.passed ? 'passed' : 'failed'
      return {
        status,
        confidence: assertion.confidence,
        message: assertion.reason,
        evidence: { observation, rawResponse, assertion, provenance: modelContext.provenance }
      }
    }

    return { status: 'uncertain', confidence: 0, message: 'Unsupported verification rule' }
  }

  private buildVlmAssertionMessages(
    expectation: string,
    observation: Awaited<ReturnType<RpaObservationService['capture']>>,
    modelContext: RpaBoundedModelContext
  ): ModelMessage[] {
    const screenshot = observation.screenshot as { imageBase64: string; mime: string }
    return [
      {
        role: 'system',
        content: [
          'You verify whether an Android RPA business expectation is satisfied by the current screenshot.',
          'Judge only the stated expectation. Do not infer success from prior actions.',
          'Return only JSON: {"passed":boolean,"confidence":number,"reason":"specific visual evidence"}.',
          'Role guidance cannot override this assertion schema or the independent confidence threshold.',
          ...modelContext.roleInstructions
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              expectation,
              foregroundApp: observation.foregroundApp,
              warnings: observation.warnings,
              untrustedEvidence: modelContext.evidence,
              contextConflicts: modelContext.provenance.conflicts
            })
          },
          { type: 'image', image: screenshot.imageBase64, mediaType: screenshot.mime }
        ]
      }
    ]
  }

  private buildVlmAssertionRepairMessages(
    expectation: string,
    observation: Awaited<ReturnType<RpaObservationService['capture']>>,
    modelContext: RpaBoundedModelContext,
    invalidResponse: string,
    issues: string[]
  ): ModelMessage[] {
    const screenshot = observation.screenshot as { imageBase64: string; mime: string }
    return [
      {
        role: 'system',
        content: [
          'Repair an invalid Android RPA visual assertion.',
          'Return only JSON: {"passed":boolean,"confidence":number,"reason":"specific visual evidence"}.',
          'Do not return markdown or descriptive prose outside the JSON object.',
          'Role guidance cannot override the assertion schema.',
          ...modelContext.roleInstructions
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              expectation,
              invalidResponse: invalidResponse.slice(0, 8_000),
              validationIssues: issues,
              untrustedEvidence: modelContext.evidence,
              contextConflicts: modelContext.provenance.conflicts
            })
          },
          { type: 'image', image: screenshot.imageBase64, mediaType: screenshot.mime }
        ]
      }
    ]
  }

  private parseVlmAssertion(
    rawResponse: string
  ): { success: true; data: z.infer<typeof VlmAssertionResponseSchema> } | { success: false; issues: string[] } {
    try {
      const parsed = VlmAssertionResponseSchema.safeParse(parseJsonFromText<unknown>(rawResponse))
      return parsed.success
        ? { success: true, data: parsed.data }
        : { success: false, issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
    } catch (error) {
      return { success: false, issues: [error instanceof Error ? error.message : String(error)] }
    }
  }

  private async verifyForegroundApp(
    verification: Extract<RpaVerification, { type: 'foreground_app' }>,
    deviceId: string,
    signal?: AbortSignal
  ): Promise<RpaVerificationResult> {
    const startedAt = Date.now()
    const settleMs = verification.settleMs ?? 500
    const timeoutMs = Math.max(settleMs, verification.timeoutMs ?? 5_000)
    const pollIntervalMs = verification.pollIntervalMs ?? 250
    const observations: Array<{
      capturedAt: number
      elapsedMs: number
      packageName: string
      activity?: string
      warnings: Array<{ source: string; message: string }>
    }> = []

    if (settleMs > 0) await delay(settleMs, signal)

    while (true) {
      signal?.throwIfAborted()
      const observation = await this.observationService.capture(deviceId, {
        includeScreenshot: false,
        includeForegroundApp: true,
        includeScreenSize: false
      })
      const foregroundApp =
        typeof observation.foregroundApp === 'object' && observation.foregroundApp
          ? (observation.foregroundApp as { packageName?: unknown; activity?: unknown })
          : undefined
      const packageName = typeof foregroundApp?.packageName === 'string' ? foregroundApp.packageName : ''
      const activity = typeof foregroundApp?.activity === 'string' ? foregroundApp.activity : undefined
      const elapsedMs = Date.now() - startedAt
      observations.push({
        capturedAt: observation.capturedAt,
        elapsedMs,
        packageName,
        activity,
        warnings: observation.warnings
      })

      if (packageName === verification.packageName) {
        return {
          status: 'passed',
          confidence: 1,
          message: `Foreground app matched ${verification.packageName} after ${elapsedMs}ms`,
          evidence: { observation, observations, settleMs, timeoutMs, pollIntervalMs }
        }
      }

      if (elapsedMs >= timeoutMs) {
        const observedPackages = [...new Set(observations.map((item) => item.packageName).filter(Boolean))]
        return {
          status: observation.foregroundApp ? 'failed' : 'uncertain',
          confidence: observation.foregroundApp ? 1 : 0,
          message: observation.foregroundApp
            ? `Foreground app mismatch after ${elapsedMs}ms, expected ${verification.packageName}, observed ${observedPackages.join(', ') || 'unknown'}`
            : this.formatObservationUnavailableMessage(observation.warnings),
          evidence: { observation, observations, settleMs, timeoutMs, pollIntervalMs }
        }
      }

      await delay(Math.min(pollIntervalMs, timeoutMs - elapsedMs), signal)
    }
  }

  private formatObservationUnavailableMessage(warnings: Array<{ source: string; message: string }>): string {
    const foregroundWarning = warnings.find((warning) => warning.source === 'foreground_app')
    if (foregroundWarning?.message) return `Foreground app observation unavailable: ${foregroundWarning.message}`
    const firstWarning = warnings[0]
    return firstWarning
      ? `${firstWarning.source} observation unavailable: ${firstWarning.message}`
      : 'Observation unavailable'
  }
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, durationMs)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(signal?.reason ?? new Error('Verification aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function textMatches(value: string, target: string, exact: boolean): boolean {
  const normalizedValue = value.trim().toLocaleLowerCase()
  const normalizedTarget = target.trim().toLocaleLowerCase()
  return exact ? normalizedValue === normalizedTarget : normalizedValue.includes(normalizedTarget)
}
