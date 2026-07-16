import { loggerService } from '@logger'

import type { RpaDeviceObservation, RpaDeviceRuntime, RpaObservationOptions, RpaObservationWarning } from './RpaTypes'

const logger = loggerService.withContext('RpaObservationService')

const defaultObservationOptions: Required<RpaObservationOptions> = {
  includeScreenshot: true,
  includeForegroundApp: true,
  includeScreenSize: true
}

export class RpaObservationService {
  constructor(private readonly runtime: RpaDeviceRuntime) {}

  async capture(deviceId: string, options: RpaObservationOptions = {}): Promise<RpaDeviceObservation> {
    const resolvedOptions = { ...defaultObservationOptions, ...options }
    const warnings: RpaObservationWarning[] = []
    const artifacts: Record<string, unknown> = {}
    const observation: RpaDeviceObservation = {
      deviceId,
      capturedAt: Date.now(),
      warnings,
      artifacts
    }

    if (resolvedOptions.includeScreenshot) {
      const screenshot = await this.runtime.screenshot(deviceId)
      if (screenshot.success && screenshot.data) {
        observation.screenshot = screenshot.data
        artifacts.screenshot = screenshot.data
      } else {
        this.addWarning(warnings, 'screenshot', screenshot.message)
      }
    }

    if (resolvedOptions.includeForegroundApp) {
      const foregroundApp = await this.runtime.getForegroundApp(deviceId)
      if (foregroundApp.success && foregroundApp.data) {
        observation.foregroundApp = foregroundApp.data
      } else {
        this.addWarning(warnings, 'foreground_app', foregroundApp.message)
      }
    }

    if (resolvedOptions.includeScreenSize) {
      const screenSize = await this.runtime.getScreenSize(deviceId)
      if (screenSize.success && screenSize.data) {
        observation.screenSize = screenSize.data
      } else {
        this.addWarning(warnings, 'screen_size', screenSize.message)
      }
    }

    if (warnings.length) {
      logger.warn('RPA observation captured with warnings', { deviceId, warnings })
    }

    return observation
  }

  private addWarning(
    warnings: RpaObservationWarning[],
    source: RpaObservationWarning['source'],
    message: string
  ): void {
    warnings.push({ source, message })
  }
}
