import { loggerService } from '@logger'

import { deviceServiceProxy } from './DeviceServiceProxy'

const logger = loggerService.withContext('ScrcpyService')

export interface ScrcpyOptions {
  port?: number
  maxSize?: number
  bitRate?: number
  maxFps?: number
  stayAwake?: boolean
  turnScreenOff?: boolean
}

export interface ScrcpyProcess {
  deviceId: string
  port: number
  isRunning: boolean
}

class ScrcpyService {
  private static instance: ScrcpyService
  private processes: Map<string, ScrcpyProcess> = new Map()

  private constructor() {}

  public static getInstance(): ScrcpyService {
    if (!ScrcpyService.instance) {
      ScrcpyService.instance = new ScrcpyService()
    }
    return ScrcpyService.instance
  }

  public async startScrcpy(deviceId: string, options: ScrcpyOptions = {}): Promise<ScrcpyProcess | null> {
    try {
      logger.info('Starting Scrcpy for device:', { deviceId, options })

      const result = await deviceServiceProxy.startScrcpy(deviceId, options)

      const process: ScrcpyProcess = {
        deviceId,
        port: result.port,
        isRunning: true
      }

      this.processes.set(deviceId, process)
      logger.info('Scrcpy started successfully for device:', { deviceId, port: result.port })

      return process
    } catch (error) {
      logger.error('Failed to start Scrcpy:', error as Error)
      return null
    }
  }

  public async stopScrcpy(deviceId: string): Promise<boolean> {
    try {
      logger.info('Stopping Scrcpy for device:', { deviceId })
      await deviceServiceProxy.stopScrcpy(deviceId)

      this.processes.delete(deviceId)
      logger.info('Scrcpy stopped successfully for device:', { deviceId })

      return true
    } catch (error) {
      logger.error('Failed to stop Scrcpy:', error as Error)
      return false
    }
  }

  public async stopAllScrcpy(): Promise<void> {
    try {
      logger.info('Stopping all Scrcpy processes')
      await deviceServiceProxy.stopAllScrcpy()
      this.processes.clear()
      logger.info('All Scrcpy processes stopped')
    } catch (error) {
      logger.error('Failed to stop all Scrcpy:', error as Error)
    }
  }

  public getProcess(deviceId: string): ScrcpyProcess | undefined {
    return this.processes.get(deviceId)
  }

  public getAllProcesses(): ScrcpyProcess[] {
    return Array.from(this.processes.values())
  }

  public isDeviceStreaming(deviceId: string): boolean {
    return this.processes.has(deviceId)
  }

  public async getStreamUrl(deviceId: string): Promise<string | null> {
    const process = this.processes.get(deviceId)
    if (process && process.isRunning) {
      return `http://localhost:${process.port}`
    }
    return null
  }
}

export const scrcpyService = ScrcpyService.getInstance()
