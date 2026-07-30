import { loggerService } from '@logger'

const logger = loggerService.withContext('RpaSecureProviderGateway')

export type RpaProviderStatus = 'healthy' | 'degraded' | 'disabled' | 'needs_configuration'

export interface RpaProviderDescriptor {
  id: string
  name: string
  kind: 'retrieval' | 'artifact' | 'tool'
  status: RpaProviderStatus
  required: boolean
  credentialRef?: string
  allowedDomains: string[]
  imported?: boolean
}

export interface RpaRetrievedSnippet {
  providerId: string
  source: string
  uri: string
  content: string
  contentHash: string
  version?: string
  confidence: number
  scope: string[]
  retrievedAt: number
}

export interface RpaRemoteArtifactReference {
  providerId: string
  uri: string
  name: string
  mimeType: string
  sizeBytes: number
  contentHash: string
  fetchedAt: number
}

export interface RpaProviderHealth {
  status: RpaProviderStatus
  message?: string
  checkedAt: number
}

export interface RpaRetrievalProvider {
  descriptor: RpaProviderDescriptor
  health(): Promise<RpaProviderHealth>
  search(input: { query: string; limit: number; scope: string[]; timeoutMs: number }): Promise<RpaRetrievedSnippet[]>
}

export interface RpaArtifactProvider {
  descriptor: RpaProviderDescriptor
  health(): Promise<RpaProviderHealth>
  fetch(input: { uri: string; timeoutMs: number }): Promise<RpaRemoteArtifactReference>
}

export interface RpaToolDefinition {
  name: string
  description: string
  requiresApproval: boolean
  timeoutMs: number
  rateLimitPerMinute: number
  validate(input: unknown): { success: true; data: unknown } | { success: false; issues: string[] }
}

export interface RpaToolProvider {
  descriptor: RpaProviderDescriptor
  health(): Promise<RpaProviderHealth>
  tools(): Promise<RpaToolDefinition[]>
  invoke(name: string, input: unknown, signal: AbortSignal): Promise<unknown>
}

export interface RpaSecureHttpPolicy {
  allowedDomains: string[]
  allowedMimeTypes: string[]
  maxBytes: number
  maxRedirects: number
  timeoutMs: number
  requireTls: boolean
}

export interface RpaSecureHttpRequest {
  url: string
  timeoutMs: number
  maxBytes: number
  allowedMimeTypes: string[]
  allowedDomains: string[]
  maxRedirects: number
  requireTls: boolean
}

export interface RpaSecureHttpResponse {
  finalUrl: string
  redirectChain: string[]
  resolvedAddresses: string[]
  mimeType: string
  sizeBytes: number
  body: Uint8Array
}

export interface RpaSecureHttpTransport {
  fetch(request: RpaSecureHttpRequest): Promise<RpaSecureHttpResponse>
}

export interface RpaToolAuditEvent {
  providerId: string
  toolName: string
  status: 'approved' | 'blocked' | 'succeeded' | 'failed'
  reason?: string
  timestamp: number
  durationMs?: number
}

export interface RpaToolApprovalContext {
  providerId: string
  tool: RpaToolDefinition
  input: unknown
}

export interface RpaProviderGatewayOptions {
  now?: () => number
  approveTool?: (context: RpaToolApprovalContext) => Promise<boolean>
  audit?: (event: RpaToolAuditEvent) => Promise<void> | void
}

export class RpaSecureProviderGateway {
  private readonly now: () => number
  private readonly invocationWindows = new Map<string, number[]>()

  constructor(
    private readonly transport: RpaSecureHttpTransport = new IpcRpaSecureHttpTransport(),
    private readonly options: RpaProviderGatewayOptions = {}
  ) {
    this.now = options.now ?? Date.now
  }

  normalizeSnippets(
    provider: RpaRetrievalProvider,
    snippets: RpaRetrievedSnippet[],
    budgetChars: number
  ): RpaRetrievedSnippet[] {
    const seen = new Set<string>()
    let remaining = Math.max(0, budgetChars)
    return snippets
      .filter((snippet) => snippet.providerId === provider.descriptor.id)
      .sort((left, right) => right.confidence - left.confidence)
      .flatMap((snippet) => {
        const key = snippet.contentHash || `${snippet.uri}:${snippet.content}`
        if (seen.has(key) || remaining <= 0) return []
        seen.add(key)
        const content = redactRemoteContent(snippet.content).slice(0, remaining)
        remaining -= content.length
        return [{ ...snippet, content, confidence: clamp(snippet.confidence, 0, 1) }]
      })
  }

  async fetchRemote(url: string, policy: RpaSecureHttpPolicy): Promise<RpaSecureHttpResponse> {
    validateRemoteUrl(url, policy)
    const response = await this.transport.fetch({
      url,
      timeoutMs: policy.timeoutMs,
      maxBytes: policy.maxBytes,
      allowedMimeTypes: policy.allowedMimeTypes,
      allowedDomains: policy.allowedDomains,
      maxRedirects: policy.maxRedirects,
      requireTls: policy.requireTls
    })
    if (response.redirectChain.length > policy.maxRedirects) throw new Error('Remote provider redirect limit exceeded')
    for (const candidate of [url, ...response.redirectChain, response.finalUrl]) validateRemoteUrl(candidate, policy)
    if (!response.resolvedAddresses.length)
      throw new Error('Remote provider transport did not report resolved addresses')
    for (const address of response.resolvedAddresses)
      if (isPrivateAddress(address)) throw new Error(`Private network address is blocked: ${address}`)
    if (response.sizeBytes > policy.maxBytes || response.body.byteLength > policy.maxBytes)
      throw new Error('Remote provider response exceeds size limit')
    if (!mimeAllowed(response.mimeType, policy.allowedMimeTypes))
      throw new Error(`Remote provider MIME type is blocked: ${response.mimeType}`)
    return response
  }

