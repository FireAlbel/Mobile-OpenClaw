import { describe, expect, it } from 'vitest'

import { extractFirstJsonValue, parseFirstJsonValue } from '../JsonExtraction'

describe('JsonExtraction', () => {
  it('extracts the first complete object from concatenated model output', () => {
    const text = '{"action":"tap","x":10,"y":20}{"reason":"extra"}'

    expect(parseFirstJsonValue(text)).toEqual({ action: 'tap', x: 10, y: 20 })
  })

  it('handles braces inside JSON strings', () => {
    const text = 'Result: {"reason":"tap {the} target","x":10} trailing text'

    expect(extractFirstJsonValue(text)).toBe('{"reason":"tap {the} target","x":10}')
  })

  it('extracts arrays from fenced output', () => {
    const text = '```json\n[{"id":1}]\n```\nexplanation'

    expect(parseFirstJsonValue(text)).toEqual([{ id: 1 }])
  })
})
