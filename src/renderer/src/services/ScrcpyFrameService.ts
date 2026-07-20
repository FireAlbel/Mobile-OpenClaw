import { loggerService } from '@logger'
import type {
  ScrcpyFrameStreamHealth,
  ScrcpyFrameStreamOptions,
  ScrcpyFrameStreamPacket
} from '@shared/types/ScrcpyStream'
import type { ScrcpyMediaStreamPacket, ScrcpyVideoCodecId } from '@yume-chan/scrcpy'
import { BitmapVideoFrameRenderer, WebCodecsVideoDecoder } from '@yume-chan/scrcpy-decoder-webcodecs'

import { type DeviceScreenshot, deviceServiceProxy } from './DeviceServiceProxy'

const logger = loggerService.withContext('ScrcpyFrameService')
const DEFAULT_MAX_AGE_MS = 1_500
const FIRST_FRAME_TIMEOUT_MS = 5_000

interface ScrcpyDecoder {
  readonly width: number
  readonly height: number
  readonly framesRendered: number
  readonly writable: {
    getWriter(): {
      write(packet: ScrcpyMediaStreamPacket): Promise<void>
      releaseLock(): void
    }
  }
  snapshot(): Promise<Blob | undefined>
  dispose(): void
}

interface ScrcpyFrameRuntime {
  startScrcpyFrameStream(deviceId: string, options?: ScrcpyFrameStreamOptions): Promise<ScrcpyFrameStreamHealth>
  stopScrcpyFrameStream(deviceId: string): Promise<void>
  getScrcpyFrameStreamHealth(deviceId: string): Promise<ScrcpyFrameStreamHealth>
  onScrcpyFrameStreamPacket(callback: (packet: ScrcpyFrameStreamPacket) => void): () => void
  onScrcpyFrameStreamStatus(callback: (event: { health: ScrcpyFrameStreamHealth }) => void): () => void
}

interface ScrcpyFrameSession {
  deviceId: string
  health: ScrcpyFrameStreamHealth
  decoder?: ScrcpyDecoder
  pending: ScrcpyFrameStreamPacket[]
  feed: Promise<void>
  latestFrame?: DeviceScreenshot
  sequence: number
  decoderError?: Error
  restart?: Promise<ScrcpyFrameStreamHealth>
}

export interface GetLatestScrcpyFrameOptions extends ScrcpyFrameStreamOptions {
  maxAgeMs?: number
}

type DecoderFactory = (codec: ScrcpyVideoCodecId) => ScrcpyDecoder

export class ScrcpyFrameService {
  private readonly sessions = new Map<string, ScrcpyFrameSession>()
  private readonly unsubscribePacket: () => void
  private readonly unsubscribeStatus: () => void

  constructor(
    private readonly runtime: ScrcpyFrameRuntime = deviceServiceProxy,
    private readonly decoderFactory: DecoderFactory = (codec) => {
      if (!WebCodecsVideoDecoder.isSupported) throw new Error('WebCodecs video decoding is not supported')
      return new WebCodecsVideoDecoder({ codec, renderer: new BitmapVideoFrameRenderer() })
    }
  ) {
    this.unsubscribePacket = runtime.onScrcpyFrameStreamPacket((packet) => this.handlePacket(packet))
    this.unsubscribeStatus = runtime.onScrcpyFrameStreamStatus(({ health }) => this.handleHealth(health))
  }

  async start(deviceId: string, options: ScrcpyFrameStreamOptions = {}): Promise<ScrcpyFrameStreamHealth> {
    let session = this.sessions.get(deviceId)
    if (!session) {
      session = {
        deviceId,
        health: { deviceId, status: 'starting', packetCount: 0 },
        pending: [],
        feed: Promise.resolve(),
        sequence: 0
      }
      this.sessions.set(deviceId, session)
    } else if (session.health.status === 'error' || session.health.status === 'stopped') {
      this.resetDecoder(session)
      session.health = { deviceId, status: 'starting', packetCount: 0 }
    }

    const health = await this.runtime.startScrcpyFrameStream(deviceId, options)
    session.health = {
      ...health,
      lastPacketAt: session.health.lastPacketAt ?? health.lastPacketAt,
      packetCount: Math.max(session.health.packetCount, health.packetCount)
    }
    this.ensureDecoder(session)
    return { ...health }
  }

  async getLatestFrame(deviceId: string, options: GetLatestScrcpyFrameOptions = {}): Promise<DeviceScreenshot> {
    try {
      return await this.captureLatestFrame(deviceId, options)
    } catch (error) {
      logger.warn('Scrcpy frame capture requires a device-local restart', { error, deviceId })
      await this.restart(deviceId, options)
      return await this.captureLatestFrame(deviceId, options)
    }
  }

  private async captureLatestFrame(deviceId: string, options: GetLatestScrcpyFrameOptions): Promise<DeviceScreenshot> {
    const session = this.sessions.get(deviceId)
    if (!session || session.health.status !== 'running') await this.start(deviceId, options)

    const active = this.sessions.get(deviceId)
    if (!active) throw new Error(`Scrcpy frame session is unavailable: ${deviceId}`)
    this.ensureDecoder(active)
    await active.feed
    if (active.decoderError) throw active.decoderError
    await this.waitForFirstFrame(active)

    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    const now = Date.now()
    if (
      active.latestFrame?.capturedAt &&
      active.latestFrame.capturedAt >= (active.health.startedAt ?? 0) &&
      now - active.latestFrame.capturedAt <= maxAgeMs
    ) {
      return active.latestFrame
    }
    if (!active.health.lastPacketAt || now - active.health.lastPacketAt > maxAgeMs) {
      throw new Error(`Scrcpy frame is stale for ${deviceId}`)
    }

    const blob = await active.decoder?.snapshot()
    if (!blob || !active.decoder || active.decoder.width <= 0 || active.decoder.height <= 0) {
      throw new Error(`Scrcpy decoder has no frame for ${deviceId}`)
    }

    active.sequence += 1
    const frame: DeviceScreenshot = {
      deviceId,
      source: 'scrcpy_stream',
      mime: 'image/png',
      imageBase64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
      width: active.decoder.width,
      height: active.decoder.height,
      capturedAt: now,
      sequence: active.sequence,
      codec: active.health.codec,
      codecName: active.health.codecName,
      streamStatus: active.health.status,
      reconnectCount: active.health.reconnectCount
    }
    active.latestFrame = frame
    return frame
  }

