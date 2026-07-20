export type ScrcpyFrameStreamStatus = 'starting' | 'running' | 'reconnecting' | 'stopped' | 'error'

export type ScrcpyVideoCodecPreference = 'auto' | 'h264' | 'h265'

export interface ScrcpyFrameStreamOptions {
  maxFps?: number
  maxSize?: number
  bitRate?: number
  codecPreference?: ScrcpyVideoCodecPreference
}

export interface ScrcpyFrameStreamHealth {
  deviceId: string
  status: ScrcpyFrameStreamStatus
  codec?: number
  codecName?: 'h264' | 'h265'
  width?: number
  height?: number
  startedAt?: number
  lastPacketAt?: number
  packetCount: number
  reconnectCount?: number
  lastErrorAt?: number
  error?: string
}

export interface ScrcpyFrameStreamPacket {
  deviceId: string
  type: 'configuration' | 'data'
  data: Uint8Array
  keyframe?: boolean
  pts?: string
  receivedAt: number
}

export interface ScrcpyFrameStreamStatusEvent {
  health: ScrcpyFrameStreamHealth
}

export const ScrcpyFrameStreamChannels = {
  start: 'device:startScrcpyFrameStream',
  stop: 'device:stopScrcpyFrameStream',
  health: 'device:getScrcpyFrameStreamHealth',
  packet: 'device:scrcpyFrameStreamPacket',
  status: 'device:scrcpyFrameStreamStatus'
} as const
