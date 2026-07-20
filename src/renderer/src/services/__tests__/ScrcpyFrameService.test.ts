import type {
  ScrcpyFrameStreamHealth,
  ScrcpyFrameStreamPacket,
  ScrcpyFrameStreamStatusEvent
} from '@shared/types/ScrcpyStream'
import { describe, expect, it, vi } from 'vitest'

const proxyPacketListener = vi.hoisted(() => vi.fn())
const proxyStatusListener = vi.hoisted(() => vi.fn())

vi.mock('../DeviceServiceProxy', () => ({
  deviceServiceProxy: {
    onScrcpyFrameStreamPacket: proxyPacketListener.mockReturnValue(() => undefined),
    onScrcpyFrameStreamStatus: proxyStatusListener.mockReturnValue(() => undefined)
  }
}))

import { ScrcpyFrameService } from '../ScrcpyFrameService'

function fakeDecoder(width: number, height: number) {
  let framesRendered = 0
  return {
    width,
    height,
    get framesRendered() {
      return framesRendered
    },
    writable: {
      getWriter: () => ({
        write: vi.fn(async (packet: { type: string }) => {
          if (packet.type === 'data') framesRendered += 1
        }),
        releaseLock: vi.fn()
      })
    },
    snapshot: vi.fn(async () => {
      const bytes = new Uint8Array([width % 256, height % 256])
      return { arrayBuffer: async () => bytes.buffer } as Blob
    }),
    dispose: vi.fn()
  }
}

function fakeRuntime(startHook?: (deviceId: string) => void) {
  let packetListener: ((packet: ScrcpyFrameStreamPacket) => void) | undefined
  let statusListener: ((event: ScrcpyFrameStreamStatusEvent) => void) | undefined
  const health = new Map<string, ScrcpyFrameStreamHealth>()
  const runtime = {
    startScrcpyFrameStream: vi.fn(async (deviceId: string) => {
      const value: ScrcpyFrameStreamHealth = {
        deviceId,
        status: 'running',
        codec: 1748121140,
        width: 100,
        height: 200,
        startedAt: Date.now(),
        packetCount: 0
      }
      health.set(deviceId, value)
      startHook?.(deviceId)
      return value
    }),
    stopScrcpyFrameStream: vi.fn(async (deviceId: string) => {
      health.set(deviceId, { deviceId, status: 'stopped', packetCount: 0 })
    }),
    getScrcpyFrameStreamHealth: vi.fn(
      async (deviceId: string): Promise<ScrcpyFrameStreamHealth> =>
        health.get(deviceId) ?? { deviceId, status: 'stopped', packetCount: 0 }
    ),
    onScrcpyFrameStreamPacket: vi.fn((listener: (packet: ScrcpyFrameStreamPacket) => void) => {
      packetListener = listener
      return () => undefined
    }),
    onScrcpyFrameStreamStatus: vi.fn((listener: (event: ScrcpyFrameStreamStatusEvent) => void) => {
      statusListener = listener
      return () => undefined
    })
  }
  return {
    runtime,
    emitPacket: (packet: ScrcpyFrameStreamPacket) => packetListener?.(packet),
    emitStatus: (value: ScrcpyFrameStreamHealth) => statusListener?.({ health: value })
  }
}

function dataPacket(deviceId: string, receivedAt = Date.now()): ScrcpyFrameStreamPacket {
  return {
    deviceId,
    type: 'data',
    data: new Uint8Array([1, 2, 3]),
    keyframe: true,
    pts: '1',
    receivedAt
  }
}

describe('ScrcpyFrameService', () => {
  it('keeps decoded frames isolated by deviceId', async () => {
    const bridge = fakeRuntime()
    const decoders = [fakeDecoder(100, 200), fakeDecoder(300, 600)]
    const service = new ScrcpyFrameService(bridge.runtime, () => decoders.shift() as never)

    await service.start('device-1')
    await service.start('device-2')
    bridge.emitPacket(dataPacket('device-1'))
    bridge.emitPacket(dataPacket('device-2'))

    const first = await service.getLatestFrame('device-1')
    const second = await service.getLatestFrame('device-2')

    expect(first).toMatchObject({ deviceId: 'device-1', source: 'scrcpy_stream', width: 100, height: 200 })
    expect(second).toMatchObject({ deviceId: 'device-2', source: 'scrcpy_stream', width: 300, height: 600 })
    expect(first.imageBase64).not.toBe(second.imageBase64)
    service.dispose()
  })

  it('buffers packets that arrive before the start response', async () => {
    let emitPacket: (packet: ScrcpyFrameStreamPacket) => void = () => undefined
    const bridge = fakeRuntime((deviceId) => emitPacket(dataPacket(deviceId)))
    emitPacket = bridge.emitPacket
    const service = new ScrcpyFrameService(bridge.runtime, () => fakeDecoder(1080, 2400) as never)

    await service.start('device-1')
    const frame = await service.getLatestFrame('device-1')

    expect(frame).toMatchObject({ width: 1080, height: 2400, sequence: 1 })
    service.dispose()
  })

  it('restarts once and rejects a frame that remains stale', async () => {
    let emitPacket: (packet: ScrcpyFrameStreamPacket) => void = () => undefined
    const bridge = fakeRuntime((deviceId) => emitPacket(dataPacket(deviceId, Date.now() - 5_000)))
    emitPacket = bridge.emitPacket
    const service = new ScrcpyFrameService(bridge.runtime, () => fakeDecoder(100, 200) as never)
    await service.start('device-1')

    await expect(service.getLatestFrame('device-1', { maxAgeMs: 100 })).rejects.toThrow('stale')
    expect(bridge.runtime.stopScrcpyFrameStream).toHaveBeenCalledTimes(1)
    expect(bridge.runtime.startScrcpyFrameStream).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('recovers a decoder failure without resetting another device', async () => {
    const bridge = fakeRuntime()
    const broken = fakeDecoder(100, 200)
    broken.writable.getWriter = () => ({
      write: vi.fn().mockRejectedValue(new Error('decode failed')),
      releaseLock: vi.fn()
    })
    const recovered = fakeDecoder(100, 200)
    const other = fakeDecoder(300, 600)
    const decoders = [broken, other, recovered]
    const service = new ScrcpyFrameService(bridge.runtime, () => decoders.shift() as never)

    await service.start('device-1')
    await service.start('device-2')
    bridge.emitPacket(dataPacket('device-1'))
    bridge.emitPacket(dataPacket('device-2'))
    await Promise.resolve()

    const otherFrame = await service.getLatestFrame('device-2')
    const recovering = service.getLatestFrame('device-1')
    await vi.waitFor(() => expect(bridge.runtime.startScrcpyFrameStream).toHaveBeenCalledTimes(3))
    bridge.emitPacket(dataPacket('device-1'))
    const recoveredFrame = await recovering

    expect(otherFrame).toMatchObject({ deviceId: 'device-2', width: 300 })
    expect(recoveredFrame).toMatchObject({ deviceId: 'device-1', width: 100 })
    expect(bridge.runtime.stopScrcpyFrameStream).toHaveBeenCalledWith('device-1')
    expect(bridge.runtime.stopScrcpyFrameStream).not.toHaveBeenCalledWith('device-2')
    service.dispose()
  })
})