  async invokeTool(provider: RpaToolProvider, name: string, input: unknown): Promise<unknown> {
    if (provider.descriptor.kind !== 'tool' || provider.descriptor.status !== 'healthy')
      throw new Error('Tool provider is unavailable')
    const tool = (await provider.tools()).find((candidate) => candidate.name === name)
    if (!tool) throw new Error(`Tool is not allowlisted: ${name}`)
    const validated = tool.validate(input)
    if (!validated.success) {
      await this.emitAudit({
        providerId: provider.descriptor.id,
        toolName: name,
        status: 'blocked',
        reason: validated.issues.join('; '),
        timestamp: this.now()
      })
      throw new Error(`Invalid tool parameters: ${validated.issues.join('; ')}`)
    }
    this.enforceRateLimit(provider.descriptor.id, tool)
    if (
      tool.requiresApproval &&
      !(await this.options.approveTool?.({ providerId: provider.descriptor.id, tool, input: validated.data }))
    ) {
      await this.emitAudit({
        providerId: provider.descriptor.id,
        toolName: name,
        status: 'blocked',
        reason: 'approval_required',
        timestamp: this.now()
      })
      throw new Error('Tool invocation requires approval')
    }
    await this.emitAudit({
      providerId: provider.descriptor.id,
      toolName: name,
      status: 'approved',
      timestamp: this.now()
    })
    const startedAt = this.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), tool.timeoutMs)
    try {
      const result = await provider.invoke(name, validated.data, controller.signal)
      await this.emitAudit({
        providerId: provider.descriptor.id,
        toolName: name,
        status: 'succeeded',
        timestamp: this.now(),
        durationMs: this.now() - startedAt
      })
      return result
    } catch (error) {
      const reason = controller.signal.aborted ? 'timeout' : error instanceof Error ? error.message : 'unknown_error'
      await this.emitAudit({
        providerId: provider.descriptor.id,
        toolName: name,
        status: 'failed',
        reason,
        timestamp: this.now(),
        durationMs: this.now() - startedAt
      })
      throw controller.signal.aborted ? new Error(`Tool invocation timed out after ${tool.timeoutMs}ms`) : error
    } finally {
      clearTimeout(timer)
    }
  }

  private enforceRateLimit(providerId: string, tool: RpaToolDefinition): void {
    const key = `${providerId}:${tool.name}`
    const cutoff = this.now() - 60_000
    const recent = (this.invocationWindows.get(key) ?? []).filter((timestamp) => timestamp > cutoff)
    if (recent.length >= tool.rateLimitPerMinute) throw new Error('Tool invocation rate limit exceeded')
    recent.push(this.now())
    this.invocationWindows.set(key, recent)
  }

  private async emitAudit(event: RpaToolAuditEvent): Promise<void> {
    logger.info('RPA provider tool audit event', event)
    await this.options.audit?.(event)
  }
}

export class IpcRpaSecureHttpTransport implements RpaSecureHttpTransport {
  async fetch(request: RpaSecureHttpRequest): Promise<RpaSecureHttpResponse> {
    if (!window.api?.rpa?.secureHttpFetch) throw new Error('Secure HTTP transport is unavailable')
    const response = await window.api.rpa.secureHttpFetch(request)
    return { ...response, body: new Uint8Array(response.body) }
  }
}

export function normalizeImportedProvider(descriptor: RpaProviderDescriptor): RpaProviderDescriptor {
  return descriptor.imported
    ? { ...descriptor, status: descriptor.credentialRef ? 'disabled' : 'needs_configuration' }
    : descriptor
}

export function validateRemoteUrl(rawUrl: string, policy: RpaSecureHttpPolicy): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Remote provider URL is invalid')
  }
  if (url.username || url.password) throw new Error('Credentials in remote provider URLs are blocked')
  if (!['https:', 'http:'].includes(url.protocol))
    throw new Error(`Remote provider protocol is blocked: ${url.protocol}`)
  if (policy.requireTls && url.protocol !== 'https:') throw new Error('Remote provider requires TLS')
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (isPrivateAddress(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost'))
    throw new Error(`Private network host is blocked: ${hostname}`)
  const domains = policy.allowedDomains.map((domain) => domain.toLowerCase().replace(/^\*\./, ''))
  if (!domains.length || !domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`)))
    throw new Error(`Remote provider domain is not allowlisted: ${hostname}`)
  return url
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
    return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  const ipv4 = mapped ?? normalized
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

function mimeAllowed(mimeType: string, allowed: string[]): boolean {
  const normalized = mimeType.split(';')[0].trim().toLowerCase()
  return allowed.some((candidate) =>
    candidate.endsWith('/*') ? normalized.startsWith(candidate.slice(0, -1)) : normalized === candidate
  )
}
function redactRemoteContent(content: string): string {
  return content
    .replace(
      /\b(?:ignore|override)\s+(?:all\s+)?(?:previous|system|developer)\s+instructions\b/gi,
      '[REDACTED:prompt_injection]'
    )
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED:credential]')
}
function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : minimum
}
