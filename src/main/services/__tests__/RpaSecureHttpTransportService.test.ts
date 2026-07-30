import dns from 'node:dns/promises'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { RpaSecureHttpTransportService } from '../RpaSecureHttpTransportService'

afterEach(() => vi.restoreAllMocks())

const request = {
  url: 'https://example.com/data',
  timeoutMs: 1_000,
  maxBytes: 100,
  allowedMimeTypes: ['application/json'],
  allowedDomains: ['example.com'],
  maxRedirects: 1,
  requireTls: true
}

describe('RpaSecureHttpTransportService', () => {
  it('rejects DNS results that resolve to a private address before fetch', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(new RpaSecureHttpTransportService().fetch(request)).rejects.toThrow('Private network')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('enforces MIME and bounded bodies after public DNS resolution', async () => {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    )

    const response = await new RpaSecureHttpTransportService().fetch(request)

    expect(response.mimeType).toBe('application/json')
    expect(response.resolvedAddresses).toEqual(['93.184.216.34'])
  })
})