  private async restart(deviceId: string, options: ScrcpyFrameStreamOptions): Promise<ScrcpyFrameStreamHealth> {
    const existing = this.sessions.get(deviceId)
    if (existing?.restart) return await existing.restart

    const session: ScrcpyFrameSession = existing ?? {
      deviceId,
      health: { deviceId, status: 'stopped', packetCount: 0 },
      pending: [],
      feed: Promise.resolve(),
      sequence: 0
    }
    this.sessions.set(deviceId, session)
    const restart: Promise<ScrcpyFrameStreamHealth> = (async () => {
      await this.runtime.stopScrcpyFrameStream(deviceId)
      this.resetDecoder(session)
      session.health = { deviceId, status: 'starting', packetCount: 0 }
      return await this.start(deviceId, options)
    })().finally(() => {
      if (session.restart === restart) session.restart = undefined
    })
    session.restart = restart
    return await restart
  }

  async getHealth(deviceId: string): Promise<ScrcpyFrameStreamHealth> {
    const health = await this.runtime.getScrcpyFrameStreamHealth(deviceId)
    this.handleHealth(health)
    return health
  }

  async stop(deviceId: string): Promise<void> {
    const session = this.sessions.get(deviceId)
    this.sessions.delete(deviceId)
    session?.decoder?.dispose()
    await this.runtime.stopScrcpyFrameStream(deviceId)
  }

  dispose(): void {
    this.unsubscribePacket()
    this.unsubscribeStatus()
    for (const session of this.sessions.values()) session.decoder?.dispose()
    this.sessions.clear()
  }

  private handlePacket(packet: ScrcpyFrameStreamPacket): void {
    const session = this.sessions.get(packet.deviceId)
    if (!session) return
    session.health = {
      ...session.health,
      lastPacketAt: packet.receivedAt,
      packetCount: session.health.packetCount + 1
    }
    if (!session.decoder) {
      session.pending.push(packet)
      if (session.pending.length > 60) session.pending.splice(1, session.pending.length - 60)
      return
    }
    this.enqueuePacket(session, packet)
  }

  private handleHealth(health: ScrcpyFrameStreamHealth): void {
    const session = this.sessions.get(health.deviceId)
    if (!session) return
    session.health = {
      ...health,
      lastPacketAt: session.health.lastPacketAt ?? health.lastPacketAt,
      packetCount: Math.max(session.health.packetCount, health.packetCount)
    }
    if (health.status === 'running') this.ensureDecoder(session)
    if (health.status === 'reconnecting' || health.status === 'stopped') this.resetDecoder(session, true)
    if (health.status === 'error') logger.warn('Scrcpy frame stream entered error state', { health })
  }

  private ensureDecoder(session: ScrcpyFrameSession): void {
    if (session.decoder || session.decoderError || session.health.codec === undefined) return
    session.decoder = this.decoderFactory(session.health.codec as ScrcpyVideoCodecId)
    for (const packet of session.pending) this.enqueuePacket(session, packet)
    session.pending = []
  }

  private enqueuePacket(session: ScrcpyFrameSession, packet: ScrcpyFrameStreamPacket): void {
    session.feed = session.feed
      .then(async () => {
        if (!session.decoder) return
        const writer = session.decoder.writable.getWriter()
        try {
          await writer.write({
            type: packet.type,
            data: Uint8Array.from(packet.data),
            ...(packet.type === 'data'
              ? { keyframe: packet.keyframe, pts: packet.pts === undefined ? undefined : BigInt(packet.pts) }
              : {})
          } as ScrcpyMediaStreamPacket)
        } finally {
          writer.releaseLock()
        }
      })
      .catch((error) => {
        logger.error('Failed to decode scrcpy packet', { error, deviceId: session.deviceId })
        session.decoderError = error instanceof Error ? error : new Error(String(error))
        session.decoder?.dispose()
        session.decoder = undefined
        session.pending = []
      })
  }

  private async waitForFirstFrame(session: ScrcpyFrameSession): Promise<void> {
    const startedAt = Date.now()
    while ((session.decoder?.framesRendered ?? 0) === 0) {
      if (session.decoderError) throw session.decoderError
      if (session.health.status === 'error') {
        throw new Error(session.health.error || `Scrcpy frame stream failed for ${session.deviceId}`)
      }
      if (Date.now() - startedAt >= FIRST_FRAME_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for first scrcpy frame for ${session.deviceId}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
      await session.feed
    }
  }

  private resetDecoder(session: ScrcpyFrameSession, retainLatestFrame = false): void {
    session.decoder?.dispose()
    session.decoder = undefined
    session.pending = []
    session.feed = Promise.resolve()
    session.decoderError = undefined
    if (!retainLatestFrame) session.latestFrame = undefined
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export const scrcpyFrameService = new ScrcpyFrameService()
