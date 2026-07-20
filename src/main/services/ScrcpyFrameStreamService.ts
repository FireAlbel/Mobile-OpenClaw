import { loggerService } from '@logger'
import type {
  ScrcpyFrameStreamHealth,
  ScrcpyFrameStreamOptions,
  ScrcpyFrameStreamPacket,
  ScrcpyVideoCodecPreference
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
const STARTUP_TIMEOUT_MS = 8_000
const STARTUP_RETRY_DELAY_MS = 250
const STALE_PACKET_TIMEOUT_MS = 2_000
const HEALTH_WATCH_INTERVAL_MS = 500
const MAX_RECONNECT_ATTEMPTS = 3

interface ScrcpyFrameStreamSession {
  deviceId: string
  options: ScrcpyFrameStreamOptions
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
  watchdog?: ReturnType<typeof setInterval>
  recovery?: Promise<ScrcpyFrameStreamHealth>
  stopped: boolean
}

type PacketListener = (packet: ScrcpyFrameStreamPacket) => void
type HealthListener = (health: ScrcpyFrameStreamHealth) => void
type ScrcpyCodecName = 'h264' | 'h265'

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
    if (current?.recovery) return await current.recovery

    const pending = this.starts.get(deviceId)
    if (pending) return await pending

    const session = current?.stopped
      ? this.createSession(deviceId, options)
      : (current ?? this.createSession(deviceId, options))
    session.options = { ...session.options, ...options }
    session.stopped = false
    this.sessions.set(deviceId, session)

    const start: Promise<ScrcpyFrameStreamHealth> = this.connectWithStartupRetry(session).finally(() => {
      if (this.starts.get(deviceId) === start) this.starts.delete(deviceId)
    })
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
    this.starts.delete(deviceId)
    session.stopped = true
    this.clearSessionTimers(session)
    await this.closeResources(session)
    this.updateHealth(session, { status: 'stopped' })
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((deviceId) => this.stop(deviceId)))
  }

  private createSession(deviceId: string, options: ScrcpyFrameStreamOptions): ScrcpyFrameStreamSession {
    return {
      deviceId,
      options,
      health: { deviceId, status: 'starting', packetCount: 0, reconnectCount: 0 },
      stopped: false
    }
  }

  private async connectWithStartupRetry(session: ScrcpyFrameStreamSession): Promise<ScrcpyFrameStreamHealth> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const codec of codecCandidates(session.options.codecPreference ?? 'auto')) {
        try {
          return await this.openSession(session, codec)
        } catch (error) {
          lastError = error
          await this.closeResources(session)
          if (session.stopped || this.sessions.get(session.deviceId) !== session) throw error
          logger.warn('Scrcpy frame stream startup attempt failed', {
            error,
            deviceId: session.deviceId,
            codec,
            attempt: attempt + 1
          })
        }
      }
      if (attempt === 0) await delay(STARTUP_RETRY_DELAY_MS)
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError)
    this.updateHealth(session, { status: 'error', error: message, lastErrorAt: Date.now() })
    throw new Error(`Failed to start scrcpy frame stream for ${session.deviceId}: ${message}`)
  }

  private async openSession(
    session: ScrcpyFrameStreamSession,
    codecName: ScrcpyCodecName
  ): Promise<ScrcpyFrameStreamHealth> {
    const { deviceId, options } = session
    this.updateHealth(session, {
      status: session.health.reconnectCount ? 'reconnecting' : 'starting',
      error: undefined
    })
    await toolPathManager.initialize()
    this.assertActive(session)
    const scrcpyPath = toolPathManager.getToolPaths().scrcpyPath
    const serverPath = join(dirname(scrcpyPath), 'scrcpy-server')
    if (!existsSync(serverPath)) throw new Error(`Scrcpy 3.3.3 server not found: ${serverPath}`)

    const connector = new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: 5037 })
    const serverClient = new AdbServerClient(connector)
    const adb = await serverClient.createAdb({ serial: deviceId })
    session.adb = adb
    this.assertActive(session)

    const serverBuffer = await readFile(serverPath)
    const serverStream = new PushReadableStream<Uint8Array>(async (controller) => {
      await controller.enqueue(new Uint8Array(serverBuffer))
    })
    await AdbScrcpyClient.pushServer(adb, serverStream, DEVICE_SERVER_PATH)
    this.assertActive(session)

    const scrcpyOptions = new AdbScrcpyOptions3_3_3({
      video: true,
      audio: false,
      control: false,
      cleanup: true,
      videoCodec: codecName,
      maxFps: Math.max(1, Math.min(options.maxFps ?? 5, 30)),
      maxSize: Math.max(0, Math.min(options.maxSize ?? 1080, 4096)),
      videoBitRate: Math.max(100_000, Math.min(options.bitRate ?? 2_000_000, 20_000_000)),
      logLevel: 'warn'
    })
    const client = await withTimeoutAndLateCleanup(
      AdbScrcpyClient.start(adb, DEVICE_SERVER_PATH, scrcpyOptions),
      STARTUP_TIMEOUT_MS,
      (lateClient) => lateClient.close(),
      `Scrcpy startup timed out after ${STARTUP_TIMEOUT_MS}ms`
    )
    session.client = client
    this.assertActive(session)
    const video = await client.videoStream
    this.assertActive(session)
    const reader = video.stream.getReader()
    session.reader = reader

    this.updateHealth(session, {
      status: 'running',
      codec: video.metadata.codec,
      codecName,
      width: video.width || video.metadata.width,
      height: video.height || video.metadata.height,
      startedAt: Date.now(),
      lastPacketAt: undefined,
      error: undefined
    })
    this.startWatchdog(session)
    void this.consume(session)
    return { ...session.health }
  }

  private async consume(session: ScrcpyFrameStreamSession): Promise<void> {
    const { deviceId } = session
    try {
      while (this.sessions.get(deviceId) === session && !session.stopped && session.reader) {
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
      if (this.sessions.get(deviceId) !== session || session.stopped) return
      await this.scheduleReconnect(session, error)
    }
  }

  private startWatchdog(session: ScrcpyFrameStreamSession): void {
    if (session.watchdog) clearInterval(session.watchdog)
    session.watchdog = setInterval(() => {
      if (session.health.status !== 'running') return
      const latestActivity = session.health.lastPacketAt ?? session.health.startedAt
      if (latestActivity && Date.now() - latestActivity > STALE_PACKET_TIMEOUT_MS) {
        void this.scheduleReconnect(session, new Error(`No scrcpy packet for ${STALE_PACKET_TIMEOUT_MS}ms`))
      }
    }, HEALTH_WATCH_INTERVAL_MS)
  }

  private async scheduleReconnect(session: ScrcpyFrameStreamSession, error: unknown): Promise<void> {
    if (session.stopped || this.sessions.get(session.deviceId) !== session) return
    if (session.recovery) {
      await session.recovery
      return
    }

    const recovery: Promise<ScrcpyFrameStreamHealth> = this.recoverSession(session, error).finally(() => {
      if (session.recovery === recovery) session.recovery = undefined
    })
    session.recovery = recovery
    await recovery
  }

  private async recoverSession(
    session: ScrcpyFrameStreamSession,
    initialError: unknown
  ): Promise<ScrcpyFrameStreamHealth> {
    let lastError = initialError
    this.clearSessionTimers(session)
    await this.closeResources(session)

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      if (session.stopped || this.sessions.get(session.deviceId) !== session) break
      const reconnectCount = (session.health.reconnectCount ?? 0) + 1
      const message = lastError instanceof Error ? lastError.message : String(lastError)
      this.updateHealth(session, {
        status: 'reconnecting',
        reconnectCount,
        error: message,
        lastErrorAt: Date.now()
      })
      await delay(250 * 2 ** (reconnectCount - 1))
      if (session.stopped || this.sessions.get(session.deviceId) !== session) return { ...session.health }

      try {
        return await this.connectWithStartupRetry(session)
      } catch (error) {
        lastError = error
        await this.closeResources(session)
      }
    }
    if (!session.stopped && this.sessions.get(session.deviceId) === session) {
      const message = lastError instanceof Error ? lastError.message : String(lastError)
      this.updateHealth(session, { status: 'error', error: message, lastErrorAt: Date.now() })
    }
    return { ...session.health }
  }

  private updateHealth(session: ScrcpyFrameStreamSession, patch: Partial<ScrcpyFrameStreamHealth>): void {
    session.health = { ...session.health, ...patch }
    this.emitHealth(session.health)
  }

  private emitHealth(health: ScrcpyFrameStreamHealth): void {
    const snapshot = { ...health }
    for (const listener of this.healthListeners) listener(snapshot)
  }

  private clearSessionTimers(session: ScrcpyFrameStreamSession): void {
    if (session.watchdog) clearInterval(session.watchdog)
    session.watchdog = undefined
  }

  private assertActive(session: ScrcpyFrameStreamSession): void {
    if (session.stopped || this.sessions.get(session.deviceId) !== session) {
      throw new Error(`Scrcpy frame stream stopped during startup: ${session.deviceId}`)
    }
  }

  private async closeResources(session: ScrcpyFrameStreamSession): Promise<void> {
    const reader = session.reader
    const client = session.client
    const adb = session.adb
    session.reader = undefined
    session.client = undefined
    session.adb = undefined

    try {
      await reader?.cancel()
    } catch (error) {
      logger.debug('Failed to cancel scrcpy frame reader', { error, deviceId: session.deviceId })
    }
    try {
      await client?.close()
    } catch (error) {
      logger.debug('Failed to close scrcpy frame client', { error, deviceId: session.deviceId })
    }
    try {
      await adb?.close()
    } catch (error) {
      logger.debug('Failed to close scrcpy frame ADB transport', { error, deviceId: session.deviceId })
    }
  }
}

function codecCandidates(preference: ScrcpyVideoCodecPreference): ScrcpyCodecName[] {
  if (preference === 'h264') return ['h264']
  if (preference === 'h265') return ['h265', 'h264']
  return ['h264', 'h265']
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs))
}

function withTimeoutAndLateCleanup<T>(
  promise: Promise<T>,
  timeoutMs: number,
  cleanup: (value: T) => void | Promise<void>,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      reject(new Error(message))
    }, timeoutMs)
    void promise.then(
      async (value) => {
        clearTimeout(timeout)
        if (timedOut) {
          await cleanup(value)
          return
        }
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        if (!timedOut) reject(error)
      }
    )
  })
}

export const scrcpyFrameStreamService = new ScrcpyFrameStreamService()
