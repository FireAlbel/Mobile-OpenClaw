import dns from 'node:dns/promises'

import { loggerService } from '@logger'

const logger = loggerService.withContext('RpaSecureHttpTransportService')

export interface SecureHttpFetchRequest {
  url: string
  timeoutMs: number
  maxBytes: number
  allowedMimeTypes: string[]
  allowedDomains: string[]
  maxRedirects: number
  requireTls: boolean
}

export interface SecureHttpFetchResponse {
  finalUrl: string
  redirectChain: string[]
  resolvedAddresses: string[]
  mimeType: string
  sizeBytes: number
  body: Uint8Array
}

export class RpaSecureHttpTransportService {
  async fetch(input: SecureHttpFetchRequest): Promise<SecureHttpFetchResponse> {
    const timeoutMs = bound(input.timeoutMs, 100, 60_000)
    const maxBytes = bound(input.maxBytes, 1, 64 * 1024 * 1024)
    const maxRedirects = bound(input.maxRedirects, 0, 5)
    const redirectChain: string[] = []
    const resolvedAddresses = new Set<string>()
    let current = input.url
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
        const url = await validateAndResolve(current, input.allowedDomains, input.requireTls, resolvedAddresses)
        const response = await globalThis.fetch(url, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: input.allowedMimeTypes.join(', ') }
        })
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location) throw new Error('Remote redirect has no Location header')
          if (redirect === maxRedirects) throw new Error('Remote redirect limit exceeded')
          current = new URL(location, url).toString()
          redirectChain.push(current)
          continue
        }
        if (!response.ok) throw new Error(`Remote request failed with HTTP ${response.status}`)
        const mimeType =
          response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? 'application/octet-stream'
        if (!mimeAllowed(mimeType, input.allowedMimeTypes)) throw new Error(`Remote MIME type is blocked: ${mimeType}`)
        const declaredLength = Number(response.headers.get('content-length') ?? 0)
        if (declaredLength > maxBytes) throw new Error('Remote response exceeds size limit')
        const body = await readBoundedBody(response, maxBytes)
        return {
          finalUrl: url.toString(),
          redirectChain,
          resolvedAddresses: [...resolvedAddresses],
          mimeType,
          sizeBytes: body.byteLength,
          body
        }
      }
      throw new Error('Remote redirect limit exceeded')
    } catch (error) {
      logger.warn('Secure remote provider request failed', { url: redactUrl(input.url), error })
      throw controller.signal.aborted ? new Error(`Remote request timed out after ${timeoutMs}ms`) : error
    } finally {
      clearTimeout(timer)
    }
  }
}

async function validateAndResolve(
  raw: string,
  domains: string[],
  requireTls: boolean,
  addresses: Set<string>
): Promise<URL> {
  const url = new URL(raw)
  if (url.username || url.password) throw new Error('Credentials in URL are blocked')
  if (requireTls && url.protocol !== 'https:') throw new Error('TLS is required')
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error(`Protocol is blocked: ${url.protocol}`)
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  const allowed = domains.map((domain) => domain.toLowerCase().replace(/^\*\./, ''))
  if (!allowed.length || !allowed.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new Error(`Domain is not allowlisted: ${hostname}`)
  }
  const resolved = await dns.lookup(hostname, { all: true, verbatim: true })
  if (!resolved.length) throw new Error('Host did not resolve')
  for (const item of resolved) {
    if (isPrivateAddress(item.address)) throw new Error(`Private network address is blocked: ${item.address}`)
    addresses.add(item.address)
  }
  return url
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new Error('Remote response exceeds size limit')
    }
    chunks.push(value)
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  if (normalized === '::1' || normalized === '::' || /^(?:fc|fd|fe[89ab])/.test(normalized)) return true
  const ipv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1] ?? normalized
  const parts = ipv4.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

function mimeAllowed(mime: string, allowed: string[]): boolean {
  return allowed.some((candidate) =>
    candidate.endsWith('/*') ? mime.startsWith(candidate.slice(0, -1)) : mime === candidate.toLowerCase()
  )
}

function bound(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value))) : minimum
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = ''
    return url.toString()
  } catch {
    return '[invalid-url]'
  }
}

export const rpaSecureHttpTransportService = new RpaSecureHttpTransportService()
