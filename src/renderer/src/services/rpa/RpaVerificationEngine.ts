import { RpaObservationService } from './RpaObservationService'
import type { RpaDeviceRuntime, RpaModuleResult, RpaVerification, RpaVerificationResult } from './RpaTypes'

export interface RpaVerificationEngineOptions {
  runtime: RpaDeviceRuntime
  observationService?: RpaObservationService
}

export class RpaVerificationEngine {
  private readonly observationService: RpaObservationService

  constructor(private readonly options: RpaVerificationEngineOptions) {
    this.observationService = options.observationService ?? new RpaObservationService(options.runtime)
  }

  async verify(
    verification: RpaVerification | undefined,
    result: RpaModuleResult,
    deviceId: string
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

    return { status: 'uncertain', confidence: 0, message: 'Unsupported verification rule' }
  }

  private formatObservationUnavailableMessage(warnings: Array<{ source: string; message: string }>): string {
    const foregroundWarning = warnings.find((warning) => warning.source === 'foreground_app')
    return foregroundWarning?.message
      ? `Foreground app observation unavailable: ${foregroundWarning.message}`
      : 'Foreground app observation unavailable'
  }
}
