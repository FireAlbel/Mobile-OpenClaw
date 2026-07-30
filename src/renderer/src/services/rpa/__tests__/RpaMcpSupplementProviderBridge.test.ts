import type { MCPServer } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

import { providerIdForServer, RpaMcpSupplementProviderBridge } from '../RpaMcpSupplementProviderBridge'
import { RpaSupplementProviderRuntimeRegistry } from '../RpaSupplementProviderAdapters'

function server(patch: Partial<MCPServer> = {}): MCPServer {
  return {
    id: 'docs',
    name: 'Task guidance',
    isActive: true,
    isTrusted: true,
    ...patch
  }
}

describe('RpaMcpSupplementProviderBridge', () => {
  it('registers trusted MCP Resources and restricts reads to discovered URIs', async () => {
    const registry = new RpaSupplementProviderRuntimeRegistry()
    const api = {
      checkMcpConnectivity: vi.fn().mockResolvedValue(true),
      listResources: vi
        .fn()
        .mockResolvedValue([
          { serverId: 'docs', serverName: 'Task guidance', uri: 'mcp://docs/about', name: 'About phone SOP' }
        ]),
      getResource: vi.fn().mockResolvedValue({
        contents: [{ uri: 'mcp://docs/about', mimeType: 'text/plain', text: 'Open Settings and tap About phone' }]
      })
    }
    const bridge = new RpaMcpSupplementProviderBridge(registry, api as never)

    await bridge.synchronize([server()])

    const providerId = providerIdForServer(server())
    const runtime = registry.getMcpResource(providerId)
    expect(runtime?.descriptor).toMatchObject({ status: 'healthy', kind: 'artifact' })
    expect(bridge.listResources(providerId)).toHaveLength(1)
    await expect(runtime?.read('mcp://docs/about', new AbortController().signal)).resolves.toMatchObject({
      contents: [{ text: 'Open Settings and tap About phone' }]
    })
    await expect(runtime?.read('mcp://docs/forged', new AbortController().signal)).rejects.toThrow(
      'not exposed by the authorized Provider'
    )
  })

  it('excludes untrusted servers and marks trusted inactive servers disabled', async () => {
    const registry = new RpaSupplementProviderRuntimeRegistry()
    const api = {
      checkMcpConnectivity: vi.fn(),
      listResources: vi.fn(),
      getResource: vi.fn()
    }
    const bridge = new RpaMcpSupplementProviderBridge(registry, api as never)

    await bridge.synchronize([
      server({ id: 'untrusted', isTrusted: false }),
      server({ id: 'inactive', isActive: false })
    ])

    expect(registry.getMcpResource('mcp:untrusted')).toBeUndefined()
    expect(registry.getMcpResource('mcp:inactive')?.descriptor.status).toBe('disabled')
    expect(api.checkMcpConnectivity).not.toHaveBeenCalled()
  })

  it('publishes unavailable health when connectivity fails', async () => {
    const registry = new RpaSupplementProviderRuntimeRegistry()
    const bridge = new RpaMcpSupplementProviderBridge(registry, {
      checkMcpConnectivity: vi.fn().mockRejectedValue(new Error('offline')),
      listResources: vi.fn(),
      getResource: vi.fn()
    } as never)

    await bridge.synchronize([server()])

    expect(registry.getMcpResource('mcp:docs')?.descriptor.status).toBe('needs_configuration')
  })
})
