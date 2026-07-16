import { extractFirstJsonValue, parseFirstJsonValue } from '../JsonExtraction'

export const extractJsonObject = extractFirstJsonValue

export function parseJsonFromText<T>(text: string): T {
  return parseFirstJsonValue<T>(text)
}
