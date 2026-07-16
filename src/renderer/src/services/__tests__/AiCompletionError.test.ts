import { describe, expect, it } from 'vitest'

import { createAiCompletionError } from '../AiCompletionError'

describe('createAiCompletionError', () => {
  it('prefers a concrete stream error over the generic no-output error', () => {
    const error = createAiCompletionError(
      'VLM request (test-model)',
      { error: { message: 'Image inputs are not supported' } },
      new Error('No output generated. Check the stream for errors.')
    )

    expect(error.message).toBe('VLM request (test-model) failed: Image inputs are not supported')
  })

  it('reports an empty response when no error details are available', () => {
    const error = createAiCompletionError('RPA model request (test-model)', undefined)

    expect(error.message).toBe('RPA model request (test-model) failed: The model returned no text or error details.')
  })

  it('extracts the provider response body from an API call error', () => {
    const apiError = Object.assign(new Error('AI_APICallError'), {
      statusCode: 400,
      responseBody: '{"error":{"message":"This model does not support image input"}}'
    })

    const error = createAiCompletionError('VLM request (text-model)', apiError)

    expect(error.message).toContain('This model does not support image input')
  })
})
