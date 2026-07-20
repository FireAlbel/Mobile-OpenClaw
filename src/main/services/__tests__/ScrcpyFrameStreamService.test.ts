import { beforeEach, describe, expect, it, vi } from 'vitest'

const pushServerMock = vi.hoisted(() => vi.fn())
const startClientMock = vi.hoisted(() => vi.fn())
const createAdbMock = vi.hoisted(() => vi.fn())
const readFileMock = vi.hoisted(() => vi.fn())
const existsSyncMock = vi.hoisted(() => vi.fn())

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ error: vi.fn(), debug: vi.fn(), warn: vi.fn(), info: vi.fn() })
  }
}))

vi.mock('@yume-chan/adb', () => ({
  AdbServerClient: class AdbServerClient {
    createAdb = createAdbMock
  }
}))

vi.mock('@yume-chan/adb-server-node-tcp', () => ({
  AdbServerNodeTcpConnector: class AdbServerNodeTcpConnector {}
}))

vi.mock('@yume-chan/adb-scrcpy', () => ({
  AdbScrcpyClient: class AdbScrcpyClient {
    static pushServer = pushServerMock
    static start = startClientMock
  },
  AdbScrcpyOptions3_3_3: class AdbScrcpyOptions3_3_3 {
    constructor(readonly value: unknown) {}
  }
}))

vi.mock('fs', () => ({ existsSync: existsSyncMock }))
vi.mock('fs/promises', () => ({ readFile: readFileMock }))
vi.mock('../../utils/tool-paths', () => ({
  toolPathManager: {
    initialize: vi.fn().mockResolvedValue(undefined),
    getToolPaths: () => ({ scrcpyPath: 'D:\\tools\\scrcpy\\scrcpy.exe' })
  }
}))

import { ScrcpyFrameStreamService } from '../ScrcpyFrameStreamService'

function fakeClient(deviceId: string) {
  const packet = {
    type: 'data' as const,
    data: new Uint8Array([deviceId.length]),
    keyframe: true,
    pts: 1n
  }
  const reader = {
    read: vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: packet })
      .mockImplementation(() => new Promise(() => {})),
    cancel: vi.fn().mockResolvedValue(undefined)
  }
  return {
    reader,
    client: {
      videoStream: Promise.resolve({
        metadata: { codec: 1748121140, width: 1080, height: 2400 },
        width: 1080,
        height: 2400,
        stream: { getReader: () => reader }
      }),
      close: vi.fn().mockResolvedValue(undefined)
    }
  }
}

function endedClient() {
  const reader = {
    read: vi.fn().mockResolvedValue({ done: true }),
    cancel: vi.fn().mockResolvedValue(undefined)
  }
  return {
    videoStream: Promise.resolve({
      metadata: { codec: 1748121140, width: 1080, height: 2400 },
      width: 1080,
      height: 2400,
      stream: { getReader: () => reader }
    }),
    close: vi.fn().mockResolvedValue(undefined)
  }
}

