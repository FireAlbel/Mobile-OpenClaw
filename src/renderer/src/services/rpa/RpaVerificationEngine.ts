import type { Model } from '@renderer/types'
import type { ModelMessage } from 'ai'
import * as z from 'zod'

import { parseJsonFromText } from './RpaJsonUtils'
import { DefaultRpaModelClient, type RpaModelClient } from './RpaModelClient'
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
      input.signal
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
    signal?: AbortSignal
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
      const observation = await this.observationService.capture(deviceId, {
        includeScreenshot: false,
        includeForegroundApp: true,
        includeScreenSize: false
      })
      const packageName =
        typeof observation.foregroundApp === 'object' &&
        observation.foregroundApp &&
        'packageName' in observation.foregroundApp
          ? String(observation.foregroundApp.packageName)
          : ''

      return packageName === verification.packageName
        ? {
            status: 'passed',
            confidence: 1,
            message: `Foreground app matched ${verification.packageName}`,
            evidence: observation
          }
        : {
            status: observation.foregroundApp ? 'failed' : 'uncertain',
            confidence: observation.foregroundApp ? 1 : 0,
            message: observation.foregroundApp
              ? `Foreground app mismatch, expected ${verification.packageName}, got ${packageName || 'unknown'}`
              : this.formatObservationUnavailableMessage(observation.warnings),
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
      try {
        rawResponse = await this.modelClient.complete({
          messages: this.buildVlmAssertionMessages(verification.expectation, observation),
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
      const parsed = VlmAssertionResponseSchema.safeParse(parseJsonFromText<unknown>(rawResponse))
      if (!parsed.success) {
        return {
          status: 'uncertain',
          confidence: 0,
          message: 'VLM assertion response failed validation',
          evidence: { observation, rawResponse, issues: parsed.error.issues }
        }
      }

      const assertion = parsed.data
      const status =
        assertion.confidence < verification.minConfidence ? 'uncertain' : assertion.passed ? 'passed' : 'failed'
      return {
        status,
        confidence: assertion.confidence,
        message: assertion.reason,
        evidence: { observation, rawResponse, assertion }
      }
    }

    return { status: 'uncertain', confidence: 0, message: 'Unsupported verification rule' }
  }

  private buildVlmAssertionMessages(
    expectation: string,
    observation: Awaited<ReturnType<RpaObservationService['capture']>>
  ): ModelMessage[] {
    const screenshot = observation.screenshot as { imageBase64: string; mime: string }
    return [
      {
        role: 'system',
        content: [
          'You verify whether an Android RPA business expectation is satisfied by the current screenshot.',
          'Judge only the stated expectation. Do not infer success from prior actions.',
          'Return only JSON: {"passed":boolean,"confidence":number,"reason":"specific visual evidence"}.'
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
              warnings: observation.warnings
            })
          },
          { type: 'image', image: screenshot.imageBase64, mediaType: screenshot.mime }
        ]
      }
    ]
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

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}
