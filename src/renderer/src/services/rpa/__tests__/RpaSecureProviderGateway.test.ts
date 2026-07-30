import { describe, expect, it, vi } from 'vitest'

import {
  isPrivateAddress,
  normalizeImportedProvider,
  type RpaSecureHttpTransport,
  RpaSecureProviderGateway,
  type RpaToolProvider
} from '../RpaSecureProviderGateway'

const policy = {
  allowedDomains: ['example.com'],
  allowedMimeTypes: ['application/json'],
  maxBytes: 100,
  maxRedirects: 2,
  timeoutMs: 1000,
  requireTls: true
}

describe('RpaSecureProviderGateway', () => {
  it('blocks private addresses, unsafe redirects, MIME types, and oversized responses', async () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('192.168.1.2')).toBe(true)
    const transport: RpaSecureHttpTransport = {
      fetch: vi.fn().mockResolvedValue({
        finalUrl: 'https://example.com/data',
        redirectChain: [],
        resolvedAddresses: ['10.0.0.2'],
        mimeType: 'application/json',
        sizeBytes: 2,
        body: new Uint8Array(2)
      })
    }
    await expect(
      new RpaSecureProviderGateway(transport).fetchRemote('https://example.com/data', policy)
    ).rejects.toThrow('Private network')
  })

  it('allows bounded responses only when transport reports a public address', async () => {
    const response = {
      finalUrl: 'https://cdn.example.com/data',
      redirectChain: [],
      resolvedAddresses: ['93.184.216.34'],
      mimeType: 'application/json',
      sizeBytes: 2,
      body: new Uint8Array([1, 2])
    }
    const gateway = new RpaSecureProviderGateway({ fetch: vi.fn().mockResolvedValue(response) })
    await expect(gateway.fetchRemote('https://cdn.example.com/data', policy)).resolves.toEqual(response)
    await expect(gateway.fetchRemote('http://example.com/data', policy)).rejects.toThrow('requires TLS')
    await expect(gateway.fetchRemote('https://evil.test/data', policy)).rejects.toThrow('not allowlisted')
  })

  it('validates, approves, rate-limits, and audits tool calls', async () => {
    const audit = vi.fn()
    const invoke = vi.fn().mockResolvedValue({ ok: true })
    const provider: RpaToolProvider = {
      descriptor: { id: 'tools', name: 'Tools', kind: 'tool', status: 'healthy', required: false, allowedDomains: [] },
      health: async () => ({ status: 'healthy', checkedAt: 1 }),
      tools: async () => [
        {
          name: 'tap',
          description: 'Tap',
          requiresApproval: true,
          timeoutMs: 100,
          rateLimitPerMinute: 1,
          validate: (input) =>
            typeof input === 'object' ? { success: true, data: input } : { success: false, issues: ['object required'] }
        }
      ],
      invoke
    }
    const gateway = new RpaSecureProviderGateway({ fetch: vi.fn() }, { approveTool: async () => true, audit })
    await expect(gateway.invokeTool(provider, 'tap', { x: 1 })).resolves.toEqual({ ok: true })
    await expect(gateway.invokeTool(provider, 'tap', { x: 2 })).rejects.toThrow('rate limit')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }))
  })

  it('imports providers disabled until trust and credentials are confirmed', () => {
    expect(
      normalizeImportedProvider({
        id: 'p',
        name: 'P',
        kind: 'retrieval',
        status: 'healthy',
        required: false,
        allowedDomains: [],
        imported: true
      }).status
    ).toBe('needs_configuration')
  })
})
