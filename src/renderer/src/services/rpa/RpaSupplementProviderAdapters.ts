import { loggerService } from '@logger'

import type { RpaFederatedRetrievalSource, RpaPlanningEvidence } from './RpaFederatedRetrievalService'
import {
  type RpaArtifactProvider,
  type RpaProviderDescriptor,
  type RpaRetrievalProvider,
  type RpaSecureHttpPolicy,
  RpaSecureProviderGateway,
  type RpaToolProvider
} from './RpaSecureProviderGateway'
import { stableHash } from './RpaSupplementContext'

const logger = loggerService.withContext('RpaSupplementProviderAdapters')

export interface RpaMcpResourceContent {
  uri: string
  name?: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface RpaMcpResourceProviderRuntime {
  descriptor: RpaProviderDescriptor
  read(uri: string, signal: AbortSignal): Promise<unknown>
}

export class RpaSupplementProviderRuntimeRegistry {
  private readonly retrievalProviders = new Map<string, RpaRetrievalProvider>()
  private readonly artifactProviders = new Map<string, RpaArtifactProvider>()
  private readonly mcpResourceProviders = new Map<string, RpaMcpResourceProviderRuntime>()

  registerRetrieval(provider: RpaRetrievalProvider): () => void {
    this.retrievalProviders.set(provider.descriptor.id, provider)
    return () => {
      if (this.retrievalProviders.get(provider.descriptor.id) === provider) {
        this.retrievalProviders.delete(provider.descriptor.id)
      }
    }
  }

  registerArtifact(provider: RpaArtifactProvider): () => void {
    this.artifactProviders.set(provider.descriptor.id, provider)
    return () => {
      if (this.artifactProviders.get(provider.descriptor.id) === provider) {
        this.artifactProviders.delete(provider.descriptor.id)
      }
    }
  }

  registerMcpResource(provider: RpaMcpResourceProviderRuntime): () => void {
    this.mcpResourceProviders.set(provider.descriptor.id, provider)
    return () => {
      if (this.mcpResourceProviders.get(provider.descriptor.id) === provider) {
        this.mcpResourceProviders.delete(provider.descriptor.id)
      }
    }
  }

  getRetrieval(id: string): RpaRetrievalProvider | undefined {
    return this.retrievalProviders.get(id)
  }

  getArtifact(id: string): RpaArtifactProvider | undefined {
    return this.artifactProviders.get(id)
  }

  getMcpResource(id: string): RpaMcpResourceProviderRuntime | undefined {
    return this.mcpResourceProviders.get(id)
  }

  listDescriptors(): RpaProviderDescriptor[] {
    const descriptors = [
      ...this.retrievalProviders.values(),
      ...this.artifactProviders.values(),
      ...this.mcpResourceProviders.values()
    ].map((provider) => provider.descriptor)
    return [...new Map(descriptors.map((descriptor) => [descriptor.id, descriptor])).values()]
  }
}

export class RpaApprovedUrlEvidenceAdapter {
  constructor(private readonly gateway = new RpaSecureProviderGateway()) {}

