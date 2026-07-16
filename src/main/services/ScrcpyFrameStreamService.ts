import { loggerService } from '@logger'
import type {
  ScrcpyFrameStreamHealth,
  ScrcpyFrameStreamOptions,
  ScrcpyFrameStreamPacket
} from '@shared/types/ScrcpyStream'
import { AdbServerClient } from '@yume-chan/adb'
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from '@yume-chan/adb-scrcpy'
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp'
import type { ScrcpyMediaStreamPacket } from '@yume-chan/scrcpy'
import { PushReadableStream } from '@yume-chan/stream-extra'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { dirname, join } from 'path'

import { toolPathManager } from '../utils/tool-paths'

const logger = loggerService.withContext('ScrcpyFrameStreamService')
const DEVICE_SERVER_PATH = '/data/local/tmp/mobile-openclaw-scrcpy-server.jar'

interface ScrcpyFrameStreamSession {
  health: ScrcpyFrameStreamHealth
  client?: AdbScrcpyClient<AdbScrcpyOptions3_3_3<true>>
  adb?: Awaited<ReturnType<AdbServerClient['createAdb']>>
  reader?: {
    read(): Promise<
      | { done: true; value?: undefined }
      | {
          done: false
          value: ScrcpyMediaStreamPacket
        }
    >
    cancel(): Promise<void>
  }
}

type PacketListener = (packet: ScrcpyFrameStreamPacket) => void
type HealthListener = (health: ScrcpyFrameStreamHealth) => void

export class ScrcpyFrameStreamService {
  private readonly sessions = new Map<string, ScrcpyFrameStreamSession>()
  private readonly starts = new Map<string, Promise<ScrcpyFrameStreamHealth>>()
  private readonly packetListeners = new Set<PacketListener>()
  private readonly healthListeners = new Set<HealthListener>()

  onPacket(listener: PacketListener): () => void {
    this.packetListeners.add(listener)
    return () => this.packetListeners.delete(listener)
  }

  onHealthChanged(listener: HealthListener): () => void {
    this.healthListeners.add(listener)
    return () => this.healthListeners.delete(listener)
  }

  async start(deviceId: string, options: ScrcpyFrameStreamOptions = {}): Promise<ScrcpyFrameStreamHealth> {
    const current = this.sessions.get(deviceId)
    if (current?.health.status === 'running') return { ...current.health }

    const pending = this.starts.get(deviceId)
    if (pending) return await pending

    const start = this.startSession(deviceId, options).finally(() => this.starts.delete(deviceId))
    this.starts.set(deviceId, start)
    return await start
  }

  getHealth(deviceId: string): ScrcpyFrameStreamHealth {
    return (
      this.sessions.get(deviceId)?.health ?? {
        deviceId,
        status: 'stopped',
        packetCount: 0
      }
    )
  }