describe('ScrcpyFrameStreamService', () => {
  beforeEach(() => {
    pushServerMock.mockReset().mockResolvedValue(undefined)
    startClientMock.mockReset()
    createAdbMock.mockReset().mockImplementation(async ({ serial }: { serial: string }) => ({
      serial,
      close: vi.fn().mockResolvedValue(undefined)
    }))
    readFileMock.mockReset().mockResolvedValue(Buffer.from('server'))
    existsSyncMock.mockReset().mockReturnValue(true)
  })

  it('starts independent scrcpy 3.3.3 streams and routes packets by deviceId', async () => {
    const clients = new Map([
      ['device-a', fakeClient('device-a')],
      ['device-bb', fakeClient('device-bb')]
    ])
    startClientMock.mockImplementation(async (adb: { serial: string }) => clients.get(adb.serial)?.client)
    const service = new ScrcpyFrameStreamService()
    const packets: Array<{ deviceId: string; data: Uint8Array }> = []
    service.onPacket((packet) => packets.push(packet))

    const first = await service.start('device-a')
    const second = await service.start('device-bb')
    await vi.waitFor(() => expect(packets).toHaveLength(2))

    expect(first).toMatchObject({ deviceId: 'device-a', status: 'running', width: 1080, height: 2400 })
    expect(second).toMatchObject({ deviceId: 'device-bb', status: 'running' })
    expect(packets.map((packet) => packet.deviceId)).toEqual(['device-a', 'device-bb'])
    expect(pushServerMock).toHaveBeenCalledTimes(2)
    await service.stopAll()
  })

  it('reports a structured error when the unified server cannot start', async () => {
    startClientMock.mockRejectedValue(new Error('protocol startup failed'))
    const service = new ScrcpyFrameStreamService()

    await expect(service.start('device-a')).rejects.toThrow('protocol startup failed')

    expect(service.getHealth('device-a')).toMatchObject({
      deviceId: 'device-a',
      status: 'error',
      error: 'protocol startup failed'
    })
    await service.stopAll()
  })

  it('falls back from H.265 to H.264 for the same device', async () => {
    const fallback = fakeClient('device-a')
    startClientMock.mockImplementation(async (_adb, _path, options: { value: { videoCodec: string } }) => {
      if (options.value.videoCodec === 'h265') throw new Error('H.265 encoder unavailable')
      return fallback.client
    })
    const service = new ScrcpyFrameStreamService()

    const health = await service.start('device-a', { codecPreference: 'h265' })

    expect(health).toMatchObject({ status: 'running', codecName: 'h264' })
    expect(startClientMock.mock.calls.map((call) => call[2].value.videoCodec)).toEqual(['h265', 'h264'])
    await service.stopAll()
  })

  it('retries a transient startup failure once', async () => {
    const recovered = fakeClient('device-a')
    startClientMock.mockRejectedValueOnce(new Error('ADB transport busy')).mockResolvedValue(recovered.client)
    const service = new ScrcpyFrameStreamService()

    const health = await service.start('device-a', { codecPreference: 'h264' })

    expect(health.status).toBe('running')
    expect(startClientMock).toHaveBeenCalledTimes(2)
    await service.stopAll()
  })

  it('reconnects an ended reader without restarting another device', async () => {
    const recovered = fakeClient('device-a')
    const other = fakeClient('device-b')
    let deviceAStarts = 0
    startClientMock.mockImplementation(async (adb: { serial: string }) => {
      if (adb.serial === 'device-b') return other.client
      deviceAStarts += 1
      return deviceAStarts === 1 ? endedClient() : recovered.client
    })
    const service = new ScrcpyFrameStreamService()

    await service.start('device-a')
    await service.start('device-b')
    await vi.waitFor(
      () => expect(service.getHealth('device-a')).toMatchObject({ status: 'running', reconnectCount: 1 }),
      { timeout: 2_000 }
    )

    expect(service.getHealth('device-a').reconnectCount).toBe(1)
    expect(startClientMock.mock.calls.filter((call) => call[0].serial === 'device-a')).toHaveLength(2)
    expect(startClientMock.mock.calls.filter((call) => call[0].serial === 'device-b')).toHaveLength(1)
    await service.stopAll()
  })

  it('uses the packet watchdog to reconnect only the stale device', async () => {
    vi.useFakeTimers()
    const first = fakeClient('device-a')
    const second = fakeClient('device-a')
    startClientMock.mockResolvedValueOnce(first.client).mockResolvedValue(second.client)
    const service = new ScrcpyFrameStreamService()
    try {
      await service.start('device-a')
      await vi.advanceTimersByTimeAsync(3_000)

      expect(startClientMock).toHaveBeenCalledTimes(2)
      expect(service.getHealth('device-a')).toMatchObject({ status: 'running', reconnectCount: 1 })
    } finally {
      await service.stopAll()
      vi.useRealTimers()
    }
  })
})
