import { describe, expect, it, vi } from 'vitest'

import type { RpaToolProvider } from '../RpaSecureProviderGateway'
import {
  createMcpResourceSource,
  RpaApprovedUrlEvidenceAdapter,
  RpaAuthorizedToolAdapter
} from '../RpaSupplementProviderAdapters'

describe('RpaSupplementProviderAdapters', () => {
  it('routes an approved URL through the secure gateway and returns bounded evidence', async () => {
    const gateway = {
      fetchRemote: vi.fn(async () => ({
        finalUrl: 'https://docs.example.com/guide',
        redirectChain: [],
        resolvedAddresses: ['203.0.113.1'],
        mimeType: 'text/plain',
        sizeBytes: 14,
        body: new TextEncoder().encode('Open Settings')
      }))
    }
    const adapter = new RpaApprovedUrlEvidenceAdapter(gateway as never)
    const source = adapter.createSource({
      id: 'url-1',
      url: 'https://docs.example.com/guide',
      provider: {
        id: 'docs',
        name: 'Docs',
        kind: 'retrieval',
        status: 'healthy',
        required: false,
        allowedDomains: ['docs.example.com']
      },
      policy: {
        allowedDomains: ['docs.example.com'],
        allowedMimeTypes: ['text/plain'],
        maxBytes: 10_000,
        maxRedirects: 2,
        timeoutMs: 1_000,
        requireTls: true
      }
    })

    const evidence = await source.search({ query: 'settings', limit: 2, signal: new AbortController().signal })

    expect(gateway.fetchRemote).toHaveBeenCalledOnce()
    expect(evidence[0]).toMatchObject({ content: 'Open Settings', sourceType: 'remote_provider' })
  })

  it('normalizes MCP Resources as bounded read-only evidence', async () => {
    const source = createMcpResourceSource({
      id: 'mcp-doc',
      uri: 'mcp://docs/guide',
      provider: {
        id: 'mcp-docs',
        name: 'MCP Docs',
        kind: 'artifact',
        status: 'healthy',
        required: false,
        allowedDomains: []
      },
      read: async () => ({ contents: [{ uri: 'mcp://docs/guide', mimeType: 'text/plain', text: 'Tap About phone' }] })
    })

    const evidence = await source.search({ query: 'about', limit: 2, signal: new AbortController().signal })

    expect(evidence[0]).toMatchObject({ sourceType: 'mcp_resource', content: 'Tap About phone' })
  })

  it('blocks tools outside the immutable Role allowlist before gateway invocation', async () => {
    const gateway = { invokeTool: vi.fn(async () => ({ ok: true })) }
    const adapter = new RpaAuthorizedToolAdapter(gateway as never)
    const provider = {
      descriptor: {
        id: 'device-tools',
        name: 'Device tools',
        kind: 'tool',
        status: 'healthy',
        required: false,
        allowedDomains: []
      }
    } as unknown as RpaToolProvider

    await expect(
      adapter.invoke({ provider, toolName: 'shell', parameters: {}, roleToolAllowlist: { 'device-tools': ['tap'] } })
    ).rejects.toThrow('immutable Role')
    expect(gateway.invokeTool).not.toHaveBeenCalled()
  })
})
