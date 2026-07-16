import type { Model } from '@renderer/types'
import type { Chunk } from '@renderer/types/chunk'
import type { ModelMessage } from 'ai'

import { createAiCompletionError } from '../AiCompletionError'

export interface RpaModelClientRequest {
  messages: ModelMessage[]
  allowedTools?: string[]
  model?: Model
  signal?: AbortSignal
}

export interface RpaModelClient {
  complete(request: RpaModelClientRequest): Promise<string>
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
    const defaultAssistant = getDefaultAssistant()
    const assistant = {
      ...defaultAssistant,
      model,
      settings: {
        ...defaultAssistant.settings,
        streamOutput: false,
        reasoning_effort: undefined,
        qwenThinkMode: false
      }
    }

    let response = ''
    let streamError: unknown
    try {
      await fetchChatCompletion({
        messages: request.messages,
        assistant,
        requestOptions: { signal: request.signal },
        onChunkReceived: (chunk: Chunk) => {
          if (chunk.type === ChunkType.TEXT_DELTA || chunk.type === ChunkType.TEXT_COMPLETE) {
            response += chunk.text
          } else if (chunk.type === ChunkType.ERROR) {
            streamError ??= chunk.error
          }
        },
        uiMessages: [],
        allowedTools: request.allowedTools ?? []
      })
    } catch (error) {
      throw createAiCompletionError(`RPA model request (${model.name || model.id})`, streamError, error)
    }

    if (streamError) {
      throw createAiCompletionError(`RPA model request (${model.name || model.id})`, streamError)
    }

    if (!response.trim()) {
      throw createAiCompletionError(`RPA model request (${model.name || model.id})`, undefined)
    }

    return response
  }
}