  createSource(input: {
    id: string
    url: string
    provider: RpaProviderDescriptor
    policy: RpaSecureHttpPolicy
    required?: boolean
  }): RpaFederatedRetrievalSource {
    assertReadProvider(input.provider)
    if (!input.provider.allowedDomains.length) throw new Error('URL Provider has no Role-approved domains')
    return {
      id: input.id,
      type: 'remote_provider',
      required: input.required ?? false,
      quota: 4,
      timeoutMs: input.policy.timeoutMs,
      search: async ({ limit, signal }) => {
        if (signal.aborted) throw new DOMException('URL retrieval cancelled', 'AbortError')
        const startedAt = Date.now()
        const response = await this.gateway.fetchRemote(input.url, {
          ...input.policy,
          allowedDomains: input.policy.allowedDomains.filter((domain) => input.provider.allowedDomains.includes(domain))
        })
        const content = decodeBoundedText(response.body, response.mimeType, 24_000)
        logger.info('Approved URL retrieved for RPA Supplement', {
          providerId: input.provider.id,
          finalUrl: response.finalUrl,
          sizeBytes: response.sizeBytes,
          durationMs: Date.now() - startedAt
        })
        return content
          ? [
              createEvidence({
                id: `${input.id}:${stableHash(response.finalUrl)}`,
                providerId: input.provider.id,
                uri: response.finalUrl,
                content,
                timestamp: Date.now(),
                metadata: {
                  mimeType: response.mimeType,
                  redirectChain: response.redirectChain,
                  queryIndependent: true
                }
              })
            ].slice(0, limit)
          : []
      }
    }
  }
}

export function createRetrievalProviderSource(
  provider: RpaRetrievalProvider,
  options: { required?: boolean; scope?: string[]; quota?: number } = {}
): RpaFederatedRetrievalSource {
  if (provider.descriptor.kind !== 'retrieval') throw new Error('Provider is not a RetrievalProvider')
  return {
    id: provider.descriptor.id,
    type: 'remote_provider',
    required: options.required ?? provider.descriptor.required,
    quota: options.quota ?? 6,
    timeoutMs: 8_000,
    async search({ query, limit, signal }) {
      if (signal.aborted) throw new DOMException('Provider retrieval cancelled', 'AbortError')
      const health = await provider.health()
      if (health.status !== 'healthy' && health.status !== 'degraded') {
        throw new Error(health.message ?? `Provider is ${health.status}`)
      }
      return (await provider.search({ query, limit, scope: options.scope ?? [], timeoutMs: 8_000 })).map(
        (snippet, index) => ({
          id: `evidence-${provider.descriptor.id}-${stableHash(`${snippet.uri}:${snippet.contentHash}`)}`,
          sourceId: snippet.source,
          sourceType: 'remote_provider',
          owner: 'session',
          version: snippet.version,
          contentHash: snippet.contentHash || stableHash(snippet.content),
          content: snippet.content,
          localRank: index + 1,
          nativeScore: snippet.confidence,
          authority: 0.65,
          relevance: snippet.confidence,
          freshness: freshness(snippet.retrievedAt),
          extractionConfidence: 0.9,
          timestamp: snippet.retrievedAt,
          locator: snippet.uri,
          retrievalMetadata: { providerId: provider.descriptor.id, scope: snippet.scope },
          contributingSourceIds: [provider.descriptor.id]
        })
      )
    }
  }
}

export function createMcpResourceSource(input: {
  id: string
  provider: RpaProviderDescriptor
  uri: string
  required?: boolean
  read(uri: string, signal: AbortSignal): Promise<unknown>
}): RpaFederatedRetrievalSource {
  assertReadProvider(input.provider)
  return {
    id: input.id,
    type: 'mcp_resource',
    required: input.required ?? false,
    quota: 6,
    timeoutMs: 8_000,
    async search({ limit, signal }) {
      const raw = await input.read(input.uri, signal)
      return normalizeMcpResource(raw, input.uri, input.provider.id).slice(0, limit)
    }
  }
}

export class RpaAuthorizedToolAdapter {
  constructor(private readonly gateway = new RpaSecureProviderGateway()) {}