  async stop(deviceId: string): Promise<void> {
    const session = this.sessions.get(deviceId)
    if (!session) return
    this.sessions.delete(deviceId)

    try {
      await session.reader?.cancel()
    } catch (error) {
      logger.debug('Failed to cancel scrcpy frame reader', { error, deviceId })
    }
    try {
      await session.client?.close()
    } catch (error) {
      logger.debug('Failed to close scrcpy frame client', { error, deviceId })
    }
    try {
      await session.adb?.close()
    } catch (error) {
      logger.debug('Failed to close scrcpy frame ADB transport', { error, deviceId })
    }

    this.updateHealth(session, { status: 'stopped' })
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((deviceId) => this.stop(deviceId)))
  }

  private async startSession(deviceId: string, options: ScrcpyFrameStreamOptions): Promise<ScrcpyFrameStreamHealth> {
    const session: ScrcpyFrameStreamSession = {
      health: { deviceId, status: 'starting', packetCount: 0 }
    }
    this.sessions.set(deviceId, session)
    this.emitHealth(session.health)

    try {
      await toolPathManager.initialize()
      const scrcpyPath = toolPathManager.getToolPaths().scrcpyPath
      const serverPath = join(dirname(scrcpyPath), 'scrcpy-server')
      if (!existsSync(serverPath)) throw new Error(`Scrcpy 3.3.3 server not found: ${serverPath}`)

      const connector = new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 })
      const serverClient = new AdbServerClient(connector)
      const adb = await serverClient.createAdb({ serial: deviceId })
      session.adb = adb

      const serverBuffer = await readFile(serverPath)
      const serverStream = new PushReadableStream<Uint8Array>(async (controller) => {
        await controller.enqueue(new Uint8Array(serverBuffer))
      })
      await AdbScrcpyClient.pushServer(adb, serverStream, DEVICE_SERVER_PATH)

      const scrcpyOptions = new AdbScrcpyOptions3_3_3({
        video: true,
        audio: false,
        control: false,
        cleanup: true,
        videoCodec: 'h264',
        maxFps: Math.max(1, Math.min(options.maxFps ?? 5, 30)),
        maxSize: Math.max(0, Math.min(options.maxSize ?? 1080, 4096)),
        videoBitRate: Math.max(100_000, Math.min(options.bitRate ?? 2_000_000, 20_000_000)),
        logLevel: 'warn'
      })
      const client = await AdbScrcpyClient.start(adb, DEVICE_SERVER_PATH, scrcpyOptions)
      session.client = client
      const video = await client.videoStream
      const reader = video.stream.getReader()
      session.reader = reader

      this.updateHealth(session, {
        status: 'running',
        codec: video.metadata.codec,
        width: video.width || video.metadata.width,
        height: video.height || video.metadata.height,
        startedAt: Date.now(),
        error: undefined
      })
      void this.consume(deviceId, session)
      return { ...session.health }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Failed to start scrcpy frame stream', { error, deviceId })
      this.updateHealth(session, { status: 'error', error: message })
      await this.closeFailedSession(session)
      throw new Error(`Failed to start scrcpy frame stream for ${deviceId}: ${message}`)
    }
  }

  private async consume(deviceId: string, session: ScrcpyFrameStreamSession): Promise<void> {
    try {
      while (this.sessions.get(deviceId) === session && session.reader) {
        const { done, value } = await session.reader.read()
        if (done) throw new Error('Scrcpy frame stream ended')

        const receivedAt = Date.now()
        session.health = {
          ...session.health,
          lastPacketAt: receivedAt,
          packetCount: session.health.packetCount + 1
        }
        if (session.health.packetCount % 10 === 0) this.emitHealth(session.health)
        const packet: ScrcpyFrameStreamPacket = {
          deviceId,
          type: value.type,
          data: Uint8Array.from(value.data),
          receivedAt,
          ...(value.type === 'data'
            ? { keyframe: value.keyframe, pts: value.pts === undefined ? undefined : value.pts.toString() }
            : {})
        }
        for (const listener of this.packetListeners) listener(packet)
      }
    } catch (error) {
      if (this.sessions.get(deviceId) !== session) return
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Scrcpy frame stream failed', { error, deviceId })
      this.updateHealth(session, { status: 'error', error: message })
      await this.closeFailedSession(session)
    }
  }

  private updateHealth(session: ScrcpyFrameStreamSession, patch: Partial<ScrcpyFrameStreamHealth>): void {
    session.health = { ...session.health, ...patch }
    this.emitHealth(session.health)
  }

  private emitHealth(health: ScrcpyFrameStreamHealth): void {
    const snapshot = { ...health }
    for (const listener of this.healthListeners) listener(snapshot)
  }

  private async closeFailedSession(session: ScrcpyFrameStreamSession): Promise<void> {
    try {
      await session.client?.close()
    } catch {
      // The failed process may already be closed.
    }
    try {
      await session.adb?.close()
    } catch {
      // The failed transport may already be closed.
    }
  }
}

export const scrcpyFrameStreamService = new ScrcpyFrameStreamService()
