import { loggerService } from '@logger'
import type { MCPResource, MCPServer } from '@renderer/types'

import type { RpaProviderDescriptor, RpaProviderHealth } from './RpaSecureProviderGateway'
import {
  type RpaMcpResourceProviderRuntime,
  type RpaSupplementProviderRuntimeRegistry,
  rpaSupplementProviderRuntimeRegistry
} from './RpaSupplementProviderAdapters'

const logger = loggerService.withContext('RpaMcpSupplementProviderBridge')
const DEFAULT_TIMEOUT_MS = 8_000

interface ProviderEntry {
  server: MCPServer
  descriptor: RpaProviderDescriptor
  resources: MCPResource[]
  dispose: () => void
  health: RpaProviderHealth
}

export interface RpaMcpProviderCatalogItem {
  id: string
  name: string
  description?: string
  status: RpaProviderDescriptor['status']
  resourceCount: number
}

export class RpaMcpSupplementProviderBridge {
  private readonly entries = new Map<string, ProviderEntry>()
  private syncRevision = 0

  constructor(
    private readonly registry: RpaSupplementProviderRuntimeRegistry = rpaSupplementProviderRuntimeRegistry,
    private readonly api?: Pick<Window['api']['mcp'], 'checkMcpConnectivity' | 'listResources' | 'getResource'>
  ) {}

  async synchronize(servers: MCPServer[]): Promise<void> {
    const revision = ++this.syncRevision
    const trustedServers = servers.filter((server) => server.isTrusted === true)
    const desiredIds = new Set(trustedServers.map(providerIdForServer))

    for (const [providerId, entry] of this.entries) {
      if (!desiredIds.has(providerId)) {
        entry.dispose()
        this.entries.delete(providerId)
      }
    }

    await Promise.all(trustedServers.map((server) => this.synchronizeServer(server, revision)))
  }

  listCatalog(): RpaMcpProviderCatalogItem[] {
    return [...this.entries.values()]
      .map((entry) => ({
        id: entry.descriptor.id,
        name: entry.descriptor.name,
        description: entry.server.description,
        status: entry.descriptor.status,
        resourceCount: entry.resources.length
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  listResources(providerId: string): MCPResource[] {
    return [...(this.entries.get(providerId)?.resources ?? [])]
  }

  private async synchronizeServer(server: MCPServer, revision: number): Promise<void> {
    let status: RpaProviderDescriptor['status'] = server.isActive ? 'degraded' : 'disabled'
    let resources: MCPResource[] = []
    let healthMessage = server.isActive ? 'MCP Provider health check is pending' : 'MCP server is disabled'

    if (server.isActive) {
      try {
        const timeoutMs = serverTimeoutMs(server)
        const api = this.getApi()
        const connected = await withTimeout(
          api.checkMcpConnectivity(server),
          timeoutMs,
          `MCP connectivity check timed out: ${server.name}`
        )
        if (!connected) throw new Error(`MCP connectivity check failed: ${server.name}`)
        resources = await withTimeout(
          api.listResources(server),
          timeoutMs,
          `MCP resource discovery timed out: ${server.name}`
        )
        status = resources.length ? 'healthy' : 'degraded'
        healthMessage = resources.length
          ? `${resources.length} MCP Resource(s) available`
          : 'No MCP Resources available'
      } catch (error) {
        status = 'needs_configuration'
        healthMessage = error instanceof Error ? error.message : String(error)
        logger.warn('Failed to synchronize MCP Supplemental Provider', { serverId: server.id, error })
      }
    }

    if (revision !== this.syncRevision) return
    this.installEntry(server, resources, status, healthMessage)
  }

  private installEntry(
    server: MCPServer,
    resources: MCPResource[],
    status: RpaProviderDescriptor['status'],
    healthMessage: string
  ): void {
    const providerId = providerIdForServer(server)
    const descriptor: RpaProviderDescriptor = {
      id: providerId,
      name: server.name,
      kind: 'artifact',
      status,
      required: false,
      allowedDomains: []
    }
    const health: RpaProviderHealth = { status, message: healthMessage, checkedAt: Date.now() }
    const runtime: RpaMcpResourceProviderRuntime = {
      descriptor,
      read: (uri, signal) => this.readResource(providerId, uri, signal)
    }
    const previous = this.entries.get(providerId)
    const dispose = this.registry.registerMcpResource(runtime)
    this.entries.set(providerId, { server: { ...server }, descriptor, resources: [...resources], dispose, health })
    previous?.dispose()
  }

  private async readResource(providerId: string, uri: string, signal: AbortSignal): Promise<unknown> {
    const entry = this.entries.get(providerId)
    if (!entry) throw new Error(`MCP Provider runtime is unavailable: ${providerId}`)
    if (!entry.server.isActive || entry.descriptor.status === 'disabled') {
      throw new Error(`MCP Provider is disabled: ${providerId}`)
    }
    if (!['healthy', 'degraded'].includes(entry.descriptor.status)) {
      throw new Error(entry.health.message ?? `MCP Provider is unavailable: ${providerId}`)
    }
    if (!entry.resources.some((resource) => resource.uri === uri)) {
      throw new Error(`MCP Resource is not exposed by the authorized Provider: ${uri}`)
    }
    if (signal.aborted) throw new DOMException('MCP Resource read cancelled', 'AbortError')

    return raceWithSignal(
      withTimeout(
        this.getApi().getResource({ server: entry.server, uri }),
        serverTimeoutMs(entry.server),
        `MCP Resource read timed out: ${uri}`
      ),
      signal
    )
  }

  private getApi(): Pick<Window['api']['mcp'], 'checkMcpConnectivity' | 'listResources' | 'getResource'> {
    return this.api ?? window.api.mcp
  }
}

export function providerIdForServer(server: Pick<MCPServer, 'id'>): string {
  return `mcp:${server.id}`
}

function serverTimeoutMs(server: MCPServer): number {
  return Math.max(1_000, Math.min((server.timeout ?? DEFAULT_TIMEOUT_MS / 1_000) * 1_000, 60_000))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('MCP Resource read cancelled', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export const rpaMcpSupplementProviderBridge = new RpaMcpSupplementProviderBridge()
