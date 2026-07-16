function findJsonStart(text: string): number {
  const objectIndex = text.indexOf('{')
  const arrayIndex = text.indexOf('[')
  if (objectIndex < 0) return arrayIndex
  if (arrayIndex < 0) return objectIndex
  return Math.min(objectIndex, arrayIndex)
}

export function extractFirstJsonValue(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const source = fenced?.[1]?.trim() || text.trim()
  const start = findJsonStart(source)
  if (start < 0) return source

  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
    } else if (character === '{' || character === '[') {
      stack.push(character)
    } else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '['
      if (stack.at(-1) !== expected) break
      stack.pop()
      if (stack.length === 0) return source.slice(start, index + 1)
    }
  }

  return source.slice(start).trim()
}

export function parseFirstJsonValue<T>(text: string): T {
  return JSON.parse(extractFirstJsonValue(text)) as T
}
