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
  })
})
