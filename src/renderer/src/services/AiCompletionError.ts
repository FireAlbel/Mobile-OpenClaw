const GENERIC_NO_OUTPUT_ERROR = 'No output generated. Check the stream for errors.'

function readMessage(value: unknown, seen = new Set<unknown>()): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined

  seen.add(value)
  const record = value as Record<string, unknown>
  for (const key of ['responseBody', 'error', 'data', 'response', 'cause']) {
    const message = readMessage(record[key], seen)
    if (message) return message
  }

  const message = typeof record.message === 'string' ? record.message.trim() : ''
  if (message && message !== 'AI_APICallError') return message

  const status = typeof record.status === 'number' || typeof record.status === 'string' ? String(record.status) : ''
  const statusCode =
    typeof record.statusCode === 'number' || typeof record.statusCode === 'string' ? String(record.statusCode) : ''
  const statusText = typeof record.statusText === 'string' ? record.statusText.trim() : ''
  const code = typeof record.code === 'string' ? record.code.trim() : ''
  const details = [statusCode || status, statusText, code].filter(Boolean).join(' ')
  if (details) return details

  if (message) return message
  return value instanceof Error ? value.name : undefined
}

export function createAiCompletionError(operation: string, streamError: unknown, thrownError?: unknown): Error {
  const streamMessage = readMessage(streamError)
  const thrownMessage = readMessage(thrownError)
  const detail =
    streamMessage ||
    (thrownMessage && thrownMessage !== GENERIC_NO_OUTPUT_ERROR ? thrownMessage : undefined) ||
    thrownMessage ||
    'The model returned no text or error details.'

  return new Error(`${operation} failed: ${detail}`)
}
