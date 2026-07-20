import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchChatCompletionMock = vi.hoisted(() => vi.fn())
const getScreenshotMock = vi.hoisted(() => vi.fn())
const sendTapMock = vi.hoisted(() => vi.fn())
const getLatestFrameMock = vi.hoisted(() => vi.fn())

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ warn: vi.fn() })
  }
}))

vi.mock('@renderer/config/models', () => ({
  isVisionModel: () => true
}))

vi.mock('../ApiService', () => ({
  fetchChatCompletion: fetchChatCompletionMock
}))

vi.mock('../AssistantService', () => ({
  getDefaultAssistant: () => ({ id: 'assistant', settings: {} }),
  getDefaultModel: () => undefined
}))

vi.mock('../DeviceServiceProxy', () => ({
  deviceServiceProxy: {
    getScreenshot: getScreenshotMock,
    sendTap: sendTapMock,
    sendSwipe: vi.fn()
  }
}))

vi.mock('../ScrcpyFrameService', () => ({
  scrcpyFrameService: { getLatestFrame: getLatestFrameMock }
}))

import type { Chunk } from '@renderer/types/chunk'
import { ChunkType } from '@renderer/types/chunk'

import { DeviceVisionActionService, VisionActionNeedsHumanError } from '../DeviceVisionActionService'

const model = {
  id: 'vision-model',
  provider: 'test-provider',
  name: 'Vision Model',
  group: 'test'
}

function completion(text: string) {
  return async ({ onChunkReceived }: { onChunkReceived: (chunk: Chunk) => void }) => {
    onChunkReceived({ type: ChunkType.TEXT_COMPLETE, text } as Chunk)
  }
}

describe('DeviceVisionActionService', () => {
  beforeEach(() => {
    fetchChatCompletionMock.mockReset()
    getScreenshotMock.mockReset()
    sendTapMock.mockReset()
    getLatestFrameMock.mockReset()
    getScreenshotMock.mockResolvedValue({
      deviceId: 'device-1',
      source: 'adb',
      width: 100,
      height: 200,
      mime: 'image/png',
      imageBase64: 'png'
    })
    getLatestFrameMock.mockResolvedValue({
      deviceId: 'device-1',
      source: 'scrcpy_stream',
      width: 100,
      height: 200,
      mime: 'image/png',
      imageBase64: 'stream-png'
    })
  })

  it('accepts the first complete JSON object from concatenated output', async () => {
    fetchChatCompletionMock.mockImplementation(completion('{"action":"tap","x":10,"y":20}{"reason":"extra object"}'))
    const service = new DeviceVisionActionService()

    const result = await service.runVisionAction('device-1', 'tap target', ['tap'], model)

    expect(result.action).toEqual({ action: 'tap', x: 10, y: 20, reason: undefined })
    expect(sendTapMock).toHaveBeenCalledWith('device-1', 10, 20)
    expect(fetchChatCompletionMock).toHaveBeenCalledTimes(1)
  })

  it('asks the model to repair invalid structured output once', async () => {
    fetchChatCompletionMock
      .mockImplementationOnce(completion('I would tap the target.'))
      .mockImplementationOnce(completion('{"action":"tap","x":30,"y":40,"reason":"repaired"}'))
    const service = new DeviceVisionActionService()

    const result = await service.runVisionAction('device-1', 'tap target', ['tap'], model)

    expect(result.repairResponse).toContain('"action":"tap"')
    expect(sendTapMock).toHaveBeenCalledWith('device-1', 30, 40)
    expect(fetchChatCompletionMock).toHaveBeenCalledTimes(2)
  })

  it('requests human intervention when repaired output is still invalid', async () => {
    fetchChatCompletionMock
      .mockImplementationOnce(completion('invalid output'))
      .mockImplementationOnce(completion('still invalid'))
      .mockImplementationOnce(completion('takeover also invalid'))
    const service = new DeviceVisionActionService()

    const error = await service.runVisionAction('device-1', 'tap target', ['tap'], model).catch((reason) => reason)

    expect(error).toBeInstanceOf(VisionActionNeedsHumanError)
    expect(error.intervention).toMatchObject({
      needsHuman: true,
      code: 'vision_output_invalid',
      rawResponse: 'invalid output',
      repairResponse: 'still invalid',
      takeoverResponse: 'takeover also invalid'
    })
  })

  it('uses a fresh screenshot for VLM takeover after repair fails', async () => {
    fetchChatCompletionMock
      .mockImplementationOnce(completion('invalid output'))
      .mockImplementationOnce(completion('still invalid'))
      .mockImplementationOnce(completion('{"action":"tap","x":50,"y":60,"reason":"fresh observation"}'))
    const service = new DeviceVisionActionService()

    const result = await service.runVisionAction('device-1', 'tap target', ['tap'], model)

    expect(result.takeoverResponse).toContain('fresh observation')
    expect(getLatestFrameMock).toHaveBeenCalledTimes(2)
    expect(sendTapMock).toHaveBeenCalledWith('device-1', 50, 60)
  })

  it('uses scrcpy frame dimensions as device input coordinates', async () => {
    getLatestFrameMock.mockResolvedValue({
      deviceId: 'device-1',
      source: 'scrcpy_stream',
      width: 1080,
      height: 2400,
      mime: 'image/png',
      imageBase64: 'phone-screen'
    })
    fetchChatCompletionMock.mockImplementation(completion('{"action":"tap","x":540,"y":1200}'))
    const service = new DeviceVisionActionService()

    const result = await service.runVisionAction('device-1', 'tap target', ['tap'], model)

    expect(result.capture).toMatchObject({ source: 'scrcpy_stream', width: 1080, height: 2400 })
    expect(sendTapMock).toHaveBeenCalledWith('device-1', 540, 1200)
  })

  it('does not fall back to ADB when the scrcpy frame is unavailable', async () => {
    getLatestFrameMock.mockRejectedValue(new Error('scrcpy stream unavailable'))
    const service = new DeviceVisionActionService()

    await expect(service.runVisionAction('device-1', 'tap target', ['tap'], model)).rejects.toThrow(
      'scrcpy stream unavailable'
    )

    expect(getScreenshotMock).not.toHaveBeenCalled()
    expect(fetchChatCompletionMock).not.toHaveBeenCalled()
    expect(sendTapMock).not.toHaveBeenCalled()
  })

  it('does not execute a device action after the request is aborted', async () => {
    const controller = new AbortController()
    fetchChatCompletionMock.mockImplementation(
      async ({ onChunkReceived }: { onChunkReceived: (chunk: Chunk) => void }) => {
        controller.abort(new Error('timed out'))
        onChunkReceived({ type: ChunkType.TEXT_COMPLETE, text: '{"action":"tap","x":10,"y":20}' } as Chunk)
      }
    )
    const service = new DeviceVisionActionService()

    await expect(service.runVisionAction('device-1', 'tap target', ['tap'], model, controller.signal)).rejects.toThrow(
      'timed out'
    )

    expect(sendTapMock).not.toHaveBeenCalled()
  })
})