  async invoke(input: {
    provider: RpaToolProvider
    toolName: string
    parameters: unknown
    roleToolAllowlist: Record<string, string[]>
    sessionSelectedTools?: Record<string, string[]>
  }): Promise<unknown> {
    const roleAllowed = new Set(input.roleToolAllowlist[input.provider.descriptor.id] ?? [])
    const selected = input.sessionSelectedTools?.[input.provider.descriptor.id]
    if (!roleAllowed.has(input.toolName))
      throw new Error(`Tool is not authorized by the immutable Role: ${input.toolName}`)
    if (selected && !selected.includes(input.toolName)) {
      throw new Error(`Tool was narrowed out by the Session Supplement: ${input.toolName}`)
    }
    const output = await this.gateway.invokeTool(input.provider, input.toolName, input.parameters)
    return boundToolOutput(output)
  }
}

export async function fetchArtifactThroughProvider(input: {
  provider: RpaArtifactProvider
  uri: string
  required?: boolean
}): Promise<ReturnType<RpaArtifactProvider['fetch']>> {
  if (input.provider.descriptor.kind !== 'artifact') throw new Error('Provider is not an ArtifactProvider')
  const health = await input.provider.health()
  if (health.status !== 'healthy' && health.status !== 'degraded') {
    throw new Error(health.message ?? `Artifact Provider is ${health.status}`)
  }
  return input.provider.fetch({ uri: input.uri, timeoutMs: 8_000 })
}

function normalizeMcpResource(raw: unknown, fallbackUri: string, providerId: string): RpaPlanningEvidence[] {
  const contents = extractMcpContents(raw, fallbackUri)
  return contents.flatMap((content, index) => {
    const text = content.text ?? (content.blob ? `[Binary MCP content: ${content.mimeType ?? 'unknown'}]` : '')
    if (!text) return []
    const bounded = text.slice(0, 16_000)
    return [
      {
        id: `evidence-mcp-${stableHash(`${providerId}:${content.uri}:${index}:${bounded}`)}`,
        sourceId: content.uri,
        sourceType: 'mcp_resource',
        owner: 'session',
        contentHash: stableHash(bounded),
        content: bounded,
        localRank: index + 1,
        authority: 0.6,
        relevance: 0.5,
        freshness: 1,
        extractionConfidence: content.blob ? 0.2 : 0.9,
        timestamp: Date.now(),
        locator: content.uri,
        retrievalMetadata: {
          providerId,
          mimeType: content.mimeType,
          binaryReferenceOnly: Boolean(content.blob),
          truncated: text.length > bounded.length
        },
        contributingSourceIds: [providerId]
      }
    ]
  })
}

function extractMcpContents(raw: unknown, fallbackUri: string): RpaMcpResourceContent[] {
  const source =
    isRecord(raw) && Array.isArray(raw.contents)
      ? raw.contents
      : isRecord(raw) && Array.isArray(raw.content)
        ? raw.content
        : []
  return source.flatMap((candidate): RpaMcpResourceContent[] => {
    if (!isRecord(candidate)) return []
    const uri = cleanText(candidate.uri, 2_000) || fallbackUri
    return [
      {
        uri,
        name: cleanText(candidate.name, 256) || undefined,
        mimeType: cleanText(candidate.mimeType, 128) || undefined,
        text: cleanText(candidate.text, 64_000) || undefined,
        blob: typeof candidate.blob === 'string' && candidate.blob ? '[bounded-binary-reference]' : undefined
      }
    ]
  })
}

function createEvidence(input: {
  id: string
  providerId: string
  uri: string
  content: string
  timestamp: number
  metadata: Record<string, unknown>
}): RpaPlanningEvidence {
  return {
    id: `evidence-url-${stableHash(input.id)}`,
    sourceId: input.uri,
    sourceType: 'remote_provider',
    owner: 'session',
    contentHash: stableHash(input.content),
    content: input.content,
    localRank: 1,
    authority: 0.6,
    relevance: 0.5,
    freshness: 1,
    extractionConfidence: 0.9,
    timestamp: input.timestamp,
    locator: input.uri,
    retrievalMetadata: { providerId: input.providerId, ...input.metadata },
    contributingSourceIds: [input.providerId]
  }
}

function decodeBoundedText(body: Uint8Array, mimeType: string, maxChars: number): string {
  if (!/^(text\/|application\/(json|xml|yaml|x-yaml))/i.test(mimeType)) return `[Remote artifact: ${mimeType}]`
  return new TextDecoder('utf-8', { fatal: false })
    .decode(body)
    .split(String.fromCharCode(0))
    .join('')
    .slice(0, maxChars)
}

function boundToolOutput(output: unknown): unknown {
  if (output instanceof Uint8Array || output instanceof ArrayBuffer) {
    return {
      artifactRequired: true,
      sizeBytes: output.byteLength,
      summary: 'Binary tool output omitted from model context'
    }
  }
  const serialized = JSON.stringify(output)
  if (serialized.length <= 24_000) return output
  return {
    artifactRequired: true,
    sizeBytes: serialized.length,
    summary: serialized.slice(0, 4_000),
    truncated: true
  }
}

function assertReadProvider(provider: RpaProviderDescriptor): void {
  if (!['retrieval', 'artifact'].includes(provider.kind))
    throw new Error('A trusted workspace read Provider is required')
  if (provider.status !== 'healthy' && provider.status !== 'degraded') throw new Error(`Provider is ${provider.status}`)
}

function freshness(timestamp: number): number {
  const ageDays = Math.max(0, Date.now() - timestamp) / (24 * 60 * 60 * 1_000)
  return Math.max(0, 1 - ageDays / 365)
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const rpaApprovedUrlEvidenceAdapter = new RpaApprovedUrlEvidenceAdapter()
export const rpaAuthorizedToolAdapter = new RpaAuthorizedToolAdapter()
export const rpaSupplementProviderRuntimeRegistry = new RpaSupplementProviderRuntimeRegistry()
