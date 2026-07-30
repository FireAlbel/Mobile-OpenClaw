import type { Assistant, Model } from '@renderer/types'
import type { Chunk } from '@renderer/types/chunk'
import type { ModelMessage } from 'ai'

import { createAiCompletionError } from '../AiCompletionError'

export interface RpaModelClientRequest {
  messages: ModelMessage[]
  assistant?: Assistant
  allowedTools?: string[]
  model?: Model
  signal?: AbortSignal
}

export interface RpaModelClient {
  complete(request: RpaModelClientRequest): Promise<string>
}

export class RpaTextResponseCollector {
  private response = ''

  addDelta(text: string): void {
    if (text.startsWith(this.response)) {
      this.response = text
      return
    }

    if (!this.response.endsWith(text)) {
      this.response += text
    }
  }

  complete(text: string): void {
    this.response = text
  }

  get text(): string {
    return this.response
  }
}

export class DefaultRpaModelClient implements RpaModelClient {
  async complete(request: RpaModelClientRequest): Promise<string> {
    const [{ fetchChatCompletion }, { getDefaultAssistant, getDefaultModel }, { ChunkType }] = await Promise.all([
      import('@renderer/services/ApiService'),
      import('@renderer/services/AssistantService'),
      import('@renderer/types/chunk')
    ])
    const model = request.model ?? getDefaultModel()
    if (!model) throw new Error('No model is configured for RPA reasoning')
    const defaultAssistant = request.assistant ?? getDefaultAssistant()
    const assistant = {
      ...defaultAssistant,
      model,
      settings: {
        ...defaultAssistant.settings,
        reasoning_effort: undefined,
        qwenThinkMode: false
      }
    }

    const responseCollector = new RpaTextResponseCollector()
    let streamError: unknown
    const streamAbortController = new AbortController()
    const signal = request.signal
      ? AbortSignal.any([request.signal, streamAbortController.signal])
      : streamAbortController.signal
    try {
      await fetchChatCompletion({
        messages: request.messages,
        assistant,
        requestOptions: { signal },
        onChunkReceived: (chunk: Chunk) => {
          if (chunk.type === ChunkType.TEXT_DELTA) {
            responseCollector.addDelta(chunk.text)
          } else if (chunk.type === ChunkType.TEXT_COMPLETE) {
            responseCollector.complete(chunk.text)
          } else if (chunk.type === ChunkType.ERROR) {
            streamError ??= chunk.error
            streamAbortController.abort(chunk.error)
          }
        },
        uiMessages: [],
        allowedTools: request.allowedTools
      })
    } catch (error) {
      throw createAiCompletionError(`RPA model request (${model.name || model.id})`, streamError, error)
    }

    if (streamError) {
      throw createAiCompletionError(`RPA model request (${model.name || model.id})`, streamError)
    }

    const response = responseCollector.text
    if (!response.trim()) {
      throw createAiCompletionError(`RPA model request (${model.name || model.id})`, undefined)
    }

    return response
  }
}
